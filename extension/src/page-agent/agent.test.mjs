/**
 * @jest-environment node
 */
// agent.test.mjs
// runAgentの候補フォールバック(署名拒否→次候補、NETWORK_UNREACHABLE→同一候補を0.5s/1.5sで再試行)、
// 結果オブジェクトの形、署名付きフレームでの結果送達(戻り値なし)、フレームの連番・MAC、
// ackフレームの検証(改竄・再送・順序入替・別エポックの拒否)と背圧ゲートへの反映、
// 認証・再生可否エラーの写像を、nsig抽出とSABR試行をモジュールモックに差し替えて検証する。

import { jest } from "@jest/globals";
import { webcrypto } from "node:crypto";
import { importFrameKey, signFrame, verifyFrame } from "../shared/frame-auth.mjs";

const transformMock = jest.fn();
const runSabrAttemptMock = jest.fn();

jest.unstable_mockModule("./nsig.mjs", () => ({
  createNsigTransform: jest.fn(() => transformMock),
  isValidNsigOutput: (input, output) => typeof output === "string" && output !== input && output.length > 0,
  evaluateScript: jest.fn(),
}));
jest.unstable_mockModule("./sabr-download.mjs", () => ({
  runSabrAttempt: runSabrAttemptMock,
}));

const { runAgent, resolveExhaustedCode, buildClientInfo } = await import("./agent.mjs");
const { ERROR_CODES } = await import("./player-response.mjs");
const { ABORT_REASONS } = await import("../shared/abort-reasons.mjs");

const ORIGIN = "https://www.youtube.com";
const PAGE_PLAYER_JS = "/s/player/aaaa1111/player_ias.vflset/en_US/base.js";
const IFRAME_API_SOURCE = 'var x="https:\\/\\/www.youtube.com\\/s\\/player\\/bbbb2222\\/www-widgetapi.vflset\\/www-widgetapi.js";';
const STREAMING_URL = "https://rr1---sn-x.googlevideo.com/videoplayback?sabr=1&n=orig_n&expire=1";
const SECRET = "ab".repeat(32);
const subtle = webcrypto.subtle;

/**
 * 再生可能なplayerResponseを作る。
 * @returns {object} playerResponse
 */
function playerResponse() {
  return {
    playabilityStatus: { status: "OK" },
    videoDetails: { isLive: false, lengthSeconds: "10" },
    streamingData: {
      serverAbrStreamingUrl: STREAMING_URL,
      adaptiveFormats: [
        { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 130000, contentLength: "500" },
        { itag: 137, mimeType: 'video/mp4; codecs="avc1"', bitrate: 1000000, contentLength: "9000", height: 1080 },
      ],
    },
    playerConfig: { mediaCommonConfig: { mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: "CAE=" } } },
  };
}

/**
 * 依存モックを組み立てる。
 * @param {object} [overrides] fetch応答等の上書き
 * @returns {{deps: object, posted: object[], fetchFn: jest.Mock, windowStub: object,
 *   dispatch: (data: object, eventOverrides?: object) => void}} 依存とpostMessage記録・window疑似
 */
function makeDeps(overrides = {}) {
  const posted = [];
  const responses = {
    player: { ok: true, status: 200, json: async () => playerResponse() },
    ...overrides.responses,
  };
  const fetchFn = jest.fn(async (url) => {
    const text = String(url);
    if (text.includes("/youtubei/v1/player")) return responses.player;
    if (text.includes("/iframe_api")) return { ok: true, status: 200, text: async () => IFRAME_API_SOURCE };
    if (text.includes("/s/player/")) return { ok: true, status: 200, text: async () => "player js source" };
    throw new Error(`unexpected fetch ${text}`);
  });
  const listeners = new Set();
  const windowStub = {
    addEventListener: jest.fn((type, listener) => {
      if (type === "message") listeners.add(listener);
    }),
    removeEventListener: jest.fn((type, listener) => {
      if (type === "message") listeners.delete(listener);
    }),
  };
  const deps = {
    fetch: fetchFn,
    document: { cookie: "SAPISID=abc; OTHER=1", querySelector: () => null },
    window: windowStub,
    origin: ORIGIN,
    ytcfgGet: (key) => {
      if (key === "INNERTUBE_CONTEXT") return { client: { clientName: "WEB", clientVersion: "2.0", hl: "ja", gl: "JP", screenWidthPoints: 1920, utcOffsetMinutes: 540 } };
      if (key === "PLAYER_JS_URL") return PAGE_PLAYER_JS;
      if (key === "SESSION_INDEX") return "0";
      return undefined;
    },
    subtle,
    postMessage: (message) => posted.push(message),
    now: () => 1_700_000_000_000,
    setTimeout: jest.fn((callback) => {
      callback();
      return 1;
    }),
    clearTimeout: jest.fn(),
    evalScript: jest.fn(),
    ...overrides.deps,
  };

  /**
   * リレーからのwindow.postMessageを模して配信する。
   * @param {object} data フレーム
   * @param {object} [eventOverrides] source/originの上書き
   * @returns {void}
   */
  function dispatch(data, eventOverrides = {}) {
    for (const listener of [...listeners]) {
      listener({ source: windowStub, origin: ORIGIN, data, ...eventOverrides });
    }
  }

  return { deps, posted, fetchFn, windowStub, dispatch };
}

