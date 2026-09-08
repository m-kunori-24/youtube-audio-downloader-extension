// agent.mjs
// page-agent(MAIN world)の本体。SW→page契約のcfgを受け取り、
//   認証(SAPISIDHASH) → /youtubei/v1/player → 音声フォーマット選択 →
//   プレイヤーJS候補の順次試行(nsig抽出・妥当性検証・最初のSABR POSTによる検証) →
//   SABRダウンロードと分割送出
// を行う。すべての報告(status/begin/data/end/abort/result)はHMAC署名付きフレームとして
// window.postMessageでリレーへ送る(finding 1)。これが唯一の結果送達経路であり、
// 戻り値をSWが読むことはない(executeScript戻り値経路は廃止)。
// リレーからは署名付きのackフレームを受け取り、背圧ゲート(finding 4)へ反映する。

import { computeSapisidHash, readSapisidCookie } from "./sapisid.mjs";
import { clientNameToId, ERROR_CODES, fetchPlayerResponse, makeError, mapPlayabilityStatus } from "./player-response.mjs";
import { selectAudioFormat } from "./format-selection.mjs";
import { createNsigTransform, isValidNsigOutput } from "./nsig.mjs";
import {
  buildCandidateList,
  fetchIframeApiBuildHash,
  readPagePlayerJsUrl,
} from "./player-js-candidates.mjs";
import { FIRST_REQUEST_OUTCOME } from "./first-request-classifier.mjs";
import { createCapacityGate, createSegmentEmitter } from "./segment-emitter.mjs";
import { createStatusReporter } from "./status-reporter.mjs";
import { runSabrAttempt } from "./sabr-download.mjs";
import { ABORT_REASONS } from "../shared/abort-reasons.mjs";
import { importFrameKey, isNonNegativeInteger, signFrame, verifyFrame } from "../shared/frame-auth.mjs";

export const DEFAULT_STALL_TIMEOUT_MS = 60000;
export const DEFAULT_MAX_DURATION_MS = 3600000;
// NETWORK_UNREACHABLE時に同一候補を再試行するまでの待機(ms)。0.5秒→1.5秒の2回。
const NETWORK_RETRY_DELAYS_MS = [500, 1500];

/**
 * INNERTUBE_CONTEXT.clientからSABR StreamerContext.ClientInfoを組み立てる。
 * @param {object} context ytcfg INNERTUBE_CONTEXT
 * @returns {object} ClientInfo(googlevideo protobuf形)
 */
export function buildClientInfo(context) {
  const client = context && typeof context.client === "object" && context.client !== null ? context.client : {};
  /** @type {Record<string, unknown>} */
  const clientInfo = { clientName: clientNameToId(client.clientName), clientFormFactor: 0 };
  const stringFields = ["clientVersion", "osName", "osVersion", "deviceMake", "deviceModel", "timeZone"];
  for (const field of stringFields) {
    if (typeof client[field] === "string" && client[field].length > 0) {
      clientInfo[field] = client[field];
    }
  }
  const numberFields = ["screenWidthPoints", "screenHeightPoints", "screenPixelDensity", "screenDensityFloat"];
  for (const field of numberFields) {
    if (typeof client[field] === "number") {
      clientInfo[field] = client[field];
    }
  }
  if (typeof client.utcOffsetMinutes === "number") {
    clientInfo.utcOffsetMinutes = String(client.utcOffsetMinutes);
  }
  if (typeof client.hl === "string") {
    clientInfo.acceptLanguage = client.hl;
  }
  if (typeof client.gl === "string") {
    clientInfo.acceptRegion = client.gl;
  }
  return clientInfo;
}

/**
 * 候補のプレイヤーJSを取得し、n変換関数を作って実際のnへ適用する。
 * fetchはredirect:"error"でリダイレクトを即座に拒否する(finding 3、汚染された候補URLからの
 * 転送で意図しないJSを取得・eval実行することを防ぐ多層目)。失敗は取得段階(stage: "fetch")と
 * nsig抽出段階(stage: "extract")を区別して返す(finding 13a、呼び出し元がエラーコードの
 * 精度に使う)。
 * @param {{url: string}} candidate 候補
 * @param {string} n serverAbrStreamingUrlのnパラメータ
 * @param {{fetch: typeof fetch, evalScript: (code: string) => unknown}} deps 依存
 * @returns {Promise<{ok: true, transformed: string} |
 *   {ok: false, stage: "fetch"|"extract", reason: string}>} 変換結果
 */
