/**
 * @jest-environment node
 */
// relay.test.mjs
// page-relayのHMAC検証(改竄・再送・順序入替の拒否)、同期区間でのbytes複製、
// エポック厳密管理・chunk再フレーミング(seq/offset)・ready待ちバッファ・
// status/result中継・ack署名転送・Port切断通知・無活動タイムアウト(RELAY_IDLE)のテスト。
// chrome APIはtest-utils/chromeStub.jsのスタブを再利用し、Web CryptoはNodeのwebcryptoを注入する。

import { jest } from "@jest/globals";
import { webcrypto } from "node:crypto";
import { createChromeStub } from "../../test-utils/chromeStub.js";
import { importFrameKey, signFrame, verifyFrame } from "../shared/frame-auth.mjs";
import { RELAY_IDLE, RELAY_PORT_DISCONNECTED, RESULT_GRACE_MS, startRelay } from "./relay.mjs";

const ORIGIN = "https://www.youtube.com";
const TASK_ID = "task-1";
const SECRET = "ab".repeat(32);
const OTHER_SECRET = "cd".repeat(32);
const subtle = webcrypto.subtle;

/**
 * リレーとその周辺スタブを組み立てる。
 * @param {object} [options] chunkBytes/idleTimeoutMs/secretの上書き
 * @returns {Promise<object>} テスト用ハンドル群
 */
async function setup(options = {}) {
  const { secret = SECRET, ...depOverrides } = options;
  const { chrome } = createChromeStub();
  const listeners = new Set();
  const windowStub = {
    addEventListener: jest.fn((type, listener) => {
      if (type === "message") listeners.add(listener);
    }),
    removeEventListener: jest.fn((type, listener) => {
      if (type === "message") listeners.delete(listener);
    }),
    postMessage: jest.fn(),
  };
  const timers = [];
  const setTimeoutFn = jest.fn((callback, ms) => {
    const handle = { callback, ms, cleared: false };
    timers.push(handle);
    return handle;
  });
  const clearTimeoutFn = jest.fn((handle) => {
    handle.cleared = true;
  });
  const relay = startRelay(
    { taskId: TASK_ID, secret },
    { chrome, window: windowStub, origin: ORIGIN, subtle, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, ...depOverrides },
  );
  const key = await importFrameKey(subtle, SECRET);
  let counter = 0; // number。agent→relay方向の連番

  /**
   * page-agentが送る署名付きフレームを作る。
   * @param {object} fields type以下のフィールド
   * @param {{n?: number, key?: CryptoKey}} [signOptions] 連番・鍵の上書き(既定は連番を消費し正規鍵で署名)
   * @returns {Promise<object>} 署名済みフレーム
   */
  async function signed(fields, signOptions = {}) {
    const n = signOptions.n !== undefined ? signOptions.n : counter++;
    const frame = { ns: "yta", v: 1, taskId: TASK_ID, ...fields, n };
    const payload = frame.bytes instanceof ArrayBuffer ? new Uint8Array(frame.bytes) : undefined;
    frame.mac = await signFrame(subtle, signOptions.key ?? key, frame, payload);
    return frame;
  }

  /**
   * MAIN worldからのpostMessageを模して配信する(同期)。
   * @param {object} data メッセージ本体
   * @param {object} [eventOverrides] source/originの上書き
   * @returns {void}
   */
  function dispatch(data, eventOverrides = {}) {
    for (const listener of [...listeners]) {
      listener({ source: windowStub, origin: ORIGIN, data, ...eventOverrides });
    }
  }

  /**
   * 署名済みフレームを作って配信し、リレーの処理完了まで待つ。
   * @param {object} fields type以下のフィールド
   * @param {object} [signOptions] signedへの上書き
   * @returns {Promise<object>} 配信したフレーム
   */
  async function send(fields, signOptions) {
    const frame = await signed(fields, signOptions);
    dispatch(frame);
    await relay.flush();
    return frame;
  }

  /**
   * 直近にconnectされたPortスタブを返す。
   * @returns {object|null} Portスタブ
   */
  function lastPort() {
    const results = chrome.runtime.connect.mock.results;
    return results.length > 0 ? results[results.length - 1].value : null;
  }

  /**
   * 送信されたchunk等のPortメッセージ一覧を返す。
   * @returns {object[]} メッセージ
   */
  function portMessages() {
    const port = lastPort();
    return port ? port.postMessage.mock.calls.map(([m]) => m) : [];
  }

  /**
   * SWへ送ったメッセージ一覧を返す。
   * @returns {object[]} メッセージ
   */
  function runtimeMessages() {
    return chrome.runtime.sendMessage.mock.calls.map(([m]) => m);
  }

  return { chrome, windowStub, relay, key, signed, dispatch, send, lastPort, portMessages, runtimeMessages, timers, listeners };
}

