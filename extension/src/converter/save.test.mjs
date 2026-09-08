/**
 * @jest-environment node
 */
// save.test.mjs
// resolveDestinationが返す書き出し先の、失敗時ロールバック(discard)の挙動を検証する。
// 保存先ディレクトリ指定時はopen()で作ったエントリを消し、未指定時(ダウンロードフォルダ)は
// OPFS上の変換出力一時ファイルを消す。

import { jest } from "@jest/globals";

import { SAVE_PERMISSION_DENIED } from "./errors.mjs";
import { outputFileName } from "./opfs.mjs";
import { resolveDestination } from "./save.mjs";

/**
 * 保存先ディレクトリハンドルのスタブを作る。
 * @param {{existing?: string[], permission?: string}} [options] 既存ファイル名と権限
 * @returns {object} ディレクトリハンドルのスタブ
 */
function createDirectoryStub(options = {}) {
  const existing = new Set(options.existing ?? []);
  return {
    name: "Music",
    created: [],
    removed: [],
    createWritableCalls: 0,
    async queryPermission() {
      return options.permission ?? "granted";
    },
    async getFileHandle(name, opts) {
      if (!existing.has(name)) {
        if (!opts || opts.create !== true) {
          const error = new Error("not found");
          error.name = "NotFoundError";
          throw error;
        }
        existing.add(name);
        this.created.push(name);
      }
      const self = this;
      return {
        async createWritable() {
          self.createWritableCalls += 1;
          return { async write() {}, async close() {}, async abort() {} };
        },
      };
    },
    async removeEntry(name) {
      if (!existing.delete(name)) {
        const error = new Error("not found");
        error.name = "NotFoundError";
        throw error;
      }
      this.removed.push(name);
    },
  };
}

/**
 * OPFSルートのスタブを作る。
 * @returns {{root: object, removed: string[]}} ルートと削除記録
 */
function createRootStub() {
  const files = new Set();
  /** @type {string[]} 削除されたファイル名 */
  const removed = [];
  const root = {
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (!opts || opts.create !== true) {
          const error = new Error("not found");
          error.name = "NotFoundError";
          throw error;
        }
        files.add(name);
      }
      return {
        async createWritable() {
          return { async write() {}, async close() {}, async abort() {} };
        },
        async getFile() {
          return { name, size: 1 };
        },
      };
    },
    async removeEntry(name) {
      files.delete(name);
      removed.push(name);
    },
  };
  return { root, removed };
}

describe("resolveDestination(保存先ディレクトリ指定)", () => {
  test("open()後のdiscard()はエントリを削除する", async () => {
    const directoryHandle = createDirectoryStub();
    const destination = await resolveDestination(
      { taskId: "t1", fileName: "song.mp3", extension: "mp3" },
      { directoryHandle, getRoot: async () => ({}) },
    );

    await destination.open();
    expect(directoryHandle.created).toEqual(["song.mp3"]);

    await destination.discard();
    expect(directoryHandle.removed).toEqual(["song.mp3"]);
  });

  test("open()前のdiscard()は何もしない", async () => {
    const directoryHandle = createDirectoryStub();
    const destination = await resolveDestination(
      { taskId: "t1", fileName: "song.mp3", extension: "mp3" },
      { directoryHandle, getRoot: async () => ({}) },
    );

    await destination.discard();
    expect(directoryHandle.removed).toEqual([]);
  });

  test("createWritable失敗でも作られた空エントリをdiscard()で消せる", async () => {
    const directoryHandle = createDirectoryStub();
    const destination = await resolveDestination(
      { taskId: "t1", fileName: "song.mp3", extension: "mp3" },
      { directoryHandle, getRoot: async () => ({}) },
    );
    const originalGetFileHandle = directoryHandle.getFileHandle.bind(directoryHandle);
    directoryHandle.getFileHandle = async (name, opts) => {
      await originalGetFileHandle(name, opts);
      return {
        async createWritable() {
          throw new Error("locked");
        },
      };
    };

    await expect(destination.open()).rejects.toThrow("locked");
    await destination.discard();
    expect(directoryHandle.removed).toEqual(["song.mp3"]);
  });

  test("同名ファイルがあればskippedになり書き込みも削除も行わない", async () => {
    const directoryHandle = createDirectoryStub({ existing: ["song.mp3"] });
    const destination = await resolveDestination(
      { taskId: "t1", fileName: "song.mp3", extension: "mp3" },
      { directoryHandle, getRoot: async () => ({}) },
    );

    expect(destination).toMatchObject({ skipped: true, fileName: "song.mp3", dirName: "Music" });
    expect(destination.discard).toBeUndefined();
  });

  test("権限が無ければSAVE_PERMISSION_DENIEDになる", async () => {
    const directoryHandle = createDirectoryStub({ permission: "prompt" });
    await expect(
      resolveDestination(
        { taskId: "t1", fileName: "song.mp3", extension: "mp3" },
        { directoryHandle, getRoot: async () => ({}) },
      ),
    ).rejects.toMatchObject({ code: SAVE_PERMISSION_DENIED });
  });
});

