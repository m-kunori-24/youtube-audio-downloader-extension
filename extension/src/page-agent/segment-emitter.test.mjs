/**
 * @jest-environment node
 */
// segment-emitter.test.mjs
// 1MiBカーソル方式の分割送出(data/begin/end)、背圧ゲート(16MiBウィンドウ)、statusの1秒間引きのテスト。

import { jest } from "@jest/globals";
import { createCapacityGate, createSegmentEmitter, WINDOW_BYTES } from "./segment-emitter.mjs";
import { createStatusReporter } from "./status-reporter.mjs";

/**
 * Promiseが既に解決済みかを、マイクロタスクを1周させて判定する。
 * @param {Promise<unknown>} promise 判定対象
 * @returns {Promise<boolean>} 解決済みならtrue
 */
async function isSettled(promise) {
  let settled = false;
  promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return settled;
}

/**
 * 指定長のバイト列を連番で埋めて作る。
 * @param {number} length 長さ
 * @param {number} seed 先頭値
 * @returns {Uint8Array} バイト列
 */
function bytesOf(length, seed) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (seed + i) & 0xff;
  }
  return out;
}

describe("createSegmentEmitter", () => {
  test("閾値未満では送出せず、閾値到達で未送出分をまとめて1回送る", () => {
    const post = jest.fn();
    const emitter = createSegmentEmitter({ post, epoch: 0, thresholdBytes: 10 });
    emitter.push(bytesOf(4, 0));
    emitter.push(bytesOf(4, 4));
    expect(post).not.toHaveBeenCalled();
    emitter.push(bytesOf(5, 8)); // 合計13 >= 10
    expect(post).toHaveBeenCalledTimes(1);
    const message = post.mock.calls[0][0];
    expect(message).toMatchObject({ type: "data", epoch: 0, offset: 0 });
    expect(new Uint8Array(message.bytes)).toEqual(bytesOf(13, 0));
    expect(emitter.emittedOffset()).toBe(13);
  });

  test("offsetは送出済みバイト数に追随し、endは残りをflushしてbyteLengthを報告する", () => {
    const post = jest.fn();
    const emitter = createSegmentEmitter({ post, epoch: 2, thresholdBytes: 8 });
    emitter.push(bytesOf(8, 0)); // 即送出 offset 0
    emitter.push(bytesOf(3, 8)); // 未送出
    emitter.end();
    expect(post.mock.calls.map(([m]) => m.type)).toEqual(["data", "data", "end"]);
    expect(post.mock.calls[1][0]).toMatchObject({ type: "data", epoch: 2, offset: 8 });
    expect(new Uint8Array(post.mock.calls[1][0].bytes)).toEqual(bytesOf(3, 8));
    expect(post.mock.calls[2][0]).toEqual({ type: "end", epoch: 2, byteLength: 11 });
  });

  test("beginは1回だけ送られる", () => {
    const post = jest.fn();
    const emitter = createSegmentEmitter({ post, epoch: 1 });
    expect(emitter.began()).toBe(false);
    emitter.begin({ itag: 251, mimeType: "audio/webm", totalBytes: 100 });
    emitter.begin({ itag: 251, mimeType: "audio/webm", totalBytes: 100 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toEqual({ type: "begin", epoch: 1, itag: 251, mimeType: "audio/webm", totalBytes: 100 });
    expect(emitter.began()).toBe(true);
  });

  test("既定閾値は1MiB", () => {
    const post = jest.fn();
    const emitter = createSegmentEmitter({ post, epoch: 0 });
    emitter.push(new Uint8Array(1024 * 1024 - 1));
    expect(post).not.toHaveBeenCalled();
    emitter.push(new Uint8Array(1));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0].bytes.byteLength).toBe(1024 * 1024);
  });
});

