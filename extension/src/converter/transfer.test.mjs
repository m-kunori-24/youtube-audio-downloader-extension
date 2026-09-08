/**
 * @jest-environment node
 */
// transfer.test.mjs
// Port経由の分割転送受信(Gap2 §3/§4)のテスト。
// エポック厳密管理(beginは厳密増加、chunk/end/abortは一致のみ)・数値フィールド検証・
// seq/offset検証・end整合検証・abort(restartのみ非終了、他は全て終了)・ack送出・無活動タイムアウトを確認する。
// OPFSはメモリ上のフェイクストレージ、chrome APIは注入したスタブ関数で置き換える。

import { jest } from "@jest/globals";
import { createTransferReceiver } from "./transfer.mjs";
import { ABORT_REASONS } from "../shared/abort-reasons.mjs";
import {
  TRANSFER_INCOMPLETE,
  TRANSFER_OFFSET_MISMATCH,
  TRANSFER_SEQ_GAP,
  TRANSFER_SIZE_MISMATCH,
  TRANSFER_WRITE_FAILED,
  codedError,
} from "./errors.mjs";

const TASK_ID = "task-1";

/**
 * OPFSの代わりに使うメモリ上のフェイクストレージを作る。
 * @returns {object} storage実装と検査用の履歴
 */
function createFakeStorage() {
  const opened = [];
  const discarded = [];
  const closed = [];
  return {
    opened,
    discarded,
    closed,
    storage: {
      open: jest.fn(async () => {
        const session = { name: `audio-${TASK_ID}.bin`, chunks: [] };
        opened.push(session);
        return session;
      }),
      write: jest.fn(async (session, bytes) => {
        session.chunks.push(bytes);
      }),
      close: jest.fn(async (session) => {
        closed.push(session);
        const total = session.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        return { size: total, name: session.name };
      }),
      discard: jest.fn(async (session) => {
        discarded.push(session);
      }),
    },
  };
}

/**
 * 受信機とその周辺スタブを組み立てる。
 * @param {object} [options] inactivityTimeoutMsの上書き
 * @returns {object} テスト用ハンドル群
 */
function setup(options = {}) {
  const fake = createFakeStorage();
  const posted = [];
  const notified = [];
  const received = [];
  const disconnect = jest.fn();
  const timers = [];
  const setTimeoutFn = jest.fn((callback, ms) => {
    const handle = { callback, ms, cleared: false };
    timers.push(handle);
    return handle;
  });
  const clearTimeoutFn = jest.fn((handle) => {
    handle.cleared = true;
  });

  const receiver = createTransferReceiver(
    { taskId: TASK_ID },
    {
      storage: fake.storage,
      post: (message) => posted.push(message),
      notify: (message) => notified.push(message),
      disconnect,
      onReceived: (taskId, file) => received.push({ taskId, file }),
      // base64復号は別モジュールで検証済みのため、テストでは長さだけを持つ疑似復号を使う。
      decode: (text) => new Uint8Array(Number(text)),
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
      ...options,
    },
  );

  /**
   * 未解除の最新タイマーを発火させる。
   * @returns {void}
   */
  function fireIdleTimer() {
    for (let index = timers.length - 1; index >= 0; index -= 1) {
      if (!timers[index].cleared) {
        timers[index].cleared = true;
        timers[index].callback();
        return;
      }
    }
  }

  return { receiver, fake, posted, notified, received, disconnect, timers, fireIdleTimer };
}

/**
 * beginフレームを作る。
 * @param {number} epoch エポック番号
 * @returns {object} フレーム
 */
function begin(epoch) {
  return { type: "begin", taskId: TASK_ID, epoch, itag: 251, mimeType: "audio/webm", totalBytes: 0 };
}

/**
 * chunkフレームを作る。dataは「バイト数」を文字列で表す疑似base64。
 * @param {number} epoch エポック番号
 * @param {number} seq 連番
 * @param {number} offset 書込み位置
 * @param {number} size バイト数
 * @returns {object} フレーム
 */
function chunk(epoch, seq, offset, size) {
  return { type: "chunk", taskId: TASK_ID, epoch, seq, offset, data: String(size) };
}

/**
 * endフレームを作る。
 * @param {number} epoch エポック番号
 * @param {number} chunkCount chunk数
 * @param {number} byteLength 総バイト数
 * @returns {object} フレーム
 */
function end(epoch, chunkCount, byteLength) {
  return { type: "end", taskId: TASK_ID, epoch, chunkCount, byteLength };
}