describe("resolveDestination(保存先未選択)", () => {
  test("finish()はdownloadUrlとtempNameを返し、discard()は出力一時ファイルを消す", async () => {
    const { root, removed } = createRootStub();
    const createObjectURL = jest.fn(() => "blob:fake");
    const original = globalThis.URL.createObjectURL;
    globalThis.URL.createObjectURL = createObjectURL;
    try {
      const destination = await resolveDestination(
        { taskId: "t1", fileName: "song.mp3", extension: "mp3" },
        { directoryHandle: null, getRoot: async () => root },
      );

      await destination.open();
      const result = await destination.finish();
      expect(result).toMatchObject({
        fileName: "song.mp3",
        dirName: null,
        downloadUrl: "blob:fake",
        tempName: outputFileName("t1", "mp3"),
      });

      await destination.discard();
      expect(removed).toEqual([outputFileName("t1", "mp3")]);
    } finally {
      globalThis.URL.createObjectURL = original;
    }
  });

  test("finding14: SWがexists:trueを返せばskippedになりOPFSへは何も書かない", async () => {
    const { root } = createRootStub();
    const getFileHandleSpy = jest.spyOn(root, "getFileHandle");
    global.chrome = { runtime: { sendMessage: jest.fn(() => Promise.resolve({ exists: true })) } };
    try {
      const destination = await resolveDestination(
        { taskId: "t1", fileName: "song.mp3", extension: "mp3" },
        { directoryHandle: null, getRoot: async () => root },
      );

      expect(destination).toMatchObject({ skipped: true, fileName: "song.mp3", dirName: null });
      expect(destination.open).toBeUndefined();
      expect(getFileHandleSpy).not.toHaveBeenCalled();
      expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "downloads.checkExists",
        fileName: "song.mp3",
      });
    } finally {
      delete global.chrome;
    }
  });

  test("finding14: SWがexists:falseを返せば通常どおりOPFSへ書く", async () => {
    const { root, removed } = createRootStub();
    global.chrome = { runtime: { sendMessage: jest.fn(() => Promise.resolve({ exists: false })) } };
    const createObjectURL = jest.fn(() => "blob:fake");
    const original = globalThis.URL.createObjectURL;
    globalThis.URL.createObjectURL = createObjectURL;
    try {
      const destination = await resolveDestination(
        { taskId: "t1", fileName: "song.mp3", extension: "mp3" },
        { directoryHandle: null, getRoot: async () => root },
      );

      expect(destination.skipped).toBe(false);
      await destination.open();
      const result = await destination.finish();
      expect(result).toMatchObject({ fileName: "song.mp3", dirName: null, downloadUrl: "blob:fake" });
    } finally {
      globalThis.URL.createObjectURL = original;
      delete global.chrome;
    }
  });

  test("finding14: SWへの照会自体が失敗(chrome未定義等)しても衝突なし扱いで通常フローに進む", async () => {
    const { root } = createRootStub();
    const destination = await resolveDestination(
      { taskId: "t1", fileName: "song.mp3", extension: "mp3" },
      { directoryHandle: null, getRoot: async () => root },
    );

    expect(destination.skipped).toBe(false);
  });
});
