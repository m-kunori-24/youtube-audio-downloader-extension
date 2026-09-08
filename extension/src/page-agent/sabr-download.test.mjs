/**
 * @jest-environment node
 */
// sabr-download.test.mjs
// runSabrAttemptの背圧(finding 4): 最初のPOSTは検証役として即時発行し、2回目以降は
// capacityGate.wait()の解決を待ってから発行すること、ackの到着が停止監視(FETCH_STALLED)の
// 進捗として扱われること、停止判定後は待機中のリクエストが発行されずに試行が失敗することを、
// googlevideoのSabrStreamを疑似実装に差し替えて検証する。

import { jest } from "@jest/globals";

/** 疑似SabrStreamが発行するPOST回数。 */
const REQUEST_COUNT = 3;

/**
 * 疑似SabrStream。start()で順番にfetchを呼び、各応答のバイト列をaudioStreamへ流す。
 */
class FakeSabrStream {
  /** @type {FakeSabrStream[]} */
  static instances = [];

  constructor(config) {
    this.fetchFn = config.fetch;
    this.aborted = false;
    this.lastAbortController = null; // AbortController | null。直近のリクエストの中断用
    FakeSabrStream.instances.push(this);
  }

  async start() {
    const self = this;
    const audioStream = new ReadableStream({
      async start(controller) {
        try {
          for (let index = 0; index < REQUEST_COUNT; index += 1) {
            if (self.aborted) {
              throw new Error("aborted");
            }
            const abortController = new AbortController();
            self.lastAbortController = abortController;
            const response = await self.fetchFn("https://sabr.test/videoplayback", {
              method: "POST",
              signal: abortController.signal,
            });
            const bytes = new Uint8Array(await response.arrayBuffer());
            controller.enqueue(bytes);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return { audioStream };
  }

  abort() {
    this.aborted = true;
  }
}

jest.unstable_mockModule("googlevideo/sabr-stream", () => ({ SabrStream: FakeSabrStream }));
jest.unstable_mockModule("googlevideo/utils", () => ({
  buildSabrFormat: (format) => format,
  EnabledTrackTypes: { AUDIO_ONLY: 1 },
}));

const { runSabrAttempt } = await import("./sabr-download.mjs");
const { ERROR_CODES } = await import("./player-response.mjs");

const AUDIO_FORMAT = { itag: 251, mimeType: 'audio/webm; codecs="opus"', contentLength: "12" };
const PLAYER_RESPONSE = {
  streamingData: { adaptiveFormats: [AUDIO_FORMAT] },
  playerConfig: { mediaCommonConfig: { mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: "CAE=" } } },
  videoDetails: { lengthSeconds: "10" },
};

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
 * 疑似emitter・ゲート・タイマーを組み立てる。
 * @param {object} [overrides] gate/stallTimeoutMs等の上書き
 * @returns {object} テスト用ハンドル群
 */
function setup(overrides = {}) {
  FakeSabrStream.instances = [];
  const fetchFn = jest.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(4).buffer }));
  const emitter = {
    began: jest.fn(() => true),
    begin: jest.fn(),
    push: jest.fn(),
    end: jest.fn(),
    emittedOffset: () => 0,
  };
  const ackListeners = [];
  const gate = {
    wait: jest.fn(() => Promise.resolve()),
    onAck: jest.fn((listener) => ackListeners.push(listener)),
  };
  let clock = 0;
  const timers = [];
  const params = {
    fetchFn,
    streamingUrl: "https://sabr.test/videoplayback?n=x",
    playerResponse: PLAYER_RESPONSE,
    clientInfo: { clientName: 1 },
    audioFormat: AUDIO_FORMAT,
    emitter,
    capacityGate: gate,
    onProgress: jest.fn(),
    stallTimeoutMs: 1000,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    now: () => clock,
    setTimeoutFn: jest.fn((callback) => {
      timers.push(callback);
      return timers.length;
    }),
    clearTimeoutFn: jest.fn(),
    ...overrides,
  };
  return {
    params,
    fetchFn,
    emitter,
    gate,
    ackListeners,
    timers,
    setClock: (value) => {
      clock = value;
    },
    runLatestTimer: () => timers[timers.length - 1](),
  };
}

test("容量があれば全リクエストを発行し、最初のリクエストはゲートを待たない", async () => {
  const ctx = setup();
  const result = await runSabrAttempt(ctx.params);
  expect(result).toEqual({ ok: true, byteLength: 12 });
  expect(ctx.fetchFn).toHaveBeenCalledTimes(REQUEST_COUNT);
  // 2回目・3回目のみゲートを待つ。
  expect(ctx.gate.wait).toHaveBeenCalledTimes(REQUEST_COUNT - 1);
  expect(ctx.emitter.push).toHaveBeenCalledTimes(REQUEST_COUNT);
  expect(ctx.emitter.end).toHaveBeenCalledTimes(1);
  expect(ctx.gate.onAck).toHaveBeenCalledTimes(1);
});

test("2回目以降のPOSTはゲートが解放されるまで発行されない", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const ctx = setup();
  ctx.gate.wait.mockImplementation(() => blocked);

  const pending = runSabrAttempt(ctx.params);
  await until(() => ctx.gate.wait.mock.calls.length === 1);
  expect(ctx.fetchFn).toHaveBeenCalledTimes(1);

  release();
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(ctx.fetchFn).toHaveBeenCalledTimes(REQUEST_COUNT);
});

test("ackの到着は進捗として扱われ停止判定を延ばし、ackが途絶えればFETCH_STALLEDで待機中のPOSTを発行せず失敗する", async () => {
  let release;
  const ctx = setup();
  ctx.gate.wait.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );

  const pending = runSabrAttempt(ctx.params);
  await until(() => ctx.gate.wait.mock.calls.length === 1 && ctx.emitter.push.mock.calls.length === 1);
  expect(ctx.fetchFn).toHaveBeenCalledTimes(1);

  // 停止閾値(1000ms)を超えて経過したが、直前にackが届いていれば進捗ありとみなす。
  ctx.setClock(1500);
  ctx.ackListeners[0](4);
  ctx.runLatestTimer();
  expect(FakeSabrStream.instances[0].aborted).toBe(false);

  // ackも受信も無いまま閾値を超えると停止判定でストリームを中断する。
  ctx.setClock(3000);
  ctx.runLatestTimer();
  expect(FakeSabrStream.instances[0].aborted).toBe(true);

  release();
  const result = await pending;
  expect(result).toMatchObject({ ok: false, code: ERROR_CODES.FETCH_STALLED });
  expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
});

test("待機中にリクエストのAbortSignal(SabrStreamの60秒タイムアウト相当)がabortされたら待機を打ち切り、POSTは発行しない", async () => {
  const ctx = setup();
  ctx.gate.wait.mockImplementation(() => new Promise(() => {}));

  const pending = runSabrAttempt(ctx.params);
  await until(() => ctx.gate.wait.mock.calls.length === 1);
  expect(ctx.fetchFn).toHaveBeenCalledTimes(1);

  FakeSabrStream.instances[0].lastAbortController.abort(new Error("request timeout"));
  const result = await pending;
  expect(result).toMatchObject({ ok: false, code: ERROR_CODES.SABR_SERVER_ERROR, reason: "request timeout" });
  expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
});