/**
 * 送出済みフレームから結果(resultフレームの中身)を取り出す。
 * @param {object[]} posted postMessage記録
 * @returns {object} result
 */
function resultOf(posted) {
  const frame = posted[posted.length - 1];
  expect(frame).toMatchObject({ ns: "yta", v: 1, taskId: "task-1", type: "result" });
  return frame.result;
}

/**
 * 条件が真になるまでイベントループを回す(上限あり)。
 * @param {() => boolean} predicate 条件
 * @returns {Promise<void>} 条件成立
 */
async function until(predicate) {
  for (let index = 0; index < 200 && !predicate(); index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!predicate()) {
    throw new Error("condition not met");
  }
}

/**
 * イベントループを数周させ、進行中の非同期検証を落ち着かせる。
 * @returns {Promise<void>} 完了
 */
async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const BASE_CFG = { taskId: "task-1", secret: SECRET, videoId: "vid", qualityTier: "high", playerJs: { knownGoodUrl: null, excluded: [] } };

beforeEach(() => {
  transformMock.mockReset();
  transformMock.mockImplementation((n) => `${n}_transformed`);
  runSabrAttemptMock.mockReset();
});

test("先頭候補が受理されれば成功結果と採用候補を署名付きresultフレームで送り、戻り値は持たない", async () => {
  runSabrAttemptMock.mockResolvedValueOnce({ ok: true, byteLength: 500 });
  const { deps, posted } = makeDeps();
  await expect(runAgent(BASE_CFG, deps)).resolves.toBeUndefined();
  const result = resultOf(posted);
  expect(result).toEqual({
    ok: true,
    byteLength: 500,
    mimeType: 'audio/webm; codecs="opus"',
    itag: 251,
    title: null,
    lengthSeconds: 10,
    acceptedCandidate: { url: `${ORIGIN}${PAGE_PLAYER_JS}`, buildHash: "aaaa1111", variant: "player_ias" },
    rejectedCandidates: [],
  });
  const attemptArgs = runSabrAttemptMock.mock.calls[0][0];
  expect(new URL(attemptArgs.streamingUrl).searchParams.get("n")).toBe("orig_n_transformed");
  expect(attemptArgs.stallTimeoutMs).toBe(60000);
  expect(attemptArgs.deadlineAt).toBe(1_700_000_000_000 + 3600000);
  expect(attemptArgs.clientInfo).toMatchObject({ clientName: 1, clientVersion: "2.0", acceptLanguage: "ja", acceptRegion: "JP", screenWidthPoints: 1920, utcOffsetMinutes: "540" });
  expect(typeof attemptArgs.capacityGate.wait).toBe("function");
  expect(typeof attemptArgs.capacityGate.onAck).toBe("function");
});

test("成功結果はvideoDetailsのtitle/lengthSecondsを載せる(SW側のファイル名生成用)", async () => {
  runSabrAttemptMock.mockResolvedValueOnce({ ok: true, byteLength: 500 });
  const response = playerResponse();
  response.videoDetails = { isLive: false, lengthSeconds: "634", title: "テスト動画 / タイトル" };
  const { deps, posted } = makeDeps({ responses: { player: { ok: true, status: 200, json: async () => response } } });

  await runAgent(BASE_CFG, deps);
  const result = resultOf(posted);

  expect(result.title).toBe("テスト動画 / タイトル");
  expect(result.lengthSeconds).toBe(634);
});

