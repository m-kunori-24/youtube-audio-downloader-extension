// sabr-download.mjs
// googlevideoのSabrStreamで音声のみをダウンロードする1試行(1エポック)を実行する。
// 最初のPOSTはfirst-request-classifierで検証役として扱い、失敗時は候補却下/再試行の
// 判断材料(outcome)を返す。検証通過後の失敗はSabrStream内部の再試行に委ね、
// それでも失敗すればSABR_SERVER_ERRORとして返す。
// 進捗停止(stallTimeoutMs)はFETCH_STALLED、タスク全体の締切(deadlineAt)はFETCH_TIMEOUT。
// 背圧(finding 4): 最初のPOSTの検証後、以降のPOSTはcapacityGate.wait()で
// 送出済み−ack済みがウィンドウ内になるまで待つ。ackの到着は進捗とみなし停止監視を更新する。

import { SabrStream } from "googlevideo/sabr-stream";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";
import { classifyFetchException, classifyHttpFailure, FIRST_REQUEST_OUTCOME } from "./first-request-classifier.mjs";
import { ERROR_CODES } from "./player-response.mjs";

const WATCHDOG_INTERVAL_MS = 1000;

/**
 * AUDIO_ONLYでもSabrStreamは映像フォーマットの選択を要求する(破棄対象として扱う)。
 * 最も低解像度の映像フォーマットを渡し、無ければプレースホルダーを返す。
 * @param {object[]} formats SabrFormat配列
 * @returns {object} 映像フォーマット
 */
function pickDiscardableVideoFormat(formats) {
  const videoFormats = formats.filter((format) => typeof format.mimeType === "string" && format.mimeType.startsWith("video/"));
  if (videoFormats.length === 0) {
    return { itag: 0, lastModified: "0", bitrate: 0, approxDurationMs: 0, mimeType: "video/mp4" };
  }
  return [...videoFormats].sort((a, b) => (a.height || 0) - (b.height || 0))[0];
}

/**
 * SABRダウンロードを1試行実行する。
 * @param {{fetchFn: typeof fetch, streamingUrl: string, playerResponse: object, clientInfo: object,
 *   audioFormat: object, emitter: object, capacityGate: object,
 *   onProgress: (bytes: number, totalBytes: number|null) => void,
 *   stallTimeoutMs: number, deadlineAt: number, now: () => number,
 *   setTimeoutFn: typeof setTimeout, clearTimeoutFn: typeof clearTimeout}} params
 *   streamingUrl: n変換適用済みのserverAbrStreamingUrl、emitter: segment-emitter、
 *   capacityGate: createCapacityGateの背圧ゲート、deadlineAt: now()基準の絶対締切(ms)
 * @returns {Promise<{ok: true, byteLength: number}
 *   | {ok: false, outcome: string|null, code: string, reason: string, status: number|null}>} 試行結果
 */