async function transformWithCandidate(candidate, n, deps) {
  let source;
  try {
    const response = await deps.fetch(candidate.url, { credentials: "omit", redirect: "error" });
    if (!response.ok) {
      return { ok: false, stage: "fetch", reason: `player JS HTTP ${response.status}` };
    }
    source = await response.text();
  } catch (error) {
    return { ok: false, stage: "fetch", reason: `player JS fetch failed: ${error && error.message ? error.message : "unknown"}` };
  }
  let transformed;
  try {
    const transform = createNsigTransform(source, deps.evalScript);
    transformed = transform(n);
  } catch (error) {
    return { ok: false, stage: "extract", reason: `nsig extraction failed: ${error && error.message ? error.message : "unknown"}` };
  }
  if (!isValidNsigOutput(n, transformed)) {
    return { ok: false, stage: "extract", reason: "nsig output failed validity heuristic" };
  }
  return { ok: true, transformed };
}

/**
 * 全候補が失敗した際の最終エラーコードを決める。優先順:
 *   1. 署名拒否(SIGNATURE_REJECTED)が1件でもあれば NSIG_REJECTED_BY_SERVER
 *   2. 次にNETWORK_UNREACHABLEが1件でもあれば NETWORK_UNREACHABLE
 *   3. 次に取得は成功したが抽出に失敗した候補(EXTRACT_FAILED)が1件でもあれば
 *      EXTRACT_NSIG_FAILED(finding 13a、fetch失敗と抽出失敗を区別する)
 *   4. どの候補も取得(fetch)自体に失敗したなら PLAYER_JS_UNAVAILABLE
 * @param {Array<{outcome: string}>} tried 試行履歴
 * @returns {string} エラーコード
 */
export function resolveExhaustedCode(tried) {
  if (tried.some((entry) => entry.outcome === FIRST_REQUEST_OUTCOME.SIGNATURE_REJECTED)) {
    return ERROR_CODES.NSIG_REJECTED_BY_SERVER;
  }
  if (tried.some((entry) => entry.outcome === FIRST_REQUEST_OUTCOME.NETWORK_UNREACHABLE)) {
    return ERROR_CODES.NETWORK_UNREACHABLE;
  }
  if (tried.some((entry) => entry.outcome === "EXTRACT_FAILED")) {
    return ERROR_CODES.EXTRACT_NSIG_FAILED;
  }
  return ERROR_CODES.PLAYER_JS_UNAVAILABLE;
}

/**
 * 依存注入したsetTimeoutで待機する。
 * @param {number} ms 待機時間
 * @param {typeof setTimeout} setTimeoutFn タイマー関数
 * @returns {Promise<void>} 待機完了
 */
function delay(ms, setTimeoutFn) {
  return new Promise((resolve) => setTimeoutFn(resolve, ms));
}

/**
 * page-agentを実行する。結果は署名付きresultフレームとしてリレーへ送るのみで、戻り値は持たない。
 * @param {{taskId: string, secret: string, videoId: string, itag?: number|null, qualityTier?: string,
 *   playerJs?: {knownGoodUrl?: string|null, excluded?: Array<{buildHash: string, variant: string}>},
 *   stallTimeoutMs?: number, maxDurationMs?: number}} cfg SW→page契約。secretはフレーム署名鍵(hex)
 * @param {{fetch: typeof fetch, document: Document, window: Window, origin: string,
 *   ytcfgGet: (key: string) => unknown, subtle: SubtleCrypto, postMessage: (message: object) => void,
 *   now: () => number, setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout,
 *   evalScript: (code: string) => unknown}} deps ページ/ブラウザ依存
 * @returns {Promise<void>} 全フレームの送出完了
 */