/**
 * 連番バイト列のArrayBufferを作る。
 * @param {number} length 長さ
 * @param {number} seed 先頭値
 * @returns {ArrayBuffer} バッファ
 */
function bufferOf(length, seed) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (seed + i) & 0xff;
  return out.buffer;
}

const BEGIN = { type: "begin", epoch: 0, itag: 251, mimeType: "audio/webm", totalBytes: null };

describe("同期区間のフィルタリング", () => {
  test("source/origin/ns/v/taskId/type不一致のメッセージは無視し、連番も消費しない", async () => {
    const ctx = await setup();
    const status = { type: "status", phase: "player" };
    ctx.dispatch(await ctx.signed(status, { n: 0 }), { source: {} });
    ctx.dispatch(await ctx.signed(status, { n: 0 }), { origin: "https://evil.example" });
    ctx.dispatch({ ...(await ctx.signed(status, { n: 0 })), ns: "other" });
    ctx.dispatch({ ...(await ctx.signed(status, { n: 0 })), v: 2 });
    ctx.dispatch({ ...(await ctx.signed(status, { n: 0 })), taskId: "task-other" });
    ctx.dispatch({ ...(await ctx.signed(status, { n: 0 })), type: "ack" });
    ctx.dispatch({ ...(await ctx.signed(status, { n: 0 })), type: "unknown" });
    await ctx.relay.flush();
    expect(ctx.runtimeMessages()).toEqual([]);

    await ctx.send(status);
    expect(ctx.runtimeMessages()).toEqual([{ type: "page.status", taskId: TASK_ID, phase: "player" }]);
  });
});

describe("HMAC検証", () => {
  test("mac無し・mac改竄・署名後のフィールド改竄・別鍵署名はいずれも捨て、連番を消費しない", async () => {
    const ctx = await setup();
    const otherKey = await importFrameKey(subtle, OTHER_SECRET);
    const status = { type: "status", phase: "player" };
    const { mac, ...unsigned } = await ctx.signed(status, { n: 0 });
    ctx.dispatch(unsigned);
    ctx.dispatch({ ...(await ctx.signed(status, { n: 0 })), mac: "00".repeat(32) });
    ctx.dispatch({ ...(await ctx.signed(status, { n: 0 })), phase: "download" });
    ctx.dispatch(await ctx.signed(status, { n: 0, key: otherKey }));
    await ctx.relay.flush();
    expect(ctx.runtimeMessages()).toEqual([]);

    await ctx.send(status);
    expect(ctx.runtimeMessages()).toHaveLength(1);
  });

  test("再送(同じn)は2回目を捨て、順序入替(先のnを飛ばした後続)は捨てる", async () => {
    const ctx = await setup();
    const first = await ctx.signed({ type: "status", phase: "player" }); // n=0
    const second = await ctx.signed({ type: "status", phase: "player-js", attempt: 1, total: 2 }); // n=1
    ctx.dispatch(second); // n=1が先に届く → 捨てる(期待は0)
    ctx.dispatch(first); // n=0 → 受理
    ctx.dispatch(first); // 再送 → 捨てる
    await ctx.relay.flush();
    expect(ctx.runtimeMessages().map((m) => m.phase)).toEqual(["player"]);

    ctx.dispatch(second); // 期待が1になった後の正規フレーム → 受理
    await ctx.relay.flush();
    expect(ctx.runtimeMessages().map((m) => m.phase)).toEqual(["player", "player-js"]);
  });

  test("secretが不正でリレーの鍵が作れなければ全フレームを捨てる", async () => {
    const ctx = await setup({ secret: "not-hex" });
    await ctx.send({ type: "status", phase: "player" });
    expect(ctx.runtimeMessages()).toEqual([]);
  });

  test("dataフレームのbytesは同期区間で複製され、検証中にページ側が元バッファを書き換えても署名時の内容が転送される", async () => {
    const ctx = await setup({ chunkBytes: 8 });
    await ctx.send(BEGIN);
    ctx.lastPort()._onMessage({ type: "ready" });
    const original = bufferOf(4, 0);
    const frame = await ctx.signed({ type: "data", epoch: 0, offset: 0, bytes: original });
    ctx.dispatch(frame);
    new Uint8Array(original).fill(0xee); // 検証(非同期)の完了前に書き換える
    await ctx.relay.flush();
    const chunks = ctx.portMessages().filter((m) => m.type === "chunk");
    expect(chunks).toHaveLength(1);
    expect(new Uint8Array(Buffer.from(chunks[0].data, "base64"))).toEqual(new Uint8Array(bufferOf(4, 0)));
  });
});

