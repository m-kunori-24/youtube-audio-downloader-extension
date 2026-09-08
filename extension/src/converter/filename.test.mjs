/**
 * @jest-environment node
 */
// filename.test.mjs
// ファイル名の無害化と、同名ファイル既存時のスキップ判定(Q5)のテスト。
// FileSystemDirectoryHandleはgetFileHandleだけを持つ最小スタブで置き換える。

import { jest } from "@jest/globals";
import { MAX_FILE_NAME_LENGTH, fileExists, sanitizeFileName } from "./filename.mjs";

/**
 * NotFoundErrorを模した例外を作る。
 * @returns {Error} nameが"NotFoundError"のError
 */
function notFoundError() {
  const error = new Error("not found");
  error.name = "NotFoundError";
  return error;
}

describe("sanitizeFileName", () => {
  test("使用不可文字を_へ置換する", () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j.mp3')).toBe("a_b_c_d_e_f_g_h_i_j.mp3");
  });

  test("制御文字を_へ置換する", () => {
    const name = `a${String.fromCharCode(1)}b${String.fromCharCode(31)}c.mp3`;
    expect(sanitizeFileName(name)).toBe("a_b_c.mp3");
  });

  test("通常の空白・ハイフン・日本語はそのまま残す", () => {
    expect(sanitizeFileName("【公式】曲名 - アーティスト.mp3")).toBe("【公式】曲名 - アーティスト.mp3");
  });

  test("末尾のドット・空白を除去する", () => {
    expect(sanitizeFileName("song.mp3...")).toBe("song.mp3");
    expect(sanitizeFileName("song.mp3   ")).toBe("song.mp3");
  });

  test("空・非文字列はaudioへフォールバックする", () => {
    expect(sanitizeFileName("")).toBe("audio");
    expect(sanitizeFileName("   ")).toBe("audio");
    expect(sanitizeFileName(undefined)).toBe("audio");
    expect(sanitizeFileName(123)).toBe("audio");
  });

  test("長すぎる名前は拡張子を保ったまま切り詰める", () => {
    const long = `${"あ".repeat(400)}.mp3`;
    const result = sanitizeFileName(long);
    expect(result.length).toBe(MAX_FILE_NAME_LENGTH);
    expect(result.endsWith(".mp3")).toBe(true);
  });

  test("上限以下の名前は切り詰めない", () => {
    const name = `${"a".repeat(100)}.flac`;
    expect(sanitizeFileName(name)).toBe(name);
  });
});

describe("fileExists", () => {
  test("getFileHandleが成功すればtrue", async () => {
    const directoryHandle = { getFileHandle: jest.fn(() => Promise.resolve({})) };
    await expect(fileExists(directoryHandle, "song.mp3")).resolves.toBe(true);
    expect(directoryHandle.getFileHandle).toHaveBeenCalledWith("song.mp3", { create: false });
  });

  test("NotFoundErrorはfalse(存在しない)として扱う", async () => {
    const directoryHandle = { getFileHandle: jest.fn(() => Promise.reject(notFoundError())) };
    await expect(fileExists(directoryHandle, "song.mp3")).resolves.toBe(false);
  });

  test("NotFoundError以外の例外はそのまま投げ直す", async () => {
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    const directoryHandle = { getFileHandle: jest.fn(() => Promise.reject(denied)) };
    await expect(fileExists(directoryHandle, "song.mp3")).rejects.toThrow("denied");
  });
});