export async function runAgent(cfg, deps) {
  const taskId = cfg.taskId;
  let frameKey; // CryptoKey
  try {
    frameKey = await importFrameKey(deps.subtle, cfg.secret);
  } catch (error) {
    // 署名鍵が無ければ何を送ってもリレーに捨てられるため、黙って終了する(fail-closed)。
    return;
  }
  const startedAt = deps.now();
  const stallTimeoutMs = typeof cfg.stallTimeoutMs === "number" ? cfg.stallTimeoutMs : DEFAULT_STALL_TIMEOUT_MS;
  // cfg.maxDurationMs(既定DEFAULT_MAX_DURATION_MS)は絶対期限そのものではなく下限(finding 5)。
  // videoDetails.lengthSeconds判明後、execute()内でdeadlineAtをmax(下限, 動画長)へ引き上げる。
  // 60秒無進捗ウォッチドッグ(stallTimeoutMs)とは無関係・独立。
  const maxDurationFloorMs = typeof cfg.maxDurationMs === "number" ? cfg.maxDurationMs : DEFAULT_MAX_DURATION_MS;
  let deadlineAt = startedAt + maxDurationFloorMs;
  const playerJsCfg = cfg.playerJs && typeof cfg.playerJs === "object" ? cfg.playerJs : {};

  let outCounter = 0; // number。agent→relay方向のフレーム連番(n)
  let postChain = Promise.resolve(); // 署名が非同期のため、送出順を保つ直列化チェーン
  let inCounter = 0; // number。relay→agent方向で次に受理すべきn
  let inChain = Promise.resolve(); // 受信ackの検証を到着順に直列化するチェーン
  let currentGate = null; // {epoch: number, gate: object} | null。実行中試行の背圧ゲート

  /**
   * フレームにns/v/taskId/nを付け、署名してからリレーへ送る。送出順はチェーンで保証する。
   * @param {object} message {type,...}
   * @returns {void}
   */
  function post(message) {
    const frame = { ns: "yta", v: 1, taskId, ...message, n: outCounter };
    outCounter += 1;
    postChain = postChain
      .then(async () => {
        const payload = frame.type === "data" && frame.bytes instanceof ArrayBuffer ? new Uint8Array(frame.bytes) : undefined;
        frame.mac = await signFrame(deps.subtle, frameKey, frame, payload);
        deps.postMessage(frame);
      })
      .catch(() => {});
  }

  /**
   * リレーからのackフレームを受け取る。同期区間でsource/origin/ns/v/taskId/typeを検査し
   * 値を複製してから、非同期に連番・形状・MACを検証して背圧ゲートへ反映する。
   * @param {MessageEvent} event windowのmessageイベント
   * @returns {void}
   */
  function onWindowMessage(event) {
    if (event.source !== deps.window || event.origin !== deps.origin) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== "object" || data.ns !== "yta" || data.v !== 1 || data.taskId !== taskId || data.type !== "ack") {
      return;
    }
    const frame = { ns: "yta", v: 1, taskId, type: "ack", epoch: data.epoch, offset: data.offset, n: data.n };
    const mac = data.mac;
    inChain = inChain
      .then(async () => {
        if (frame.n !== inCounter) {
          return;
        }
        if (!isNonNegativeInteger(frame.epoch) || !isNonNegativeInteger(frame.offset)) {
          return;
        }
        if (!(await verifyFrame(deps.subtle, frameKey, frame, undefined, mac))) {
          return;
        }
        inCounter += 1;
        if (currentGate !== null && currentGate.epoch === frame.epoch) {
          currentGate.gate.ack(frame.offset);
        }
      })
      .catch(() => {});
  }

  const status = createStatusReporter({ post, now: deps.now });
  /** @type {Array<{url: string, buildHash: string, variant: string, source: string, outcome: string, reason?: string}>} */
  const tried = [];
  /** @type {Array<{url: string, buildHash: string, variant: string}>} */
  const rejectedCandidates = [];

  deps.window.addEventListener("message", onWindowMessage);
  try {
    let result;
    try {
      result = await execute();
    } catch (error) {
      const code = error && typeof error.code === "string" ? error.code : ERROR_CODES.SABR_SERVER_ERROR;
      const reason = error && typeof error.reason === "string" ? error.reason : error && error.message ? error.message : "unknown";
      result = { ok: false, code, detail: { reason, tried }, rejectedCandidates };
    }
    post({ type: "result", result });
    await postChain;
  } finally {
    deps.window.removeEventListener("message", onWindowMessage);
  }

  /**
   * 本処理。失敗はcode付きErrorをthrowし、呼び出し元で結果オブジェクトへ変換する。
   * @returns {Promise<object>} 成功結果
   */
  async function execute() {
    status.report({ phase: "player" });
    const sapisid = readSapisidCookie(deps.document.cookie);
    if (sapisid === null) {
      throw makeError(ERROR_CODES.AUTH_NOT_LOGGED_IN, "SAPISID cookie not found");
    }
    const authorization = await computeSapisidHash({
      sapisid,
      timestampSeconds: Math.floor(deps.now() / 1000),
      origin: deps.origin,
      subtle: deps.subtle,
    });
    const context = deps.ytcfgGet("INNERTUBE_CONTEXT");
    if (!context || typeof context !== "object") {
      throw makeError(ERROR_CODES.PLAYER_REQUEST_FAILED, "INNERTUBE_CONTEXT unavailable");
    }
    const sessionIndex = deps.ytcfgGet("SESSION_INDEX");
    const playerResponse = await fetchPlayerResponse({
      fetchFn: deps.fetch,
      videoId: cfg.videoId,
      context,
      authorization,
      sessionIndex: typeof sessionIndex === "string" ? sessionIndex : "0",
      origin: deps.origin,
    });
    const playability = mapPlayabilityStatus(playerResponse);
    if (playability !== null) {
      throw makeError(playability.code, playability.reason);
    }
    const streamingData = playerResponse.streamingData;
    const audioFormat = selectAudioFormat(streamingData.adaptiveFormats, cfg.itag);
    if (audioFormat === null) {
      throw makeError(ERROR_CODES.VIDEO_NO_AUDIO_FORMAT, "no eligible audio-only format");
    }
    const streamingUrl = streamingData.serverAbrStreamingUrl;
    if (typeof streamingUrl !== "string" || streamingUrl.length === 0) {
      throw makeError(ERROR_CODES.VIDEO_UNPLAYABLE, "serverAbrStreamingUrl missing");
    }
    const ustreamerConfig =
      playerResponse.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
    if (typeof ustreamerConfig !== "string" || ustreamerConfig.length === 0) {
      throw makeError(ERROR_CODES.VIDEO_UNPLAYABLE, "videoPlaybackUstreamerConfig missing");
    }
    const clientInfo = buildClientInfo(context);
    const n = new URL(streamingUrl).searchParams.get("n");
    // SW側のファイル名生成(sanitize(title))と表示に使うため、成功結果へ載せる。
    const videoDetails =
      playerResponse.videoDetails && typeof playerResponse.videoDetails === "object"
        ? playerResponse.videoDetails
        : {};
    const parsedLengthSeconds = Number.parseInt(videoDetails.lengthSeconds, 10);
    // finding 5: 動画長が判明していれば、下限(maxDurationFloorMs)と動画長(1x実時間)の
    // 大きい方を絶対期限にする。約8倍速のSABR取得実績に対し1x実時間は十分な余裕を持つ。
    // 未判明・0以下(ライブ配信等、スコープ外)なら下限のみを使う。
    const parsedLengthMs =
      Number.isFinite(parsedLengthSeconds) && parsedLengthSeconds > 0 ? parsedLengthSeconds * 1000 : 0;
    deadlineAt = startedAt + Math.max(maxDurationFloorMs, parsedLengthMs);

    let epoch = 0; // number。SABR試行ごとに加算する世代番号
    let lastAttempt = null; // 直近の試行結果

    /**
     * 指定URLでSABR試行を1回行う。beginを送出済みのまま失敗した場合は、呼び出し元が
     * 次の試行の有無を決めてからabortEpoch()でabortメッセージを送る。
     * @param {string} url n変換適用済みURL
     * @returns {Promise<object>} runSabrAttemptの結果に{epoch, began}を加えたもの
     */
    async function attempt(url) {
      const attemptEpoch = epoch;
      epoch += 1;
      const emitter = createSegmentEmitter({ post, epoch: attemptEpoch });
      const gate = createCapacityGate({ emittedOffset: () => emitter.emittedOffset() });
      currentGate = { epoch: attemptEpoch, gate };
      let attemptResult;
      try {
        attemptResult = await runSabrAttempt({
          fetchFn: deps.fetch,
          streamingUrl: url,
          playerResponse,
          clientInfo,
          audioFormat,
          emitter,
          capacityGate: gate,
          onProgress: (bytes, totalBytes) => {
            status.report({ phase: "download", bytes, totalBytes });
          },
          stallTimeoutMs,
          deadlineAt,
          now: deps.now,
          setTimeoutFn: deps.setTimeout,
          clearTimeoutFn: deps.clearTimeout,
        });
      } finally {
        currentGate = null;
        gate.close();
      }
      return { ...attemptResult, epoch: attemptEpoch, began: emitter.began() };
    }

    /**
     * beginを送出済みの試行が失敗した場合にabortメッセージを送る。未送出なら何もしない。
     * @param {{epoch: number, began: boolean, code: string}} attemptResult 失敗した試行結果
     * @param {string} reason ABORT_REASONS.RESTART(次の試行が続く)またはABORT_REASONS.ERROR(終了)
     * @returns {void}
     */
    function abortEpoch(attemptResult, reason) {
      if (!attemptResult.began) {
        return;
      }
      post({ type: "abort", epoch: attemptResult.epoch, reason, code: attemptResult.code });
    }

    /**
     * 成功結果を組み立てる。
     * @param {object} attemptResult 成功した試行結果
     * @param {{url: string, buildHash: string, variant: string}|null} candidate 採用候補
     * @returns {object} 結果オブジェクト
     */
    function success(attemptResult, candidate) {
      return {
        ok: true,
        byteLength: attemptResult.byteLength,
        mimeType: audioFormat.mimeType,
        itag: audioFormat.itag,
        title: typeof videoDetails.title === "string" ? videoDetails.title : null,
        lengthSeconds: Number.isFinite(parsedLengthSeconds) ? parsedLengthSeconds : null,
        acceptedCandidate: candidate
          ? { url: candidate.url, buildHash: candidate.buildHash, variant: candidate.variant }
          : null,
        rejectedCandidates,
      };
    }

    if (n === null) {
      // nパラメータが無ければ変換対象が無いので、候補探索を行わず1回だけ試行する。
      lastAttempt = await attempt(streamingUrl);
      if (lastAttempt.ok) {
        return success(lastAttempt, null);
      }
      abortEpoch(lastAttempt, ABORT_REASONS.ERROR);
      throw makeError(lastAttempt.code, lastAttempt.reason);
    }

    const pagePlayerJsUrl = readPagePlayerJsUrl({ ytcfgGet: deps.ytcfgGet, document: deps.document });
    const iframeApiBuildHash = await fetchIframeApiBuildHash(deps.fetch, deps.origin);
    const candidates = buildCandidateList({
      knownGoodUrl: typeof playerJsCfg.knownGoodUrl === "string" ? playerJsCfg.knownGoodUrl : null,
      excluded: Array.isArray(playerJsCfg.excluded) ? playerJsCfg.excluded : [],
      pagePlayerJsUrl,
      iframeApiBuildHash,
      origin: deps.origin,
    });
    if (candidates.length === 0) {
      throw makeError(ERROR_CODES.PLAYER_JS_UNAVAILABLE, "no player JS candidates");
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const isLastCandidate = index === candidates.length - 1;
      status.report({ phase: "player-js", attempt: index + 1, total: candidates.length, buildHash: candidate.buildHash });
      const transformed = await transformWithCandidate(candidate, n, deps);
      if (!transformed.ok) {
        // stage: "fetch"はFETCH_FAILED(候補の取得自体が失敗)、"extract"はEXTRACT_FAILED
        // (取得は成功したが抽出に失敗、finding 13a)として履歴へ記録する。
        tried.push({
          ...candidate,
          outcome: transformed.stage === "extract" ? "EXTRACT_FAILED" : "FETCH_FAILED",
          reason: transformed.reason,
        });
        continue;
      }
      const url = new URL(streamingUrl);
      url.searchParams.set("n", transformed.transformed);

      let networkRetryIndex = 0; // number。NETWORK_RETRY_DELAYS_MSの消費位置
      while (true) {
        lastAttempt = await attempt(url.toString());
        if (lastAttempt.ok) {
          tried.push({ ...candidate, outcome: "ACCEPTED" });
          return success(lastAttempt, candidate);
        }
        if (lastAttempt.outcome === FIRST_REQUEST_OUTCOME.SIGNATURE_REJECTED) {
          // 同一候補の再試行は0回。次候補があればrestart、無ければerror。
          abortEpoch(lastAttempt, isLastCandidate ? ABORT_REASONS.ERROR : ABORT_REASONS.RESTART);
          rejectedCandidates.push({ url: candidate.url, buildHash: candidate.buildHash, variant: candidate.variant });
          tried.push({ ...candidate, outcome: FIRST_REQUEST_OUTCOME.SIGNATURE_REJECTED });
          break;
        }
        if (lastAttempt.outcome === FIRST_REQUEST_OUTCOME.NETWORK_UNREACHABLE) {
          if (networkRetryIndex < NETWORK_RETRY_DELAYS_MS.length) {
            abortEpoch(lastAttempt, ABORT_REASONS.RESTART);
            await delay(NETWORK_RETRY_DELAYS_MS[networkRetryIndex], deps.setTimeout);
            networkRetryIndex += 1;
            continue;
          }
          abortEpoch(lastAttempt, isLastCandidate ? ABORT_REASONS.ERROR : ABORT_REASONS.RESTART);
          tried.push({ ...candidate, outcome: FIRST_REQUEST_OUTCOME.NETWORK_UNREACHABLE });
          break;
        }
        // 検証通過後の失敗(SABR_SERVER_ERROR/FETCH_STALLED/FETCH_TIMEOUT等)は候補の問題ではないので
        // ここでタスク全体を失敗させる。
        abortEpoch(lastAttempt, ABORT_REASONS.ERROR);
        tried.push({ ...candidate, outcome: lastAttempt.code, reason: lastAttempt.reason });
        throw makeError(lastAttempt.code, lastAttempt.reason, { status: lastAttempt.status });
      }
    }
    throw makeError(resolveExhaustedCode(tried), "all player JS candidates exhausted");
  }
}