describe("フィールド形状の検証", () => {
  test("statusは許可フィールド以外を含むと捨て、数値フィールドは非負整数かnullのみ", async () => {
    const ctx = await setup();
    ctx.dispatch(await ctx.signed({ type: "status", phase: "download", bytes: 1, evil: "x" }, { n: 0 }));
    ctx.dispatch(await ctx.signed({ type: "status", phase: "download", bytes: -1 }, { n: 0 }));
    ctx.dispatch(await ctx.signed({ type: "status", phase: "download", bytes: 1.5 }, { n: 0 }));
    ctx.dispatch(await ctx.signed({ type: "status", phase: 5 }, { n: 0 }));
    ctx.dispatch(await ctx.signed({ type: "status", phase: "player-js", buildHash: 123 }, { n: 0 }));
    await ctx.relay.flush();
    expect(ctx.runtimeMessages()).toEqual([]);

    await ctx.send({ type: "status", phase: "download", bytes: 10, totalBytes: null });
    await ctx.send({ type: "status", phase: "player-js", attempt: 1, total: 3, buildHash: "aaaa1111" });
    expect(ctx.runtimeMessages()).toEqual([
      { type: "page.status", taskId: TASK_ID, phase: "download", bytes: 10, totalBytes: null },
      { type: "page.status", taskId: TASK_ID, phase: "player-js", attempt: 1, total: 3, buildHash: "aaaa1111" },
    ]);
  });

  test("begin/data/end/abortの数値フィールドが非負整数でなければ捨てる", async () => {
    const ctx = await setup();
    ctx.dispatch(await ctx.signed({ ...BEGIN, epoch: -1 }, { n: 0 }));
    ctx.dispatch(await ctx.signed({ ...BEGIN, epoch: 1.5 }, { n: 0 }));
    ctx.dispatch(await ctx.signed({ ...BEGIN, epoch: Number.NaN }, { n: 0 }));
    ctx.dispatch(await ctx.signed({ ...BEGIN, totalBytes: Number.POSITIVE_INFINITY }, { n: 0 }));
    ctx.dispatch(await ctx.signed({ ...BEGIN, itag: "251" }, { n: 0 }));
    await ctx.relay.flush();
    expect(ctx.chrome.runtime.connect).not.toHaveBeenCalled();

    await ctx.send(BEGIN);
    ctx.lastPort()._onMessage({ type: "ready" });
    ctx.dispatch(await ctx.signed({ type: "data", epoch: 0, offset: -1, bytes: bufferOf(2, 0) }, { n: 1 }));
    ctx.dispatch(await ctx.signed({ type: "data", epoch: 0, offset: 0.5, bytes: bufferOf(2, 0) }, { n: 1 }));
    ctx.dispatch(await ctx.signed({ type: "data", epoch: 0, offset: 0, bytes: "not-bytes" }, { n: 1 }));
    ctx.dispatch(await ctx.signed({ type: "end", epoch: 0, byteLength: -3 }, { n: 1 }));
    ctx.dispatch(await ctx.signed({ type: "abort", epoch: 0, reason: 7 }, { n: 1 }));
    ctx.dispatch(await ctx.signed({ type: "result", result: "ok" }, { n: 1 }));
    await ctx.relay.flush();
    expect(ctx.portMessages().map((m) => m.type)).toEqual(["begin"]);
    expect(ctx.runtimeMessages()).toEqual([]);
  });
});

