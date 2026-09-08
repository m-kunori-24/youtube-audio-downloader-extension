// relay.mjs
// page-relay(ISOLATED world)の本体。MAIN worldのpage-agentがwindow.postMessageで送る
// {ns:"yta", v:1, taskId, type, n, mac, ...} を受け取り、HMAC検証(finding 1)を通ったものだけを
//   status / result → chrome.runtime.sendMessage(page.status / page.result)
//   begin / data / end / abort → Port "audio-transfer:<taskId>"(Offscreen宛)
// へ中継する(Gap2 §3/§4)。検証はイベントハンドラ内の同期区間で送信元・origin・名前空間・
// taskId・typeを確認しbytesを複製した後、直列化チェーン内で連番(n)・フィールド形状・MACを
// 検証する。どの段階で失敗しても黙って捨てる(ページスクリプトからの偽造・改竄・再送を
// ネットワーク揺らぎと区別できない形で無視するため)。
// エポックはbeginで厳密に増加(finding 11)、data/end/abortは現エポック一致のみ受理する。
// Offscreenからのack(書込み済みoffset)は署名付きフレームとしてpage-agentへ返す(finding 4)。
// Portは最初のbeginで開き、Offscreenからの{type:"ready"}を受けるまで送信をバッファする。

import { bytesToBase64 } from "./base64.mjs";
import { importFrameKey, isNonNegativeInteger, isPayloadField, signFrame, verifyFrame } from "../shared/frame-auth.mjs";

export const CHUNK_BYTES = 1024 * 1024;
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const RESULT_GRACE_MS = 30 * 1000;
export const RELAY_PORT_DISCONNECTED = "RELAY_PORT_DISCONNECTED";
export const RELAY_IDLE = "RELAY_IDLE";

/** page-agentから受理するフレームtype。 */
const AGENT_FRAME_TYPES = new Set(["status", "begin", "data", "end", "abort", "result"]);
/** 全フレーム共通のフィールド。 */
const BASE_FIELDS = new Set(["ns", "v", "taskId", "type", "n", "mac"]);
/** statusフレームで許可する追加フィールド。 */
const STATUS_FIELDS = new Set(["phase", "bytes", "totalBytes", "attempt", "total", "buildHash"]);
/** statusフレームのうち非負整数(またはnull/未指定)であるべきフィールド。 */
const STATUS_NUMERIC_FIELDS = ["bytes", "totalBytes", "attempt", "total"];

/**
 * リレーを開始する。
 * @param {{taskId: string, secret: string}} cfg SW→relay契約。secretはフレーム署名鍵(hex)
 * @param {{chrome: object, window: Window, origin: string, subtle: SubtleCrypto,
 *   setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout,
 *   idleTimeoutMs?: number, resultGraceMs?: number, chunkBytes?: number}} deps ブラウザ依存
 * @returns {{stop: () => void, flush: () => Promise<void>}} 停止ハンドル(リスナー解除・Port切断)と、
 *   受信・送信チェーンの完了待ち(停止時・テストの同期用)
 */
