/**
 * @jest-environment node
 */
// opfs.test.mjs
// createOpfsStorageのopen/write/closeが、容量超過・書込み失敗・close失敗を
// 汎用のTRANSFER_INCOMPLETEではなくTRANSFER_WRITE_FAILEDで投げること、
// およびそのcodeがtransfer.mjsの受信機を通ってSWへの通知までそのまま伝わることを検証する。

import { jest } from "@jest/globals";

import { TRANSFER_INCOMPLETE, TRANSFER_WRITE_FAILED } from "./errors.mjs";
import { createOpfsStorage, removeIfExists, tempFileName } from "./opfs.mjs";
import { createTransferReceiver } from "./transfer.mjs";

/**
 * OPFSルート相当のスタブを作る。
 * @param {{onWrite?: () => void, onClose?: () => void, onGetFileHandle?: () => void,
 *   onCreateWritable?: () => void}} [hooks] 失敗を注入するフック
 * @returns {{root: object, removed: string[], writes: Uint8Array[]}} ルートと記録
 */
function createRootStub(hooks = {}) {
  /** @type {string[]} 削除されたエントリ名 */
  const removed = [];
  /** @type {Uint8Array[]} 書き込まれたバイト列 */
  const writes = [];
  const root = {
    async getFileHandle(name, options) {
      if (hooks.onGetFileHandle) {
        hooks.onGetFileHandle();
      }
      return {
        name,
        options,
        async createWritable() {
          if (hooks.onCreateWritable) {
            hooks.onCreateWritable();
          }
          return {
            async write(bytes) {
              if (hooks.onWrite) {
                hooks.onWrite();
              }
              writes.push(bytes);
            },
            async close() {
              if (hooks.onClose) {
                hooks.onClose();
              }
            },
            async abort() {},
          };
        },
        async getFile() {
          return { name, size: writes.reduce((total, bytes) => total + bytes.length, 0) };
        },
      };
    },
    async removeEntry(name) {
      removed.push(name);
    },
  };
  return { root, removed, writes };
}

describe("createOpfsStorage", () => {
  test("open失敗はTRANSFER_WRITE_FAILEDになる", async () => {
    const { root } = createRootStub({
      onGetFileHandle: () => {
        throw new Error("no space");
      },
    });
    const storage = createOpfsStorage(async () => root);
    await expect(storage.open("t1")).rejects.toMatchObject({ code: TRANSFER_WRITE_FAILED, message: "no space" });
  });

  test("createWritable失敗時は作成済みのエントリをrollback削除しTRANSFER_WRITE_FAILEDになる", async () => {
    const { root, removed } = createRootStub({
      onCreateWritable: () => {
        throw new Error("no space");
      },
    });
    const storage = createOpfsStorage(async () => root);
    await expect(storage.open("t1")).rejects.toMatchObject({ code: TRANSFER_WRITE_FAILED, message: "no space" });
    expect(removed).toEqual([tempFileName("t1")]);
  });

  test("getFileHandle失敗時は(エントリ未作成のため)removeEntryを呼ばない", async () => {
    const { root, removed } = createRootStub({
      onGetFileHandle: () => {
        throw new Error("no space");
      },
    });
    const storage = createOpfsStorage(async () => root);
    await expect(storage.open("t1")).rejects.toMatchObject({ code: TRANSFER_WRITE_FAILED, message: "no space" });
    expect(removed).toHaveLength(0);
  });

  test("write失敗(容量超過)はTRANSFER_WRITE_FAILEDになる", async () => {
    const { root } = createRootStub({
      onWrite: () => {
        const error = new Error("Quota exceeded");
        error.name = "QuotaExceededError";
        throw error;
      },
    });
    const storage = createOpfsStorage(async () => root);
    const session = await storage.open("t1");
    await expect(storage.write(session, new Uint8Array([1, 2]))).rejects.toMatchObject({
      code: TRANSFER_WRITE_FAILED,
    });
  });

  test("close失敗はTRANSFER_WRITE_FAILEDになる", async () => {
    const { root } = createRootStub({
      onClose: () => {
        throw new Error("close failed");
      },
    });
    const storage = createOpfsStorage(async () => root);
    const session = await storage.open("t1");
    await expect(storage.close(session)).rejects.toMatchObject({ code: TRANSFER_WRITE_FAILED });
  });

  test("成功時はopen/write/closeがそのまま通る", async () => {
    const { root, writes } = createRootStub();
    const storage = createOpfsStorage(async () => root);
    const session = await storage.open("t1");
    expect(session.name).toBe(tempFileName("t1"));
    await storage.write(session, new Uint8Array([1, 2, 3]));
    const file = await storage.close(session);
    expect(file.size).toBe(3);
    expect(writes).toHaveLength(1);
  });
});

describe("transfer受信機との結線", () => {
  test("OPFS書込み失敗はTRANSFER_INCOMPLETEではなくTRANSFER_WRITE_FAILEDで通知される", async () => {
    const { root } = createRootStub({
      onWrite: () => {
        const error = new Error("Quota exceeded");
        error.name = "QuotaExceededError";
        throw error;
      },
    });
    /** @type {object[]} SWへの通知 */
    const notified = [];
    const receiver = createTransferReceiver(
      { taskId: "t1" },
      {
        storage: createOpfsStorage(async () => root),
        post: () => {},
        notify: (message) => notified.push(message),
        disconnect: () => {},
        onReceived: () => {},
        decode: (text) => new Uint8Array(text.length),
        setTimeout: () => 0,
        clearTimeout: () => {},
      },
    );

    await receiver.handle({ type: "begin", taskId: "t1", epoch: 1 });
    await receiver.handle({ type: "chunk", taskId: "t1", epoch: 1, seq: 0, offset: 0, data: "ab" });

    expect(notified).toEqual([{ type: "audio.transfer.failed", taskId: "t1", code: TRANSFER_WRITE_FAILED }]);
    expect(notified[0].code).not.toBe(TRANSFER_INCOMPLETE);
  });
});

describe("removeIfExists", () => {
  test("存在しないファイルでも例外にならない", async () => {
    const removeEntry = jest.fn(async () => {
      const error = new Error("not found");
      error.name = "NotFoundError";
      throw error;
    });
    await expect(removeIfExists(async () => ({ removeEntry }), "out-x.mp3")).resolves.toBeUndefined();
    expect(removeEntry).toHaveBeenCalledWith("out-x.mp3");
  });
});