describe("begin / data / end", () => {
  test("beginでPortを開き、readyまでバッファし、ready後にbegin→chunkの順で流す", async () => {
    const ctx = await setup({ chunkBytes: 4 });
    await ctx.send({ ...BEGIN, totalBytes: 10 });
    expect(ctx.chrome.runtime.connect).toHaveBeenCalledWith({ name: `audio-transfer:${TASK_ID}` });
    await ctx.send({ type: "data", epoch: 0, offset: 0, bytes: bufferOf(10, 0) });
    expect(ctx.portMessages()).toEqual([]);

    ctx.lastPort()._onMessage({ type: "ready" });
    const messages = ctx.portMessages();
    expect(messages[0]).toEqual({ type: "begin", taskId: TASK_ID, epoch: 0, itag: 251, mimeType: "audio/webm", totalBytes: 10 });
    expect(messages.slice(1).map((m) => ({ type: m.type, seq: m.seq, offset: m.offset, len: Buffer.from(m.data, "base64").length }))).toEqual([
      { type: "chunk", seq: 0, offset: 0, len: 4 },
      { type: "chunk", seq: 1, offset: 4, len: 4 },
      { type: "chunk", seq: 2, offset: 8, len: 2 },
    ]);
    const joined = Buffer.concat(messages.slice(1).map((m) => Buffer.from(m.data, "base64")));
    expect(new Uint8Array(joined)).toEqual(new Uint8Array(bufferOf(10, 0)));
  });

  test("複数dataでseqは連番、offsetはdataのoffset+分割位置になる", async () => {
    const ctx = await setup({ chunkBytes: 3 });
    await ctx.send(BEGIN);
    ctx.lastPort()._onMessage({ type: "ready" });
    await ctx.send({ type: "data", epoch: 0, offset: 0, bytes: bufferOf(5, 0) });
    await ctx.send({ type: "data", epoch: 0, offset: 5, bytes: bufferOf(4, 5) });
    await ctx.send({ type: "end", epoch: 0, byteLength: 9 });
    const chunks = ctx.portMessages().filter((m) => m.type === "chunk");
    expect(chunks.map((m) => [m.seq, m.offset, Buffer.from(m.data, "base64").length])).toEqual([
      [0, 0, 3],
      [1, 3, 2],
      [2, 5, 3],
      [3, 8, 1],
    ]);
    const end = ctx.portMessages().find((m) => m.type === "end");
    expect(end).toEqual({ type: "end", taskId: TASK_ID, epoch: 0, chunkCount: 4, byteLength: 9 });
  });

  test("offsetが期待値(連続)と一致しないdataは捨てる", async () => {
    const ctx = await setup({ chunkBytes: 4 });
    await ctx.send(BEGIN);
    ctx.lastPort()._onMessage({ type: "ready" });
    await ctx.send({ type: "data", epoch: 0, offset: 0, bytes: bufferOf(4, 0) });
    await ctx.send({ type: "data", epoch: 0, offset: 8, bytes: bufferOf(4, 8) }); // 飛び
    await ctx.send({ type: "data", epoch: 0, offset: 0, bytes: bufferOf(4, 0) }); // 戻り
    await ctx.send({ type: "data", epoch: 0, offset: 4, bytes: bufferOf(4, 4) }); // 正規
    const chunks = ctx.portMessages().filter((m) => m.type === "chunk");
    expect(chunks.map((m) => [m.seq, m.offset])).toEqual([
      [0, 0],
      [1, 4],
    ]);
  });

  test("Portは最初のbeginで1回だけ開く", async () => {
    const ctx = await setup();
    await ctx.send(BEGIN);
    await ctx.send({ ...BEGIN, epoch: 1 });
    expect(ctx.chrome.runtime.connect).toHaveBeenCalledTimes(1);
  });
});

describe("エポック管理", () => {
  test("beginは現エポックより厳密に大きい場合のみ採用し、飛び番も許す", async () => {
    const ctx = await setup({ chunkBytes: 4 });
    await ctx.send(BEGIN);
    ctx.lastPort()._onMessage({ type: "ready" });
    await ctx.send(BEGIN); // 同じ0 → 捨てる
    await ctx.send({ ...BEGIN, epoch: 3 }); // 飛び番 → 採用
    await ctx.send({ ...BEGIN, epoch: 2 }); // 古い → 捨てる
    await ctx.send({ type: "data", epoch: 3, offset: 0, bytes: bufferOf(4, 0) });
    expect(ctx.portMessages().map((m) => [m.type, m.epoch])).toEqual([
      ["begin", 0],
      ["begin", 3],
      ["chunk", 3],
    ]);
  });

  test("data/end/abortは現エポック一致のみ受理し、古い・未来のエポックはどちらも捨てる", async () => {
    const ctx = await setup({ chunkBytes: 4 });
    await ctx.send(BEGIN);
    ctx.lastPort()._onMessage({ type: "ready" });
    await ctx.send({ type: "data", epoch: 0, offset: 0, bytes: bufferOf(4, 0) });
    await ctx.send({ type: "abort", epoch: 0, reason: "restart" });
    await ctx.send({ ...BEGIN, epoch: 1 });
    await ctx.send({ type: "data", epoch: 0, offset: 4, bytes: bufferOf(4, 4) }); // 遅延到着の旧世代
    await ctx.send({ type: "data", epoch: 2, offset: 0, bytes: bufferOf(4, 50) }); // 未来の世代
    await ctx.send({ type: "end", epoch: 2, byteLength: 4 }); // 未来の世代
    await ctx.send({ type: "abort", epoch: 0, reason: "error", code: "X" }); // 旧世代
    await ctx.send({ type: "data", epoch: 1, offset: 0, bytes: bufferOf(4, 100) });
    await ctx.send({ type: "end", epoch: 1, byteLength: 4 });

    const messages = ctx.portMessages();
    expect(messages.map((m) => m.type)).toEqual(["begin", "chunk", "abort", "begin", "chunk", "end"]);
    expect(messages[2]).toEqual({ type: "abort", taskId: TASK_ID, epoch: 0, reason: "restart", code: undefined });
    expect(messages[4]).toMatchObject({ type: "chunk", epoch: 1, seq: 0, offset: 0 });
    expect(new Uint8Array(Buffer.from(messages[4].data, "base64"))).toEqual(new Uint8Array(bufferOf(4, 100)));
    expect(messages[5]).toEqual({ type: "end", taskId: TASK_ID, epoch: 1, chunkCount: 1, byteLength: 4 });
  });
});