test("cfg.itagは適格フォーマットにあれば優先されるヒントとして扱う", async () => {
  runSabrAttemptMock.mockResolvedValueOnce({ ok: true, byteLength: 1 });
  const { deps, posted } = makeDeps();
  await runAgent({ ...BASE_CFG, itag: 137 }, deps); // 映像itagは不適格→通常選択
  expect(resultOf(posted).itag).toBe(251);
});

test("署名拒否は同一候補を再試行せず次候補へ進み、rejectedCandidatesへ記録する(候補順: page→iframe_api→variant書換)", async () => {
  runSabrAttemptMock
    .mockResolvedValueOnce({ ok: false, outcome: "SIGNATURE_REJECTED", code: "NSIG_REJECTED_BY_SERVER", reason: "403", status: 403 })
    .mockResolvedValueOnce({ ok: false, outcome: "SIGNATURE_REJECTED", code: "NSIG_REJECTED_BY_SERVER", reason: "403", status: 403 })
    .mockResolvedValueOnce({ ok: true, byteLength: 10 });
  const { deps, posted } = makeDeps();
  await runAgent(BASE_CFG, deps);
  const result = resultOf(posted);
  expect(result.ok).toBe(true);
  expect(result.rejectedCandidates).toEqual([
    { url: `${ORIGIN}/s/player/aaaa1111/player_ias.vflset/en_US/base.js`, buildHash: "aaaa1111", variant: "player_ias" },
    { url: `${ORIGIN}/s/player/bbbb2222/player_ias.vflset/en_US/base.js`, buildHash: "bbbb2222", variant: "player_ias" },
  ]);
  expect(result.acceptedCandidate).toEqual({
    url: `${ORIGIN}/s/player/aaaa1111/player_es6.vflset/en_US/base.js`,
    buildHash: "aaaa1111",
    variant: "player_es6",
  });
  expect(runSabrAttemptMock).toHaveBeenCalledTimes(3);
});

test("knownGoodUrlは先頭候補、excludedは候補から外れる", async () => {
  runSabrAttemptMock.mockResolvedValueOnce({ ok: true, byteLength: 1 });
  const { deps, posted } = makeDeps();
  await runAgent(
    {
      ...BASE_CFG,
      playerJs: {
        knownGoodUrl: `${ORIGIN}/s/player/cccc3333/player_ias_tce.vflset/en_US/base.js`,
        excluded: [{ buildHash: "aaaa1111", variant: "player_ias" }],
      },
    },
    deps,
  );
  expect(resultOf(posted).acceptedCandidate.buildHash).toBe("cccc3333");
});

test("NETWORK_UNREACHABLEは同一候補を0.5s→1.5sで再試行し、それでも駄目なら次候補へ", async () => {
  runSabrAttemptMock
    .mockResolvedValueOnce({ ok: false, outcome: "NETWORK_UNREACHABLE", code: "NETWORK_UNREACHABLE", reason: "net", status: null })
    .mockResolvedValueOnce({ ok: false, outcome: "NETWORK_UNREACHABLE", code: "NETWORK_UNREACHABLE", reason: "net", status: null })
    .mockResolvedValueOnce({ ok: false, outcome: "NETWORK_UNREACHABLE", code: "NETWORK_UNREACHABLE", reason: "net", status: null })
    .mockResolvedValueOnce({ ok: true, byteLength: 3 });
  const { deps, posted } = makeDeps();
  await runAgent(BASE_CFG, deps);
  const result = resultOf(posted);
  expect(result.ok).toBe(true);
  expect(result.acceptedCandidate.buildHash).toBe("bbbb2222");
  expect(result.rejectedCandidates).toEqual([]);
  const delays = deps.setTimeout.mock.calls.map(([, ms]) => ms);
  expect(delays).toEqual([500, 1500]);
  // 最初の3回は同一URL(同一候補)
  const urls = runSabrAttemptMock.mock.calls.slice(0, 3).map(([args]) => args.streamingUrl);
  expect(new Set(urls).size).toBe(1);
});