describe("createCapacityGate", () => {
  test("既定ウィンドウは16MiB", () => {
    expect(WINDOW_BYTES).toBe(16 * 1024 * 1024);
  });

  test("送出済み−ack済みがウィンドウ以内ならwaitは即時解決する", async () => {
    let emitted = 0;
    const gate = createCapacityGate({ emittedOffset: () => emitted, windowBytes: 10 });
    emitted = 10;
    await expect(isSettled(gate.wait())).resolves.toBe(true);
  });

  test("ウィンドウを超えている間waitは待ち、ackで容量が戻れば解放される", async () => {
    let emitted = 0;
    const gate = createCapacityGate({ emittedOffset: () => emitted, windowBytes: 10 });
    emitted = 11;
    const waiting = gate.wait();
    await expect(isSettled(waiting)).resolves.toBe(false);

    gate.ack(0); // 容量不足のまま
    await expect(isSettled(waiting)).resolves.toBe(false);

    gate.ack(1); // 11-1=10 ≤ 10
    await expect(isSettled(waiting)).resolves.toBe(true);
    expect(gate.ackedOffset()).toBe(1);
  });

  test("ackは単調増加のみ反映し、onAckリスナーには毎回通知する", () => {
    const gate = createCapacityGate({ emittedOffset: () => 0, windowBytes: 10 });
    const seen = [];
    gate.onAck((offset) => seen.push(offset));
    gate.ack(5);
    gate.ack(3);
    gate.ack(8);
    expect(gate.ackedOffset()).toBe(8);
    expect(seen).toEqual([5, 3, 8]);
  });

  test("closeは待機中の全員を解放し、以後のwaitは即時解決する", async () => {
    let emitted = 100;
    const gate = createCapacityGate({ emittedOffset: () => emitted, windowBytes: 10 });
    const first = gate.wait();
    const second = gate.wait();
    await expect(isSettled(first)).resolves.toBe(false);
    gate.close();
    await expect(isSettled(first)).resolves.toBe(true);
    await expect(isSettled(second)).resolves.toBe(true);
    await expect(isSettled(gate.wait())).resolves.toBe(true);
  });

  test("segment-emitterのemittedOffsetと組み合わせて送出量に追随する", async () => {
    const post = jest.fn();
    const emitter = createSegmentEmitter({ post, epoch: 0, thresholdBytes: 4 });
    const gate = createCapacityGate({ emittedOffset: () => emitter.emittedOffset(), windowBytes: 8 });
    emitter.push(bytesOf(4, 0));
    emitter.push(bytesOf(4, 4));
    await expect(isSettled(gate.wait())).resolves.toBe(true); // 8-0=8 ≤ 8
    emitter.push(bytesOf(4, 8));
    const waiting = gate.wait(); // 12-0=12 > 8
    await expect(isSettled(waiting)).resolves.toBe(false);
    gate.ack(4);
    await expect(isSettled(waiting)).resolves.toBe(true);
  });
});

describe("createStatusReporter", () => {
  test("同一phaseは1秒未満の再送を捨て、phase変更は即時送る", () => {
    let clock = 0;
    const post = jest.fn();
    const reporter = createStatusReporter({ post, now: () => clock });
    expect(reporter.report({ phase: "download", bytes: 1 })).toBe(true);
    clock = 500;
    expect(reporter.report({ phase: "download", bytes: 2 })).toBe(false);
    clock = 999;
    expect(reporter.report({ phase: "download", bytes: 3 })).toBe(false);
    clock = 1000;
    expect(reporter.report({ phase: "download", bytes: 4 })).toBe(true);
    clock = 1100;
    expect(reporter.report({ phase: "player-js", attempt: 1, total: 2 })).toBe(true);
    expect(post.mock.calls.map(([m]) => m)).toEqual([
      { type: "status", phase: "download", bytes: 1 },
      { type: "status", phase: "download", bytes: 4 },
      { type: "status", phase: "player-js", attempt: 1, total: 2 },
    ]);
  });
});