describe("status / result", () => {
  test("statusはpage.statusとしてSWへ、resultはpage.resultとして転送する", async () => {
    const ctx = await setup();
    await ctx.send({ type: "status", phase: "download", bytes: 10, totalBytes: 100 });
    await ctx.send({ type: "result", result: { ok: true, byteLength: 100 } });
    expect(ctx.runtimeMessages()).toEqual([
      { type: "page.status", taskId: TASK_ID, phase: "download", bytes: 10, totalBytes: 100 },
      { type: "page.result", taskId: TASK_ID, result: { ok: true, byteLength: 100 } },
    ]);
  });

  test("result処理後は正規のフレームであっても全て捨てる", async () => {
    const ctx = await setup();
    await ctx.send({ type: "result", result: { ok: false, code: "X" } });
    await ctx.send({ type: "status", phase: "download", bytes: 1 });
    await ctx.send({ type: "result", result: { ok: true } });
    await ctx.send(BEGIN);
    expect(ctx.runtimeMessages()).toHaveLength(1);
    expect(ctx.chrome.runtime.connect).not.toHaveBeenCalled();
  });
});

describe("ack転送(背圧)", () => {
  test("Portからのackは署名付き・連番付きフレームとしてwindowへpostMessageする", async () => {
    const ctx = await setup();
    await ctx.send(BEGIN);
    const port = ctx.lastPort();
    port._onMessage({ type: "ready" });
    port._onMessage({ type: "ack", taskId: TASK_ID, epoch: 0, offset: 1024 });
    port._onMessage({ type: "ack", taskId: TASK_ID, epoch: 0, offset: 2048 });
    await ctx.relay.flush();

    const posted = ctx.windowStub.postMessage.mock.calls;
    expect(posted).toHaveLength(2);
    expect(posted[0][1]).toBe(ORIGIN);
    expect(posted[0][0]).toMatchObject({ ns: "yta", v: 1, taskId: TASK_ID, type: "ack", epoch: 0, offset: 1024, n: 0 });
    expect(posted[1][0]).toMatchObject({ type: "ack", offset: 2048, n: 1 });
    for (const [frame] of posted) {
      const { mac, ...header } = frame;
      await expect(verifyFrame(subtle, ctx.key, header, undefined, mac)).resolves.toBe(true);
    }
  });

  test("形状不正なack・別taskIdのackは転送しない", async () => {
    const ctx = await setup();
    await ctx.send(BEGIN);
    const port = ctx.lastPort();
    port._onMessage({ type: "ack", taskId: TASK_ID, epoch: 0, offset: -1 });
    port._onMessage({ type: "ack", taskId: TASK_ID, epoch: 0.5, offset: 1 });
    port._onMessage({ type: "ack", taskId: "other", epoch: 0, offset: 1 });
    await ctx.relay.flush();
    expect(ctx.windowStub.postMessage).not.toHaveBeenCalled();
  });
});

