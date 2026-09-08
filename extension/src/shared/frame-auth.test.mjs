/**
 * @jest-environment node
 */
// frame-auth.test.mjs
// HMACフレーム署名の往復、改竄検知(ヘッダ・ペイロード)、鍵不一致、MAC形式不正、
// hex変換、非負整数判定のテスト。

import { webcrypto } from "node:crypto";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  importFrameKey,
  isNonNegativeInteger,
  isPayloadField,
  signFrame,
  verifyFrame,
} from "./frame-auth.mjs";

const subtle = webcrypto.subtle;
const SECRET = "0123456789abcdef".repeat(4);

describe("hex変換", () => {
  test("hexToBytes/bytesToHexは往復する", () => {
    const bytes = hexToBytes("00ff10aB");
    expect(Array.from(bytes)).toEqual([0, 255, 16, 171]);
    expect(bytesToHex(bytes)).toBe("00ff10ab");
  });

  test("奇数長・非hex文字は拒否する", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
    expect(() => hexToBytes(123)).toThrow();
  });

  test("concatBytesは順序を保って連結する", () => {
    expect(Array.from(concatBytes(new Uint8Array([1, 2]), new Uint8Array([3])))).toEqual([1, 2, 3]);
  });
});

describe("signFrame / verifyFrame", () => {
  test("ペイロード無しのフレームは署名・検証が往復する", async () => {
    const key = await importFrameKey(subtle, SECRET);
    const frame = { ns: "yta", v: 1, taskId: "t", type: "status", phase: "player", n: 0 };
    const mac = await signFrame(subtle, key, frame, undefined);
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyFrame(subtle, key, frame, undefined, mac)).resolves.toBe(true);
  });

  test("bytesペイロード付きのフレームはペイロードもMACの対象になる", async () => {
    const key = await importFrameKey(subtle, SECRET);
    const payload = new Uint8Array([1, 2, 3, 4]);
    const frame = { ns: "yta", v: 1, taskId: "t", type: "data", epoch: 0, offset: 0, bytes: payload.buffer, n: 3 };
    const mac = await signFrame(subtle, key, frame, payload);
    await expect(verifyFrame(subtle, key, frame, payload, mac)).resolves.toBe(true);
    await expect(verifyFrame(subtle, key, frame, new Uint8Array([1, 2, 3, 5]), mac)).resolves.toBe(false);
    await expect(verifyFrame(subtle, key, frame, undefined, mac)).resolves.toBe(false);
  });

  test("ヘッダのmac/bytesフィールドはMAC計算から除外される", async () => {
    const key = await importFrameKey(subtle, SECRET);
    const payload = new Uint8Array([9]);
    const frame = { ns: "yta", v: 1, taskId: "t", type: "data", epoch: 0, offset: 0, bytes: payload.buffer, n: 0 };
    const mac = await signFrame(subtle, key, frame, payload);
    const withMac = { ...frame, mac, bytes: new Uint8Array([7]).buffer };
    await expect(verifyFrame(subtle, key, withMac, payload, mac)).resolves.toBe(true);
  });

  test("statusフレームのbytes(進捗バイト数)はペイロードではなくヘッダとしてMACの対象になる", async () => {
    const key = await importFrameKey(subtle, SECRET);
    const frame = { ns: "yta", v: 1, taskId: "t", type: "status", phase: "download", bytes: 10, totalBytes: 100, n: 2 };
    const mac = await signFrame(subtle, key, frame, undefined);
    await expect(verifyFrame(subtle, key, frame, undefined, mac)).resolves.toBe(true);
    await expect(verifyFrame(subtle, key, { ...frame, bytes: 11 }, undefined, mac)).resolves.toBe(false);
    expect(isPayloadField(frame, "bytes")).toBe(false);
    expect(isPayloadField({ type: "data" }, "bytes")).toBe(true);
  });

  test("ヘッダ改竄はMAC不一致になる", async () => {
    const key = await importFrameKey(subtle, SECRET);
    const frame = { ns: "yta", v: 1, taskId: "t", type: "end", epoch: 0, byteLength: 10, n: 5 };
    const mac = await signFrame(subtle, key, frame, undefined);
    await expect(verifyFrame(subtle, key, { ...frame, byteLength: 11 }, undefined, mac)).resolves.toBe(false);
    await expect(verifyFrame(subtle, key, { ...frame, n: 6 }, undefined, mac)).resolves.toBe(false);
    await expect(verifyFrame(subtle, key, { ...frame, taskId: "other" }, undefined, mac)).resolves.toBe(false);
  });

  test("別の秘密で作った鍵では検証に失敗する", async () => {
    const key = await importFrameKey(subtle, SECRET);
    const otherKey = await importFrameKey(subtle, "ff".repeat(32));
    const frame = { ns: "yta", v: 1, taskId: "t", type: "result", result: { ok: true }, n: 0 };
    const mac = await signFrame(subtle, key, frame, undefined);
    await expect(verifyFrame(subtle, otherKey, frame, undefined, mac)).resolves.toBe(false);
  });

  test("MACが文字列でない・長さ不正・非hexなら検証せずfalse", async () => {
    const key = await importFrameKey(subtle, SECRET);
    const frame = { ns: "yta", v: 1, taskId: "t", type: "status", phase: "x", n: 0 };
    await expect(verifyFrame(subtle, key, frame, undefined, undefined)).resolves.toBe(false);
    await expect(verifyFrame(subtle, key, frame, undefined, "abcd")).resolves.toBe(false);
    await expect(verifyFrame(subtle, key, frame, undefined, "zz".repeat(32))).resolves.toBe(false);
  });

  test("importFrameKeyは不正なhexを拒否する", async () => {
    await expect(importFrameKey(subtle, "not-hex")).rejects.toThrow();
    await expect(importFrameKey(subtle, undefined)).rejects.toThrow();
  });
});

describe("isNonNegativeInteger", () => {
  test("有限の非負整数のみtrue", () => {
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(42)).toBe(true);
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isNonNegativeInteger(Number.NaN)).toBe(false);
    expect(isNonNegativeInteger(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNonNegativeInteger("1")).toBe(false);
    expect(isNonNegativeInteger(null)).toBe(false);
    expect(isNonNegativeInteger(undefined)).toBe(false);
  });
});