describe("createTransferReceiver: 正常系", () => {
  test("begin→chunk×2→endでFileが確定し、received/完了通知が出る", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    await ctx.receiver.handle(chunk(0, 1, 10, 5));
    await ctx.receiver.handle(end(0, 2, 15));

    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0].file.size).toBe(15);
    expect(ctx.posted).toContainEqual({ type: "received", taskId: TASK_ID, epoch: 0, byteLength: 15 });
    expect(ctx.notified).toContainEqual({
      type: "audio.transfer.complete",
      taskId: TASK_ID,
      epoch: 0,
      byteLength: 15,
    });
    expect(ctx.disconnect).toHaveBeenCalled();
  });

  test("taskIdが一致しないフレームは無視する", async () => {
    const ctx = setup();
    await ctx.receiver.handle({ ...begin(0), taskId: "other" });
    expect(ctx.fake.opened).toHaveLength(0);
  });
});

describe("createTransferReceiver: エポック管理", () => {
  test("古いエポックのchunkは黙って捨てる", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(1));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    expect(ctx.fake.storage.write).not.toHaveBeenCalled();
    expect(ctx.notified).toHaveLength(0);
    expect(ctx.receiver.state()).toMatchObject({ epoch: 1, seq: 0, bytesWritten: 0 });
  });

  test("古いエポックのendは黙って捨てる", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(2));
    await ctx.receiver.handle(end(1, 0, 0));
    expect(ctx.notified).toHaveLength(0);
    expect(ctx.received).toHaveLength(0);
  });

  test("より新しいエポックのbeginでカウンタと一時ファイルがリセットされる", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    await ctx.receiver.handle(begin(1));

    expect(ctx.fake.discarded).toHaveLength(1);
    expect(ctx.fake.opened).toHaveLength(2);
    expect(ctx.receiver.state()).toMatchObject({ epoch: 1, seq: 0, bytesWritten: 0 });

    await ctx.receiver.handle(chunk(1, 0, 0, 7));
    await ctx.receiver.handle(end(1, 1, 7));
    expect(ctx.received[0].file.size).toBe(7);
  });

  test("古いエポックのbeginは採用しない", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(3));
    await ctx.receiver.handle(begin(2));
    expect(ctx.fake.opened).toHaveLength(1);
    expect(ctx.receiver.state().epoch).toBe(3);
  });

  test("同じエポックのbeginは採用せず、飛び番のbeginは採用する", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    await ctx.receiver.handle(begin(0));
    expect(ctx.fake.opened).toHaveLength(1);
    expect(ctx.receiver.state()).toMatchObject({ epoch: 0, seq: 1, bytesWritten: 10 });

    await ctx.receiver.handle(begin(5));
    expect(ctx.fake.opened).toHaveLength(2);
    expect(ctx.receiver.state()).toMatchObject({ epoch: 5, seq: 0, bytesWritten: 0 });
  });

  test("未来のエポックのchunk/end/abortは黙って捨てる", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(1));
    await ctx.receiver.handle(chunk(2, 0, 0, 10));
    await ctx.receiver.handle(end(2, 0, 0));
    await ctx.receiver.handle({ type: "abort", taskId: TASK_ID, epoch: 2, reason: "error" });
    expect(ctx.fake.storage.write).not.toHaveBeenCalled();
    expect(ctx.notified).toHaveLength(0);
    expect(ctx.received).toHaveLength(0);
    expect(ctx.receiver.state()).toMatchObject({ epoch: 1, closed: false });
  });

  test("epoch/seq/offset/byteLength/chunkCountが非負整数でないフレームは黙って捨てる", async () => {
    const ctx = setup();
    await ctx.receiver.handle({ ...begin(0), epoch: 1.5 });
    await ctx.receiver.handle({ ...begin(0), epoch: -1 });
    await ctx.receiver.handle({ ...begin(0), epoch: Number.NaN });
    await ctx.receiver.handle({ ...begin(0), epoch: "0" });
    expect(ctx.fake.opened).toHaveLength(0);

    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle({ ...chunk(0, 0, 0, 10), seq: -1 });
    await ctx.receiver.handle({ ...chunk(0, 0, 0, 10), offset: 0.5 });
    await ctx.receiver.handle({ ...chunk(0, 0, 0, 10), offset: Number.POSITIVE_INFINITY });
    await ctx.receiver.handle({ ...end(0, 0, 0), byteLength: Number.NaN });
    await ctx.receiver.handle({ ...end(0, 0, 0), chunkCount: -2 });
    expect(ctx.fake.storage.write).not.toHaveBeenCalled();
    expect(ctx.notified).toHaveLength(0);
    expect(ctx.received).toHaveLength(0);
    expect(ctx.receiver.state()).toMatchObject({ epoch: 0, seq: 0, bytesWritten: 0, closed: false });
  });
});