test("全候補が署名拒否ならNSIG_REJECTED_BY_SERVERで失敗し、detail.triedに履歴を持つ", async () => {
  runSabrAttemptMock.mockResolvedValue({ ok: false, outcome: "SIGNATURE_REJECTED", code: "NSIG_REJECTED_BY_SERVER", reason: "403", status: 403 });
  const { deps, posted } = makeDeps();
  await runAgent(BASE_CFG, deps);
  const result = resultOf(posted);
  expect(result.ok).toBe(false);
  expect(result.code).toBe(ERROR_CODES.NSIG_REJECTED_BY_SERVER);
  expect(result.rejectedCandidates).toHaveLength(3);
  expect(result.detail.tried.map((entry) => entry.outcome)).toEqual(["SIGNATURE_REJECTED", "SIGNATURE_REJECTED", "SIGNATURE_REJECTED"]);
});

test("nsig妥当性検証に落ちた候補はSABR試行せずNSIG_INVALIDとして次へ進む", async () => {
  transformMock.mockImplementationOnce((n) => n); // 入力エコー(静かな失敗)
  runSabrAttemptMock.mockResolvedValueOnce({ ok: true, byteLength: 1 });
  const { deps, posted } = makeDeps();
  await runAgent(BASE_CFG, deps);
  const result = resultOf(posted);
  expect(result.ok).toBe(true);
  expect(result.acceptedCandidate.buildHash).toBe("bbbb2222");
  expect(runSabrAttemptMock).toHaveBeenCalledTimes(1);
});

test("検証通過後の失敗(FETCH_STALLED)は次候補へ進まずタスク失敗にする", async () => {
  runSabrAttemptMock.mockResolvedValueOnce({ ok: false, outcome: null, code: "FETCH_STALLED", reason: "no progress", status: null });
  const { deps, posted } = makeDeps();
  await runAgent(BASE_CFG, deps);
  expect(resultOf(posted)).toMatchObject({ ok: false, code: ERROR_CODES.FETCH_STALLED });
  expect(runSabrAttemptMock).toHaveBeenCalledTimes(1);
});

test("SAPISID Cookieが無ければAUTH_NOT_LOGGED_IN", async () => {
  const { deps, posted, fetchFn } = makeDeps({ deps: { document: { cookie: "OTHER=1", querySelector: () => null } } });
  await runAgent(BASE_CFG, deps);
  expect(resultOf(posted)).toMatchObject({ ok: false, code: ERROR_CODES.AUTH_NOT_LOGGED_IN, rejectedCandidates: [] });
  expect(fetchFn).not.toHaveBeenCalled();
});