describe("Port切断", () => {
  test("end前の切断はpage.relay.failed(RELAY_PORT_DISCONNECTED)を送り、リスナーを解除する", async () => {
    const ctx = await setup();
    await ctx.send(BEGIN);
    ctx.lastPort()._onDisconnect();
    expect(ctx.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "page.relay.failed",
      taskId: TASK_ID,
      code: RELAY_PORT_DISCONNECTED,
    });
    expect(ctx.windowStub.removeEventListener).toHaveBeenCalled();
  });

  test("end後の切断は失敗として扱わない", async () => {
    const ctx = await setup();
    await ctx.send(BEGIN);
    ctx.lastPort()._onMessage({ type: "ready" });
    await ctx.send({ type: "end", epoch: 0, byteLength: 0 });
    ctx.lastPort()._onDisconnect();
    expect(ctx.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "page.relay.failed" }));
  });

  test("end後の切断はresultを待つ猶予に入り、リスナーを解除しない。届いたresultは中継され、そこで初めて停止する", async () => {
    const ctx = await setup();
    await ctx.send(BEGIN);
    ctx.lastPort()._onMessage({ type: "ready" });
    await ctx.send({ type: "end", epoch: 0, byteLength: 0 });
    ctx.lastPort()._onDisconnect();
    expect(ctx.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "page.relay.failed" }));
    expect(ctx.windowStub.removeEventListener).not.toHaveBeenCalled();

    await ctx.send({ type: "result", result: { ok: true } });
    expect(ctx.runtimeMessages()).toContainEqual({ type: "page.result", taskId: TASK_ID, result: { ok: true } });
    expect(ctx.windowStub.removeEventListener).toHaveBeenCalled();
  });

  test("end後の切断で張り直す猶予タイマーはRESULT_GRACE_MSを使う(通常のidleTimeoutMsではない)", async () => {
    const ctx = await setup();
    await ctx.send(BEGIN);
    ctx.lastPort()._onMessage({ type: "ready" });
    await ctx.send({ type: "end", epoch: 0, byteLength: 0 });
    const armedBefore = ctx.timers.length;
    ctx.lastPort()._onDisconnect();
    expect(ctx.timers.length).toBe(armedBefore + 1);
    expect(ctx.timers[ctx.timers.length - 1].ms).toBe(RESULT_GRACE_MS);
  });

  test("end後の切断でresultが届かないまま猶予タイマーが発火するとRELAY_IDLEを通知して停止する", async () => {
    const ctx = await setup();
    await ctx.send(BEGIN);
    ctx.lastPort()._onMessage({ type: "ready" });
    await ctx.send({ type: "end", epoch: 0, byteLength: 0 });
    ctx.lastPort()._onDisconnect();
    const graceTimer = ctx.timers[ctx.timers.length - 1];
    graceTimer.callback();
    expect(ctx.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "page.relay.failed", taskId: TASK_ID, code: RELAY_IDLE });
    expect(ctx.windowStub.removeEventListener).toHaveBeenCalled();
  });
});

describe("無活動タイムアウト", () => {
  test("既定10分のタイマーを張り、受理したフレームごとに張り直し、発火でRELAY_IDLEを通知してリスナー解除とPort切断を行う", async () => {
    const ctx = await setup();
    expect(ctx.timers[0].ms).toBe(10 * 60 * 1000);
    await ctx.send(BEGIN);
    expect(ctx.timers[0].cleared).toBe(true);
    const latest = ctx.timers[ctx.timers.length - 1];
    latest.callback();
    expect(ctx.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "page.relay.failed", taskId: TASK_ID, code: RELAY_IDLE });
    expect(ctx.windowStub.removeEventListener).toHaveBeenCalled();
    expect(ctx.lastPort().disconnect).toHaveBeenCalled();
  });

  test("検証に落ちたフレームはタイマーを張り直さない", async () => {
    const ctx = await setup();
    const armed = ctx.timers.length;
    ctx.dispatch({ ...(await ctx.signed({ type: "status", phase: "player" }, { n: 0 })), mac: "00".repeat(32) });
    await ctx.relay.flush();
    expect(ctx.timers.length).toBe(armed);
  });

  test("result中継後の発火はRELAY_IDLEを通知しない", async () => {
    const ctx = await setup();
    await ctx.send({ type: "result", result: { ok: true } });
    ctx.timers[ctx.timers.length - 1].callback();
    expect(ctx.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "page.relay.failed" }));
    expect(ctx.windowStub.removeEventListener).toHaveBeenCalled();
  });

  test("stop()は冪等", async () => {
    const ctx = await setup();
    ctx.relay.stop();
    ctx.relay.stop();
    expect(ctx.windowStub.removeEventListener).toHaveBeenCalledTimes(1);
  });
});