export async function runSabrAttempt({
  fetchFn,
  streamingUrl,
  playerResponse,
  clientInfo,
  audioFormat,
  emitter,
  capacityGate,
  onProgress,
  stallTimeoutMs,
  deadlineAt,
  now,
  setTimeoutFn,
  clearTimeoutFn,
}) {
  const streamingData = playerResponse.streamingData;
  const formats = streamingData.adaptiveFormats.map(buildSabrFormat);
  const ustreamerConfig =
    playerResponse.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
  const lengthSeconds = Number.parseInt(playerResponse.videoDetails?.lengthSeconds, 10);
  const totalBytes = Number.parseInt(audioFormat.contentLength, 10);

  let firstRequestValidated = false; // boolean
  let firstRequestFailure = null; // {outcome, status} | null
  let watchdogFailure = null; // {code, reason} | null
  let stream = null; // SabrStream | null
  let receivedBytes = 0; // number
  let lastProgressAt = now(); // number。バイト受信またはack受信の最終時刻

  capacityGate.onAck(() => {
    lastProgressAt = now();
  });

  /**
   * 背圧ゲートの容量が空くまで待つ。SabrStreamの1リクエスト用AbortSignalが
   * 待機中にabortされた場合はその理由でrejectし、待機を放置しない。
   * @param {AbortSignal|undefined} signal リクエストのAbortSignal
   * @returns {Promise<void>} 容量確保
   */
  function waitForCapacity(signal) {
    if (!signal) {
      return capacityGate.wait();
    }
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new Error("aborted"));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      capacityGate.wait().then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  /**
   * SabrStreamへ渡すfetch。最初のリクエストだけ検証役として分類し、失敗ならストリームを中断する。
   * 検証通過後のリクエストは背圧ゲートの容量を待ってから発行する。
   * @param {string|URL} url リクエストURL
   * @param {RequestInit} init リクエスト設定
   * @returns {Promise<Response>} 応答
   */
  async function validatingFetch(url, init) {
    if (firstRequestValidated) {
      await waitForCapacity(init && init.signal);
      if (watchdogFailure !== null) {
        throw new Error(watchdogFailure.reason);
      }
      return fetchFn(url, init);
    }
    let response;
    try {
      response = await fetchFn(url, init);
    } catch (error) {
      firstRequestFailure = await classifyFetchException(error, String(url), fetchFn);
      stream?.abort();
      throw error;
    }
    if (!response.ok) {
      firstRequestFailure = classifyHttpFailure(response.status);
      stream?.abort();
      throw new Error(`HTTP ${response.status}`);
    }
    firstRequestValidated = true;
    return response;
  }

  stream = new SabrStream({
    fetch: validatingFetch,
    serverAbrStreamingUrl: streamingUrl,
    videoPlaybackUstreamerConfig: ustreamerConfig,
    clientInfo,
    durationMs: Number.isFinite(lengthSeconds) && lengthSeconds > 0 ? lengthSeconds * 1000 : undefined,
    formats,
  });

  let audioStream;
  try {
    const started = await stream.start({
      audioFormat: audioFormat.itag,
      videoFormat: pickDiscardableVideoFormat,
      enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
    });
    audioStream = started.audioStream;
  } catch (error) {
    return {
      ok: false,
      outcome: null,
      code: ERROR_CODES.SABR_SERVER_ERROR,
      reason: error && error.message ? error.message : "SabrStream start failed",
      status: null,
    };
  }

  lastProgressAt = now();
  const watchdog = setIntervalLike();

  /**
   * 停止・締切監視タイマーを開始する。setTimeoutの連鎖で実装し、依存注入した
   * タイマー関数だけを使う。
   * @returns {{stop: () => void}} 停止ハンドル
   */
  function setIntervalLike() {
    let handle = null;
    let stopped = false;
    const tick = () => {
      if (stopped) {
        return;
      }
      const current = now();
      if (current >= deadlineAt) {
        watchdogFailure = { code: ERROR_CODES.FETCH_TIMEOUT, reason: "maxDurationMs exceeded" };
      } else if (current - lastProgressAt >= stallTimeoutMs) {
        watchdogFailure = { code: ERROR_CODES.FETCH_STALLED, reason: `no progress for ${stallTimeoutMs}ms` };
      }
      if (watchdogFailure !== null) {
        stopped = true;
        stream.abort();
        return;
      }
      handle = setTimeoutFn(tick, WATCHDOG_INTERVAL_MS);
    };
    handle = setTimeoutFn(tick, WATCHDOG_INTERVAL_MS);
    return {
      stop() {
        stopped = true;
        if (handle !== null) {
          clearTimeoutFn(handle);
        }
      },
    };
  }

  const reader = audioStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!emitter.began()) {
        emitter.begin({
          itag: audioFormat.itag,
          mimeType: audioFormat.mimeType,
          totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
        });
      }
      receivedBytes += value.length;
      lastProgressAt = now();
      emitter.push(value);
      onProgress(receivedBytes, Number.isFinite(totalBytes) ? totalBytes : null);
    }
  } catch (error) {
    watchdog.stop();
    if (firstRequestFailure !== null) {
      const outcome = firstRequestFailure.outcome;
      const code =
        outcome === FIRST_REQUEST_OUTCOME.SIGNATURE_REJECTED
          ? ERROR_CODES.NSIG_REJECTED_BY_SERVER
          : outcome === FIRST_REQUEST_OUTCOME.NETWORK_UNREACHABLE
            ? ERROR_CODES.NETWORK_UNREACHABLE
            : ERROR_CODES.SABR_SERVER_ERROR;
      return { ok: false, outcome, code, reason: `first request: ${outcome}`, status: firstRequestFailure.status };
    }
    if (watchdogFailure !== null) {
      return { ok: false, outcome: null, code: watchdogFailure.code, reason: watchdogFailure.reason, status: null };
    }
    return {
      ok: false,
      outcome: null,
      code: ERROR_CODES.SABR_SERVER_ERROR,
      reason: error && error.message ? error.message : "stream error",
      status: null,
    };
  }
  watchdog.stop();
  emitter.end();
  return { ok: true, byteLength: receivedBytes };
}