export function startRelay(cfg, deps) {
  const taskId = cfg.taskId;
  const idleTimeoutMs = typeof deps.idleTimeoutMs === "number" ? deps.idleTimeoutMs : IDLE_TIMEOUT_MS;
  const resultGraceMs = typeof deps.resultGraceMs === "number" ? deps.resultGraceMs : RESULT_GRACE_MS;
  const chunkBytes = typeof deps.chunkBytes === "number" ? deps.chunkBytes : CHUNK_BYTES;
  const portName = `audio-transfer:${taskId}`;

  let frameKey = null; // CryptoKey | null。インポート失敗時はnullのまま(全フレームを捨てる)
  let port = null; // chrome.runtime.Port | null
  let ready = false; // boolean。Offscreenからreadyを受信済みか
  /** @type {object[]} */
  let pendingPortMessages = []; // ready前にバッファしたPort宛メッセージ
  let currentEpoch = -1; // number
  let seq = 0; // number。エポック内のchunk連番
  let chunkCount = 0; // number。エポック内の送出chunk数
  let expectedOffset = 0; // number。エポック内で次に受理すべきdataのoffset
  let inCounter = 0; // number。agent→relay方向で次に受理すべきn
  let outCounter = 0; // number。relay→agent方向のフレーム連番(n)
  let completed = false; // boolean。endまたはresultを中継済みか
  let finished = false; // boolean。resultを中継済みか(以後の全フレームを捨てる)
  let stopped = false; // boolean
  let idleHandle = null; // タイマーハンドル

  const keyReady = importFrameKey(deps.subtle, cfg.secret)
    .then((key) => {
      frameKey = key;
    })
    .catch(() => {});
  let chain = keyReady; // agent→relayフレームの検証・中継を到着順に直列化するチェーン
  let outChain = keyReady; // relay→agentフレーム(ack)の署名・送出を直列化するチェーン

  /**
   * 無活動タイマーを指定の長さで張り直す。発火時、resultを中継する前ならRELAY_IDLEを
   * SWへ通知して停止する。
   * @param {number} ms タイマーの長さ
   * @returns {void}
   */
  function arm(ms) {
    if (idleHandle !== null) {
      deps.clearTimeout(idleHandle);
    }
    idleHandle = deps.setTimeout(() => {
      if (!finished) {
        sendToRuntime({ type: "page.relay.failed", taskId, code: RELAY_IDLE });
      }
      stop();
    }, ms);
  }

  /**
   * 無活動タイマーを既定の長さ(idleTimeoutMs)で張り直す。
   * @returns {void}
   */
  function touch() {
    arm(idleTimeoutMs);
  }

  /**
   * SWへメッセージを送る。受信側不在のrejectionは握り潰す。
   * @param {object} message 送信内容
   * @returns {void}
   */
  function sendToRuntime(message) {
    try {
      const maybePromise = deps.chrome.runtime.sendMessage(message);
      if (maybePromise && typeof maybePromise.catch === "function") {
        maybePromise.catch(() => {});
      }
    } catch (error) {
      // 拡張コンテキスト無効化時の同期例外は無視する
    }
  }

  /**
   * Port宛メッセージを送る。ready前はバッファし、ready後にまとめて流す。
   * @param {object} message 送信内容
   * @returns {void}
   */
  function sendToPort(message) {
    if (!ready) {
      pendingPortMessages.push(message);
      return;
    }
    if (port === null) {
      return;
    }
    try {
      port.postMessage(message);
    } catch (error) {
      // 切断済みPortへの送信例外はonDisconnect側で扱う
    }
  }

  /**
   * Offscreenからのackを署名付きフレームとしてpage-agentへ送る。
   * @param {{epoch: number, offset: number}} ack Portで受けたackメッセージ
   * @returns {void}
   */
  function forwardAck(ack) {
    if (!isNonNegativeInteger(ack.epoch) || !isNonNegativeInteger(ack.offset)) {
      return;
    }
    const frame = { ns: "yta", v: 1, taskId, type: "ack", epoch: ack.epoch, offset: ack.offset, n: outCounter };
    outCounter += 1;
    outChain = outChain
      .then(async () => {
        if (stopped || frameKey === null) {
          return;
        }
        frame.mac = await signFrame(deps.subtle, frameKey, frame, undefined);
        deps.window.postMessage(frame, deps.origin);
      })
      .catch(() => {});
  }

  /**
   * Portを開き、ready/ack/disconnectのハンドラを登録する。開いていれば何もしない。
   * @returns {void}
   */
  function ensurePort() {
    if (port !== null) {
      return;
    }
    port = deps.chrome.runtime.connect({ name: portName });
    port.onMessage.addListener((message) => {
      if (!message || typeof message !== "object") {
        return;
      }
      touch();
      if (message.type === "ready" && !ready) {
        ready = true;
        const queued = pendingPortMessages;
        pendingPortMessages = [];
        for (const queuedMessage of queued) {
          sendToPort(queuedMessage);
        }
        return;
      }
      if (message.type === "ack" && message.taskId === taskId) {
        forwardAck(message);
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      ready = false;
      if (stopped) {
        return;
      }
      if (!completed) {
        // endを中継する前の切断は本物の異常(未完了のまま相手が消えた)。
        sendToRuntime({ type: "page.relay.failed", taskId, code: RELAY_PORT_DISCONNECTED });
        stop();
        return;
      }
      if (finished) {
        // resultも中継済みなら、もう待つものは何もない。
        stop();
        return;
      }
      // endは中継済みだがresultはまだ届いていない。Offscreenがendを受けて即切断するのは
      // 正常な流れなので、失敗扱いにせずresultの到着を短い猶予だけ待つ(finding 2)。
      arm(resultGraceMs);
    });
  }

  /**
   * dataフレームのbytesを≤chunkBytesのbase64 chunkへ再フレーミングしてPortへ送る。
   * @param {{epoch: number, offset: number}} frame 受理したdataフレーム
   * @param {Uint8Array} bytes 複製済みのペイロード
   * @returns {void}
   */
  function forwardData(frame, bytes) {
    for (let start = 0; start < bytes.length; start += chunkBytes) {
      const piece = bytes.subarray(start, Math.min(start + chunkBytes, bytes.length));
      sendToPort({
        type: "chunk",
        taskId,
        epoch: frame.epoch,
        seq,
        offset: frame.offset + start,
        data: bytesToBase64(piece),
      });
      seq += 1;
      chunkCount += 1;
    }
    expectedOffset += bytes.length;
  }

  /**
   * 検証済みフレームを種類ごとに中継する。エポック不一致は黙って捨てる。
   * @param {object} frame 検証済みフレーム(mac/bytesを除く)
   * @param {Uint8Array|undefined} bytes dataフレームのペイロード
   * @returns {void}
   */
  function handleAgentFrame(frame, bytes) {
    switch (frame.type) {
      case "status": {
        /** @type {Record<string, unknown>} */
        const status = { type: "page.status", taskId };
        for (const field of STATUS_FIELDS) {
          if (frame[field] !== undefined) {
            status[field] = frame[field];
          }
        }
        sendToRuntime(status);
        return;
      }
      case "begin":
        if (frame.epoch <= currentEpoch) {
          return;
        }
        ensurePort();
        currentEpoch = frame.epoch;
        seq = 0;
        chunkCount = 0;
        expectedOffset = 0;
        sendToPort({
          type: "begin",
          taskId,
          epoch: frame.epoch,
          itag: frame.itag,
          mimeType: frame.mimeType,
          totalBytes: frame.totalBytes,
        });
        return;
      case "data":
        if (frame.epoch !== currentEpoch || frame.offset !== expectedOffset) {
          return;
        }
        forwardData(frame, bytes);
        return;
      case "end":
        if (frame.epoch !== currentEpoch) {
          return;
        }
        sendToPort({ type: "end", taskId, epoch: frame.epoch, chunkCount, byteLength: frame.byteLength });
        completed = true;
        return;
      case "abort":
        if (frame.epoch !== currentEpoch) {
          return;
        }
        sendToPort({ type: "abort", taskId, epoch: frame.epoch, reason: frame.reason, code: frame.code });
        seq = 0;
        chunkCount = 0;
        expectedOffset = 0;
        return;
      case "result":
        sendToRuntime({ type: "page.result", taskId, result: frame.result });
        completed = true;
        finished = true;
        if (port === null) {
          // 猶予期間中(end後の切断待ち)にresultが届いた場合、もう待つものはない。
          stop();
        }
        return;
      default:
        return;
    }
  }

  /**
   * フレームの種類ごとのフィールド形状を検証する。
   * @param {object} frame 検証対象(mac/bytesを除く)
   * @param {Uint8Array|undefined} bytes dataフレームのペイロード
   * @returns {boolean} 正しい形状ならtrue
   */
  function validateShape(frame, bytes) {
    switch (frame.type) {
      case "status":
        for (const key of Object.keys(frame)) {
          if (!BASE_FIELDS.has(key) && !STATUS_FIELDS.has(key)) {
            return false;
          }
        }
        if (typeof frame.phase !== "string") {
          return false;
        }
        for (const field of STATUS_NUMERIC_FIELDS) {
          if (frame[field] !== undefined && frame[field] !== null && !isNonNegativeInteger(frame[field])) {
            return false;
          }
        }
        return frame.buildHash === undefined || typeof frame.buildHash === "string";
      case "begin":
        return (
          isNonNegativeInteger(frame.epoch) &&
          isNonNegativeInteger(frame.itag) &&
          typeof frame.mimeType === "string" &&
          (frame.totalBytes === null || isNonNegativeInteger(frame.totalBytes))
        );
      case "data":
        return isNonNegativeInteger(frame.epoch) && isNonNegativeInteger(frame.offset) && bytes !== undefined;
      case "end":
        return isNonNegativeInteger(frame.epoch) && isNonNegativeInteger(frame.byteLength);
      case "abort":
        return (
          isNonNegativeInteger(frame.epoch) &&
          typeof frame.reason === "string" &&
          (frame.code === undefined || typeof frame.code === "string")
        );
      case "result":
        return typeof frame.result === "object" && frame.result !== null;
      default:
        return false;
    }
  }

  /**
   * 同期区間で複製したフレームを、連番→形状→MACの順に検証して中継する(チェーン内で実行)。
   * @param {{frame: object, bytes: Uint8Array|undefined, mac: unknown}} captured 複製済みフレーム
   * @returns {Promise<void>}
   */
  async function processFrame(captured) {
    if (stopped || finished || frameKey === null) {
      return;
    }
    if (captured.frame.n !== inCounter) {
      return;
    }
    if (!validateShape(captured.frame, captured.bytes)) {
      return;
    }
    const valid = await verifyFrame(deps.subtle, frameKey, captured.frame, captured.bytes, captured.mac);
    if (!valid || stopped || finished) {
      return;
    }
    inCounter += 1;
    touch();
    handleAgentFrame(captured.frame, captured.bytes);
  }

  /**
   * イベントデータを同期区間でリレー所有のコピーへ複製する。ヘッダはstructuredCloneで
   * 深く複製し、bytesはslice()で複製する(ページ側が後から元バッファを書き換えても影響しない)。
   * @param {object} data event.data
   * @returns {{frame: object, bytes: Uint8Array|undefined, mac: unknown}|null} 複製。複製できなければnull
   */
  function captureFrame(data) {
    /** @type {Record<string, unknown>} */
    const header = {};
    for (const [key, value] of Object.entries(data)) {
      if (key !== "mac" && !isPayloadField(data, key)) {
        header[key] = value;
      }
    }
    let frame;
    try {
      frame = structuredClone(header);
    } catch (error) {
      return null;
    }
    let bytes;
    if (data.type === "data") {
      const raw = data.bytes;
      if (raw instanceof ArrayBuffer) {
        bytes = new Uint8Array(raw).slice();
      } else if (ArrayBuffer.isView(raw)) {
        bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice();
      } else {
        return null;
      }
    }
    return { frame, bytes, mac: data.mac };
  }

  /**
   * windowのmessageイベント。同期区間で送信元・origin・名前空間・バージョン・taskId・typeを
   * 検査してフレームを複製し、残りの検証は直列化チェーンへ回す。
   * @param {MessageEvent} event イベント
   * @returns {void}
   */
  function onWindowMessage(event) {
    if (stopped || event.source !== deps.window || event.origin !== deps.origin) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== "object" || data.ns !== "yta" || data.v !== 1 || data.taskId !== taskId) {
      return;
    }
    if (typeof data.type !== "string" || !AGENT_FRAME_TYPES.has(data.type)) {
      return;
    }
    const captured = captureFrame(data);
    if (captured === null) {
      return;
    }
    chain = chain.then(() => processFrame(captured)).catch(() => {});
  }

  /**
   * リスナー解除・Port切断・タイマー停止を行う。
   * @returns {void}
   */
  function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    deps.window.removeEventListener("message", onWindowMessage);
    if (idleHandle !== null) {
      deps.clearTimeout(idleHandle);
      idleHandle = null;
    }
    if (port !== null) {
      const closing = port;
      port = null;
      try {
        closing.disconnect();
      } catch (error) {
        // 既に切断済みの場合の例外は無視する
      }
    }
  }

  /**
   * 受信・送信チェーンの完了を待つ。
   * @returns {Promise<void>} 完了
   */
  function flush() {
    return Promise.all([chain, outChain]).then(() => undefined);
  }

  deps.window.addEventListener("message", onWindowMessage);
  touch();
  return { stop, flush };
}