test("playabilityStatusのエラーはそのcodeで失敗する", async () => {
  const { deps, posted } = makeDeps({
    responses: { player: { ok: true, status: 200, json: async () => ({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in" } }) } },
  });
  await runAgent(BASE_CFG, deps);
  expect(resultOf(posted)).toMatchObject({ ok: false, code: ERROR_CODES.VIDEO_LOGIN_REQUIRED });
});

test("適格な音声フォーマットが無ければVIDEO_NO_AUDIO_FORMAT", async () => {
  const response = playerResponse();
  response.streamingData.adaptiveFormats = [response.streamingData.adaptiveFormats[1]];
  const { deps, posted } = makeDeps({ responses: { player: { ok: true, status: 200, json: async () => response } } });
  await runAgent(BASE_CFG, deps);
  expect(resultOf(posted)).toMatchObject({ ok: false, code: ERROR_CODES.VIDEO_NO_AUDIO_FORMAT });
});

test("stallTimeoutMs/maxDurationMsはcfgの値を下限として使う(動画長がそれ以下なら下限のまま)", async () => {
  runSabrAttemptMock.mockResolvedValueOnce({ ok: true, byteLength: 1 });
  const { deps } = makeDeps();
  // playerResponse()のlengthSeconds="10"(10000ms)は下限20000msを超えないので、下限がそのまま採用される。
  await runAgent({ ...BASE_CFG, stallTimeoutMs: 1234, maxDurationMs: 20000 }, deps);
  const attemptArgs = runSabrAttemptMock.mock.calls[0][0];
  expect(attemptArgs.stallTimeoutMs).toBe(1234);
  expect(attemptArgs.deadlineAt).toBe(1_700_000_000_000 + 20000);
});

describe("動画長ベースの絶対期限(finding 5)", () => {
  /**
   * lengthSecondsを指定したplayerResponseで実行し、runSabrAttemptへ渡されたdeadlineAtを返す。
   * @param {string|number|undefined} lengthSeconds videoDetails.lengthSeconds
   * @param {number} [maxDurationMs] cfg.maxDurationMs(下限)
   * @returns {Promise<number>} 採用されたdeadlineAt
   */
  async function deadlineFor(lengthSeconds, maxDurationMs) {
    runSabrAttemptMock.mockResolvedValueOnce({ ok: true, byteLength: 1 });
    const response = playerResponse();
    response.videoDetails = { ...response.videoDetails, lengthSeconds };
    const { deps } = makeDeps({ responses: { player: { ok: true, status: 200, json: async () => response } } });
    const cfg = maxDurationMs === undefined ? BASE_CFG : { ...BASE_CFG, maxDurationMs };
    await runAgent(cfg, deps);
    return runSabrAttemptMock.mock.calls[0][0].deadlineAt;
  }

  test("12時間動画(下限のDEFAULT_MAX_DURATION_MSを大きく超える)は動画長基準の期限になる", async () => {
    const twelveHoursMs = 12 * 3600 * 1000;
    await expect(deadlineFor(String(12 * 3600))).resolves.toBe(1_700_000_000_000 + twelveHoursMs);
  });

  test("動画長が下限(cfg.maxDurationMs)未満なら下限がそのまま使われる", async () => {
    await expect(deadlineFor("10", 3600000)).resolves.toBe(1_700_000_000_000 + 3600000);
  });

  test("lengthSecondsが欠落・0・非数値なら下限のみを使う", async () => {
    await expect(deadlineFor(undefined, 5000)).resolves.toBe(1_700_000_000_000 + 5000);
    await expect(deadlineFor("0", 5000)).resolves.toBe(1_700_000_000_000 + 5000);
    await expect(deadlineFor("not-a-number", 5000)).resolves.toBe(1_700_000_000_000 + 5000);
  });
});

describe("署名付きフレーム", () => {
  test("全フレームは0からの連番nと、ヘッダ(+dataのbytes)を対象にした有効なmacを持ち、送出順が保たれる", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    runSabrAttemptMock.mockImplementationOnce(async ({ emitter }) => {
      emitter.begin({ itag: 251, mimeType: "audio/webm", totalBytes: 5 });
      emitter.push(payload);
      emitter.end();
      return { ok: true, byteLength: 5 };
    });
    const { deps, posted } = makeDeps();
    await runAgent(BASE_CFG, deps);

    expect(posted.map((frame) => frame.type)).toEqual(["status", "status", "begin", "data", "end", "result"]);
    expect(posted.map((frame) => frame.n)).toEqual([0, 1, 2, 3, 4, 5]);
    const key = await importFrameKey(subtle, SECRET);
    for (const frame of posted) {
      const { mac, ...header } = frame;
      const bytes = frame.bytes instanceof ArrayBuffer ? new Uint8Array(frame.bytes) : undefined;
      expect(mac).toMatch(/^[0-9a-f]{64}$/);
      await expect(verifyFrame(subtle, key, header, bytes, mac)).resolves.toBe(true);
    }
    const data = posted[3];
    expect(new Uint8Array(data.bytes)).toEqual(payload);
    // bytesを書き換えるとmacは一致しない(ペイロードが署名対象であること)。
    const { mac, ...header } = data;
    await expect(verifyFrame(subtle, key, header, new Uint8Array([1, 2, 3, 4, 6]), mac)).resolves.toBe(false);
  });

  test("abortフレームのreasonは共有定数(restart/error)を使う", async () => {
    runSabrAttemptMock.mockImplementation(async ({ emitter }) => {
      emitter.begin({ itag: 251, mimeType: "audio/webm", totalBytes: null });
      return { ok: false, outcome: "SIGNATURE_REJECTED", code: "NSIG_REJECTED_BY_SERVER", reason: "403", status: 403 };
    });
    const { deps, posted } = makeDeps();
    await runAgent(BASE_CFG, deps);
    const aborts = posted.filter((frame) => frame.type === "abort");
    expect(aborts.map((frame) => [frame.epoch, frame.reason])).toEqual([
      [0, ABORT_REASONS.RESTART],
      [1, ABORT_REASONS.RESTART],
      [2, ABORT_REASONS.ERROR],
    ]);
    expect(ABORT_REASONS.ERROR).toBe("error");
  });

  test("secretが不正で鍵を作れなければ何も送らずに終了する", async () => {
    const { deps, posted, windowStub } = makeDeps();
    await expect(runAgent({ ...BASE_CFG, secret: "nope" }, deps)).resolves.toBeUndefined();
    expect(posted).toEqual([]);
    expect(windowStub.addEventListener).not.toHaveBeenCalled();
  });

  test("messageリスナーは開始時に登録し、終了時に同じ関数で解除する", async () => {
    runSabrAttemptMock.mockResolvedValueOnce({ ok: true, byteLength: 1 });
    const { deps, windowStub } = makeDeps();
    await runAgent(BASE_CFG, deps);
    expect(windowStub.addEventListener).toHaveBeenCalledTimes(1);
    const [, listener] = windowStub.addEventListener.mock.calls[0];
    expect(windowStub.removeEventListener).toHaveBeenCalledWith("message", listener);
  });
});

describe("ackフレームの受信(背圧)", () => {
  /**
   * リレーが送るackフレームを署名して作る。
   * @param {CryptoKey} key 署名鍵
   * @param {{epoch: number, offset: number, n: number}} fields フィールド
   * @returns {Promise<object>} 署名済みack
   */
  async function ack(key, { epoch, offset, n }) {
    const frame = { ns: "yta", v: 1, taskId: "task-1", type: "ack", epoch, offset, n };
    frame.mac = await signFrame(subtle, key, frame, undefined);
    return frame;
  }

  test("正規のackは背圧ゲートへ反映し、改竄・再送・順序入替・別エポック・別鍵は反映しない", async () => {
    const key = await importFrameKey(subtle, SECRET);
    const otherKey = await importFrameKey(subtle, "cd".repeat(32));
    const observed = [];
    runSabrAttemptMock.mockImplementationOnce(async ({ capacityGate }) => {
      // 1. 正規(n=0)
      dispatch(await ack(key, { epoch: 0, offset: 100, n: 0 }));
      await until(() => capacityGate.ackedOffset() === 100);
      // 2. 改竄(n=1, mac不正)は連番を消費しないので、続く正規のn=1が受理される
      dispatch({ ...(await ack(key, { epoch: 0, offset: 999, n: 1 })), offset: 998 });
      dispatch(await ack(otherKey, { epoch: 0, offset: 997, n: 1 }));
      dispatch(await ack(key, { epoch: 0, offset: 200, n: 1 }));
      await until(() => capacityGate.ackedOffset() === 200);
      // 3. 再送(n=1)・順序入替(n=3を先に)は捨てる
      dispatch(await ack(key, { epoch: 0, offset: 200, n: 1 }));
      dispatch(await ack(key, { epoch: 0, offset: 300, n: 3 }));
      await settle();
      observed.push(capacityGate.ackedOffset());
      // 4. 別エポック(n=2)は連番は消費するがゲートへは反映しない
      dispatch(await ack(key, { epoch: 7, offset: 400, n: 2 }));
      await settle();
      observed.push(capacityGate.ackedOffset());
      // 5. 期待が3になったので、先ほど捨てたn=3の正規フレームが受理される
      dispatch(await ack(key, { epoch: 0, offset: 300, n: 3 }));
      await until(() => capacityGate.ackedOffset() === 300);
      // 6. source/origin/taskId/type不一致は同期区間で捨てる(連番も消費しない)
      dispatch(await ack(key, { epoch: 0, offset: 500, n: 4 }), { source: {} });
      dispatch(await ack(key, { epoch: 0, offset: 500, n: 4 }), { origin: "https://evil.example" });
      dispatch({ ...(await ack(key, { epoch: 0, offset: 500, n: 4 })), taskId: "other" });
      dispatch({ ...(await ack(key, { epoch: 0, offset: 500, n: 4 })), type: "status" });
      dispatch({ ...(await ack(key, { epoch: 0, offset: 500, n: 4 })), offset: -1 });
      await settle();
      observed.push(capacityGate.ackedOffset());
      dispatch(await ack(key, { epoch: 0, offset: 500, n: 4 }));
      await until(() => capacityGate.ackedOffset() === 500);
      return { ok: true, byteLength: 500 };
    });
    const { deps, posted, dispatch } = makeDeps();
    await runAgent(BASE_CFG, deps);
    expect(resultOf(posted).ok).toBe(true);
    expect(observed).toEqual([200, 200, 300]);
  });

  test("ackのepochは実行中の試行のエポックと照合される(旧エポックの遅延ackは無視)", async () => {
    const key = await importFrameKey(subtle, SECRET);
    const seen = [];
    runSabrAttemptMock
      .mockImplementationOnce(async () => ({ ok: false, outcome: "SIGNATURE_REJECTED", code: "NSIG_REJECTED_BY_SERVER", reason: "403", status: 403 }))
      .mockImplementationOnce(async ({ capacityGate }) => {
        dispatch(await ack(key, { epoch: 0, offset: 100, n: 0 })); // 旧エポック
        dispatch(await ack(key, { epoch: 1, offset: 50, n: 1 })); // 現エポック
        await until(() => capacityGate.ackedOffset() === 50);
        seen.push(capacityGate.ackedOffset());
        return { ok: true, byteLength: 50 };
      });
    const { deps, dispatch } = makeDeps();
    await runAgent(BASE_CFG, deps);
    expect(seen).toEqual([50]);
  });
});

describe("resolveExhaustedCode / buildClientInfo", () => {
  test("署名拒否 > ネットワーク不通 > 抽出失敗 > プレイヤーJS入手不可 の優先順(finding 13a)", () => {
    expect(resolveExhaustedCode([{ outcome: "EXTRACT_FAILED" }, { outcome: "SIGNATURE_REJECTED" }])).toBe(ERROR_CODES.NSIG_REJECTED_BY_SERVER);
    expect(resolveExhaustedCode([{ outcome: "EXTRACT_FAILED" }, { outcome: "NETWORK_UNREACHABLE" }])).toBe(ERROR_CODES.NETWORK_UNREACHABLE);
    expect(resolveExhaustedCode([{ outcome: "FETCH_FAILED" }, { outcome: "EXTRACT_FAILED" }])).toBe(ERROR_CODES.EXTRACT_NSIG_FAILED);
    expect(resolveExhaustedCode([{ outcome: "FETCH_FAILED" }])).toBe(ERROR_CODES.PLAYER_JS_UNAVAILABLE);
  });

  test("buildClientInfoはcontext欠落でもWEB(1)を返す", () => {
    expect(buildClientInfo(undefined)).toEqual({ clientName: 1, clientFormFactor: 0 });
  });
});

describe("候補フェッチとfetch/extract失敗の区別(finding 3/13a)", () => {
  test("プレイヤーJS候補の取得はredirect:\"error\"を指定する", async () => {
    runSabrAttemptMock.mockResolvedValueOnce({ ok: true, byteLength: 1 });
    const { deps, fetchFn } = makeDeps();
    await runAgent(BASE_CFG, deps);
    const playerJsCall = fetchFn.mock.calls.find(([url]) => String(url).includes("/s/player/"));
    expect(playerJsCall[1]).toMatchObject({ redirect: "error" });
  });

  test("全候補が抽出失敗(fetchは成功)ならEXTRACT_NSIG_FAILEDで失敗する", async () => {
    transformMock.mockImplementation(() => {
      throw new Error("nsig extraction boom");
    });
    const { deps, posted } = makeDeps();
    await runAgent(BASE_CFG, deps);
    const result = resultOf(posted);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ERROR_CODES.EXTRACT_NSIG_FAILED);
    expect(result.detail.tried.map((entry) => entry.outcome)).toEqual(["EXTRACT_FAILED", "EXTRACT_FAILED", "EXTRACT_FAILED"]);
    expect(runSabrAttemptMock).not.toHaveBeenCalled();
  });

  test("全候補が取得(fetch)自体に失敗すればPLAYER_JS_UNAVAILABLEのまま", async () => {
    const { deps, posted } = makeDeps({
      deps: {
        fetch: jest.fn(async (url) => {
          const text = String(url);
          if (text.includes("/youtubei/v1/player")) return { ok: true, status: 200, json: async () => playerResponse() };
          if (text.includes("/iframe_api")) return { ok: true, status: 200, text: async () => IFRAME_API_SOURCE };
          if (text.includes("/s/player/")) return { ok: false, status: 404 };
          throw new Error(`unexpected fetch ${text}`);
        }),
      },
    });
    await runAgent(BASE_CFG, deps);
    const result = resultOf(posted);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ERROR_CODES.PLAYER_JS_UNAVAILABLE);
    expect(result.detail.tried.map((entry) => entry.outcome)).toEqual(["FETCH_FAILED", "FETCH_FAILED", "FETCH_FAILED"]);
  });
});