describe("createTransferReceiver: ack(背圧)", () => {
  test("chunkを書き込むたびに累積offsetを載せたackをPortへ返す", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    await ctx.receiver.handle(chunk(0, 1, 10, 5));
    expect(ctx.posted).toEqual([
      { type: "ack", taskId: TASK_ID, epoch: 0, offset: 10 },
      { type: "ack", taskId: TASK_ID, epoch: 0, offset: 15 },
    ]);
  });

  test("捨てたchunk・失敗したchunkにはackを返さない", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(1));
    await ctx.receiver.handle(chunk(0, 0, 0, 10)); // 旧エポック
    await ctx.receiver.handle(chunk(1, 3, 0, 10)); // seq飛び → 失敗
    expect(ctx.posted.filter((m) => m.type === "ack")).toHaveLength(0);
  });
});

describe("createTransferReceiver: フレーム検証", () => {
  test("seq飛びはTRANSFER_SEQ_GAPで失敗する", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    await ctx.receiver.handle(chunk(0, 2, 10, 10));

    expect(ctx.notified).toContainEqual({
      type: "audio.transfer.failed",
      taskId: TASK_ID,
      code: TRANSFER_SEQ_GAP,
    });
    expect(ctx.fake.discarded).toHaveLength(1);
    expect(ctx.disconnect).toHaveBeenCalled();
  });

  test("offset不一致はTRANSFER_OFFSET_MISMATCHで失敗する", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    await ctx.receiver.handle(chunk(0, 1, 11, 10));

    expect(ctx.notified).toContainEqual({
      type: "audio.transfer.failed",
      taskId: TASK_ID,
      code: TRANSFER_OFFSET_MISMATCH,
    });
  });

  test("byteLength不一致はTRANSFER_SIZE_MISMATCHで失敗する", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    await ctx.receiver.handle(end(0, 1, 99));

    expect(ctx.notified).toContainEqual({
      type: "audio.transfer.failed",
      taskId: TASK_ID,
      code: TRANSFER_SIZE_MISMATCH,
    });
    expect(ctx.received).toHaveLength(0);
  });

  test("chunkCount不一致はTRANSFER_INCOMPLETEで失敗する", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    await ctx.receiver.handle(end(0, 5, 10));

    expect(ctx.notified).toContainEqual({
      type: "audio.transfer.failed",
      taskId: TASK_ID,
      code: TRANSFER_INCOMPLETE,
    });
  });

  test("begin前のend(エポック不一致)は黙って捨てる", async () => {
    const ctx = setup();
    await ctx.receiver.handle(end(0, 0, 0));
    expect(ctx.notified).toHaveLength(0);
    expect(ctx.received).toHaveLength(0);
    expect(ctx.receiver.state().closed).toBe(false);
  });

  test("restart後(一時ファイル破棄済み)の同エポックendはTRANSFER_INCOMPLETEで失敗する", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle({ type: "abort", taskId: TASK_ID, epoch: 0, reason: "restart" });
    await ctx.receiver.handle(end(0, 0, 0));
    expect(ctx.notified).toContainEqual({
      type: "audio.transfer.failed",
      taskId: TASK_ID,
      code: TRANSFER_INCOMPLETE,
    });
  });

  test("begin前のchunkは黙って捨てる", async () => {
    const ctx = setup();
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    expect(ctx.notified).toHaveLength(0);
    expect(ctx.fake.storage.write).not.toHaveBeenCalled();
  });

  test("失敗後のフレームは処理しない", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 3, 0, 10));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    await ctx.receiver.handle(end(0, 1, 10));

    expect(ctx.notified).toHaveLength(1);
    expect(ctx.received).toHaveLength(0);
  });
});

describe("createTransferReceiver: close失敗", () => {
  test("storage.closeが失敗したらセッションは破棄され、成功系の通知は出ない", async () => {
    const ctx = setup();
    ctx.fake.storage.close.mockImplementationOnce(async () => {
      throw codedError(TRANSFER_WRITE_FAILED, "close failed");
    });
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    await ctx.receiver.handle(end(0, 1, 10));

    expect(ctx.notified).toEqual([{ type: "audio.transfer.failed", taskId: TASK_ID, code: TRANSFER_WRITE_FAILED }]);
    expect(ctx.fake.discarded).toHaveLength(1);
    expect(ctx.fake.discarded[0]).toBe(ctx.fake.opened[0]);
    expect(ctx.disconnect).toHaveBeenCalled();
    expect(ctx.posted.some((message) => message.type === "received")).toBe(false);
    expect(ctx.received).toHaveLength(0);
  });
});

