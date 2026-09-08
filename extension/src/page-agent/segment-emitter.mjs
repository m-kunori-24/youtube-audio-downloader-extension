// segment-emitter.mjs
// Gap2 §3(分割ストリーミング転送)のMAIN world側。SABRクライアントの確定バイト列に
// emittedOffsetカーソルを持ち、未送出分が閾値(既定1MiB)以上になるたびに
// {type:"data", epoch, offset, bytes} をリレーへpostMessageし、送出済み領域をメモリから解放する。
// createCapacityGateは背圧(finding 4)用: Offscreenが書込み済みのoffsetをackで返し、
// 送出済み−ack済みがWINDOW_BYTESを超えている間は次のSABR POSTを待たせる。

export const DEFAULT_SEGMENT_BYTES = 1024 * 1024;
export const WINDOW_BYTES = 16 * 1024 * 1024;

/**
 * 背圧ゲートを作る。1試行(1エポック)につき1インスタンス。
 * @param {{emittedOffset: () => number, windowBytes?: number}} params
 *   emittedOffset: 送出済みバイト数を返す関数(segment-emitterのもの)
 * @returns {{ack: (offset: number) => void, wait: () => Promise<void>, onAck: (listener: (offset: number) => void) => void,
 *   close: () => void, ackedOffset: () => number}} ゲート。closeで待機中の全員を解放する
 */
export function createCapacityGate({ emittedOffset, windowBytes = WINDOW_BYTES }) {
  let ackedOffset = 0; // number。Offscreenが書込み済みと報告した最大offset
  let closed = false; // boolean
  /** @type {Array<() => void>} */
  let waiters = [];
  /** @type {Array<(offset: number) => void>} */
  const ackListeners = [];

  /**
   * 送出済み−ack済みがウィンドウ内か(またはclose済みか)を返す。
   * @returns {boolean} 次のリクエストを出してよければtrue
   */
  function hasCapacity() {
    return closed || emittedOffset() - ackedOffset <= windowBytes;
  }

  /**
   * 容量が空いていれば待機中の全員を解放する。
   * @returns {void}
   */
  function wake() {
    if (!hasCapacity()) {
      return;
    }
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) {
      resolve();
    }
  }

  return {
    ack(offset) {
      if (offset > ackedOffset) {
        ackedOffset = offset;
      }
      for (const listener of ackListeners) {
        listener(offset);
      }
      wake();
    },
    wait() {
      if (hasCapacity()) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    onAck(listener) {
      ackListeners.push(listener);
    },
    close() {
      closed = true;
      wake();
    },
    ackedOffset() {
      return ackedOffset;
    },
  };
}

/**
 * 分割送出器を作る。
 * @param {{post: (message: object) => void, epoch: number, thresholdBytes?: number}} params
 *   post: {type,...}を受け取りns/v/taskIdを付与して送る関数、epoch: この試行の世代番号
 * @returns {{begin: (meta: {itag: number, mimeType: string, totalBytes: number|null}) => void,
 *   push: (chunk: Uint8Array) => void, flush: () => void, end: () => void,
 *   emittedOffset: () => number, began: () => boolean}} 送出器
 */
export function createSegmentEmitter({ post, epoch, thresholdBytes = DEFAULT_SEGMENT_BYTES }) {
  /** @type {Uint8Array[]} */
  let pending = [];
  let pendingBytes = 0; // number
  let emittedOffset = 0; // number
  let began = false; // boolean

  /**
   * 未送出分を1つのArrayBufferにまとめてdataメッセージとして送り、バッファを解放する。
   * @returns {void}
   */
  function emitPending() {
    if (pendingBytes === 0) {
      return;
    }
    const merged = new Uint8Array(pendingBytes);
    let cursor = 0;
    for (const chunk of pending) {
      merged.set(chunk, cursor);
      cursor += chunk.length;
    }
    post({ type: "data", epoch, offset: emittedOffset, bytes: merged.buffer });
    emittedOffset += pendingBytes;
    pending = [];
    pendingBytes = 0;
  }

  return {
    begin(meta) {
      if (began) {
        return;
      }
      began = true;
      post({ type: "begin", epoch, itag: meta.itag, mimeType: meta.mimeType, totalBytes: meta.totalBytes });
    },
    push(chunk) {
      if (chunk.length === 0) {
        return;
      }
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= thresholdBytes) {
        emitPending();
      }
    },
    flush() {
      emitPending();
    },
    end() {
      emitPending();
      post({ type: "end", epoch, byteLength: emittedOffset });
    },
    emittedOffset() {
      return emittedOffset;
    },
    began() {
      return began;
    },
  };
}