describe("createTransferReceiver: abort", () => {
  test("reason=restartは一時ファイルを捨てて次のbeginを待つ", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));
    await ctx.receiver.handle({ type: "abort", taskId: TASK_ID, epoch: 0, reason: "restart" });

    expect(ctx.fake.discarded).toHaveLength(1);
    expect(ctx.notified).toHaveLength(0);
    expect(ctx.disconnect).not.toHaveBeenCalled();
    expect(ctx.receiver.state()).toMatchObject({ seq: 0, bytesWritten: 0, closed: false });

    await ctx.receiver.handle(begin(1));
    await ctx.receiver.handle(chunk(1, 0, 0, 4));
    await ctx.receiver.handle(end(1, 1, 4));
    expect(ctx.received[0].file.size).toBe(4);
  });

  test("reason=failedはcodeをそのままSWへ通知する", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle({
      type: "abort",
      taskId: TASK_ID,
      epoch: 0,
      reason: "failed",
      code: "SABR_FETCH_FAILED",
    });

    expect(ctx.notified).toContainEqual({
      type: "audio.transfer.failed",
      taskId: TASK_ID,
      code: "SABR_FETCH_FAILED",
    });
    expect(ctx.fake.discarded).toHaveLength(1);
    expect(ctx.disconnect).toHaveBeenCalled();
  });

  test("reason=failedでcode未指定ならTRANSFER_INCOMPLETEにする", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle({ type: "abort", taskId: TASK_ID, epoch: 0, reason: "failed" });
    expect(ctx.notified[0].code).toBe(TRANSFER_INCOMPLETE);
  });

  test("reason=error(page-agentが送る終了理由)はcodeをそのままSWへ通知して終了する", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle({ type: "abort", taskId: TASK_ID, epoch: 0, reason: ABORT_REASONS.ERROR, code: "FETCH_STALLED" });
    expect(ctx.notified).toContainEqual({ type: "audio.transfer.failed", taskId: TASK_ID, code: "FETCH_STALLED" });
    expect(ctx.fake.discarded).toHaveLength(1);
    expect(ctx.disconnect).toHaveBeenCalled();
    expect(ctx.receiver.state().closed).toBe(true);
  });

  test("restart以外の未知のreasonも終了として扱う", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle({ type: "abort", taskId: TASK_ID, epoch: 0, reason: "something-else" });
    expect(ctx.notified[0].code).toBe(TRANSFER_INCOMPLETE);
    expect(ctx.receiver.state().closed).toBe(true);
  });

  test("ABORT_REASONS.RESTARTは共有定数の値'restart'であり、receiverはこの値だけを非終了として扱う", async () => {
    expect(ABORT_REASONS.RESTART).toBe("restart");
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle({ type: "abort", taskId: TASK_ID, epoch: 0, reason: ABORT_REASONS.RESTART });
    expect(ctx.notified).toHaveLength(0);
    expect(ctx.receiver.state().closed).toBe(false);
  });

  test("エポック不一致のabortは黙って捨てる", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(1));
    await ctx.receiver.handle({ type: "abort", taskId: TASK_ID, epoch: 0, reason: "error", code: "X" });
    expect(ctx.notified).toHaveLength(0);
    expect(ctx.fake.discarded).toHaveLength(0);
    expect(ctx.receiver.state()).toMatchObject({ epoch: 1, closed: false });
  });
});

describe("createTransferReceiver: 無活動タイムアウト・破棄", () => {
  test("beginのあとendが来ないままタイムアウトするとTRANSFER_INCOMPLETE", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    expect(ctx.timers[0].ms).toBe(120 * 1000);

    ctx.fireIdleTimer();
    await ctx.receiver.handle({ type: "noop", taskId: TASK_ID });

    expect(ctx.notified).toContainEqual({
      type: "audio.transfer.failed",
      taskId: TASK_ID,
      code: TRANSFER_INCOMPLETE,
    });
    expect(ctx.fake.discarded).toHaveLength(1);
  });

  test("end完了後はタイマーが解除されている", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(end(0, 0, 0));
    expect(ctx.timers.every((timer) => timer.cleared)).toBe(true);
  });

  test("disposeは未完了の一時ファイルを削除する", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.dispose();
    expect(ctx.fake.discarded).toHaveLength(1);
    expect(ctx.receiver.state().closed).toBe(true);
  });

  test("完了後のdisposeは何もしない", async () => {
    const ctx = setup();
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(end(0, 0, 0));
    await ctx.receiver.dispose();
    expect(ctx.fake.discarded).toHaveLength(0);
  });

  test("書込みが例外を投げたら転送失敗として畳む", async () => {
    const ctx = setup();
    ctx.fake.storage.write.mockImplementationOnce(async () => {
      throw new Error("quota exceeded");
    });
    await ctx.receiver.handle(begin(0));
    await ctx.receiver.handle(chunk(0, 0, 0, 10));

    expect(ctx.notified).toContainEqual({
      type: "audio.transfer.failed",
      taskId: TASK_ID,
      code: TRANSFER_INCOMPLETE,
    });
    expect(ctx.disconnect).toHaveBeenCalled();
  });
});
