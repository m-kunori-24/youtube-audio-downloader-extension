// transfer.mjs
// Port "audio-transfer:<taskId>" 経由でpage-relayから届くフレーム
// (begin / chunk / end / abort)を受け取り、OPFS一時ファイルへ逐次書き込む受信機(Gap2 §3/§4)。
// エポック番号で世代管理する: beginは現エポックより厳密に大きい場合のみ採用し、
// chunk/end/abortは現エポックと一致するものだけ受理して他は黙って捨てる(finding 11)。
// seq/offsetの連続性とendの整合(byteLength/chunkCount)を検証し、破れたら転送失敗として扱う。
// chunkを書き込むたびに{type:"ack", epoch, offset}をPortへ返し、page-agent側の背圧に使う(finding 4)。

import { base64ToBytes } from "./base64.mjs";
import { ABORT_REASONS } from "../shared/abort-reasons.mjs";
import { isNonNegativeInteger } from "../shared/frame-auth.mjs";
import {
  TRANSFER_INCOMPLETE,
  TRANSFER_OFFSET_MISMATCH,
  TRANSFER_SEQ_GAP,
  TRANSFER_SIZE_MISMATCH,
  codedError,
  errorCode,
} from "./errors.mjs";

/** beginからendまでの無活動タイムアウト(ms)。 */
export const INACTIVITY_TIMEOUT_MS = 120 * 1000;

/**
 * 転送受信機を作る。1つのPort(=1タスク)につき1インスタンス。
 * @param {{taskId: string}} cfg タスク情報
 * @param {{
 *   storage: {open: Function, write: Function, close: Function, discard: Function},
 *   post: (message: object) => void,
 *   notify: (message: object) => void,
 *   disconnect: () => void,
 *   onReceived: (taskId: string, file: File, session: object) => void,
 *   decode?: (text: string) => Uint8Array,
 *   setTimeout: typeof setTimeout,
 *   clearTimeout: typeof clearTimeout,
 *   inactivityTimeoutMs?: number
 * }} deps 依存
 * @returns {{handle: (message: object) => Promise<void>, dispose: () => Promise<void>,
 *   state: () => {epoch: number, seq: number, bytesWritten: number, closed: boolean}}} 受信機
 */
export function createTransferReceiver(cfg, deps) {
  const taskId = cfg.taskId;
  const decode = deps.decode ?? base64ToBytes;
  const inactivityTimeoutMs =
    typeof deps.inactivityTimeoutMs === "number" ? deps.inactivityTimeoutMs : INACTIVITY_TIMEOUT_MS;

  let currentEpoch = -1; // number。採用中のエポック。未beginなら-1
  let expectedSeq = 0; // number。次に来るべきchunkのseq
  let bytesWritten = 0; // number。現エポックで書き込み済みのバイト数
  let session = null; // {name, handle, writable} | null
  let closed = false; // boolean。成功・失敗いずれかで受信を終えたか
  let idleHandle = null; // タイマーハンドル
  let queue = Promise.resolve(); // 直列化キュー。書込みが非同期のため順序を保証する

  /**
   * 無活動タイマーを張り直す。
   * @returns {void}
   */
  function armIdle() {
    clearIdle();
    idleHandle = deps.setTimeout(() => {
      idleHandle = null;
      enqueue(() => fail(TRANSFER_INCOMPLETE));
    }, inactivityTimeoutMs);
  }

  /**
   * 無活動タイマーを解除する。
   * @returns {void}
   */
  function clearIdle() {
    if (idleHandle !== null) {
      deps.clearTimeout(idleHandle);
      idleHandle = null;
    }
  }

  /**
   * 現在のOPFS一時ファイルを破棄し、カウンタを0へ戻す。
   * @returns {Promise<void>}
   */
  async function discardSession() {
    const current = session;
    session = null;
    expectedSeq = 0;
    bytesWritten = 0;
    if (current !== null) {
      await deps.storage.discard(current);
    }
  }

  /**
   * 転送を失敗として終了する。一時ファイルを破棄しSWへ通知してPortを切る。
   * @param {string} code エラーコード
   * @returns {Promise<void>}
   */
  async function fail(code) {
    if (closed) {
      return;
    }
    closed = true;
    clearIdle();
    await discardSession();
    deps.notify({ type: "audio.transfer.failed", taskId, code });
    deps.disconnect();
  }

  /**
   * beginフレームを処理する。
   * @param {object} message フレーム
   * @returns {Promise<void>}
   */
  async function handleBegin(message) {
    if (!isNonNegativeInteger(message.epoch) || message.epoch <= currentEpoch) {
      return;
    }
    await discardSession();
    currentEpoch = message.epoch;
    session = await deps.storage.open(taskId);
    armIdle();
  }

  /**
   * chunkフレームを処理する。書き込めたらackを返す。
   * @param {object} message フレーム
   * @returns {Promise<void>}
   */
  async function handleChunk(message) {
    if (message.epoch !== currentEpoch || session === null) {
      return;
    }
    if (!isNonNegativeInteger(message.seq) || !isNonNegativeInteger(message.offset)) {
      return;
    }
    if (message.seq !== expectedSeq) {
      await fail(TRANSFER_SEQ_GAP);
      return;
    }
    if (message.offset !== bytesWritten) {
      await fail(TRANSFER_OFFSET_MISMATCH);
      return;
    }
    const bytes = decode(message.data);
    await deps.storage.write(session, bytes);
    expectedSeq += 1;
    bytesWritten += bytes.length;
    armIdle();
    deps.post({ type: "ack", taskId, epoch: currentEpoch, offset: bytesWritten });
  }

  /**
   * endフレームを処理する。整合が取れていればFileを確定しSWへ完了通知する。
   * @param {object} message フレーム
   * @returns {Promise<void>}
   */
  async function handleEnd(message) {
    if (message.epoch !== currentEpoch) {
      return;
    }
    if (!isNonNegativeInteger(message.byteLength) || !isNonNegativeInteger(message.chunkCount)) {
      return;
    }
    if (session === null) {
      await fail(TRANSFER_INCOMPLETE);
      return;
    }
    if (message.byteLength !== bytesWritten) {
      await fail(TRANSFER_SIZE_MISMATCH);
      return;
    }
    if (message.chunkCount !== expectedSeq) {
      await fail(TRANSFER_INCOMPLETE);
      return;
    }
    const finished = session;
    const file = await deps.storage.close(finished);
    session = null;
    closed = true;
    clearIdle();
    deps.onReceived(taskId, file, finished);
    deps.post({ type: "received", taskId, epoch: message.epoch, byteLength: bytesWritten });
    deps.disconnect();
    deps.notify({ type: "audio.transfer.complete", taskId, epoch: message.epoch, byteLength: bytesWritten });
  }

  /**
   * abortフレームを処理する。reason=restartは現エポックの途中データを捨てて次のbeginを待ち、
   * それ以外(error/failed/その他)はすべて終了としてSWへ通知する。
   * @param {object} message フレーム
   * @returns {Promise<void>}
   */
  async function handleAbort(message) {
    if (message.epoch !== currentEpoch) {
      return;
    }
    if (message.reason === ABORT_REASONS.RESTART) {
      await discardSession();
      armIdle();
      return;
    }
    await fail(typeof message.code === "string" ? message.code : TRANSFER_INCOMPLETE);
  }

  /**
   * 1フレームを処理する(直列化キュー内で実行される本体)。
   * @param {object} message フレーム
   * @returns {Promise<void>}
   */
  async function dispatch(message) {
    if (closed) {
      return;
    }
    switch (message.type) {
      case "begin":
        await handleBegin(message);
        return;
      case "chunk":
        await handleChunk(message);
        return;
      case "end":
        await handleEnd(message);
        return;
      case "abort":
        await handleAbort(message);
        return;
      default:
        return;
    }
  }

  /**
   * 直列化キューへ処理を積む。例外はCONVERT側へ波及させず転送失敗として畳む。
   * @param {() => Promise<void>} task 実行する処理
   * @returns {Promise<void>} 積んだ処理の完了
   */
  function enqueue(task) {
    queue = queue.then(task).catch(async (error) => {
      if (!closed) {
        closed = true;
        clearIdle();
        await discardSession().catch(() => {});
        deps.notify({ type: "audio.transfer.failed", taskId, code: errorCode(error, TRANSFER_INCOMPLETE) });
        deps.disconnect();
      }
    });
    return queue;
  }

  return {
    /**
     * Portから届いたフレームを処理する。到着順に直列実行される。
     * @param {object} message フレーム
     * @returns {Promise<void>} 処理完了
     */
    handle(message) {
      if (!message || typeof message !== "object" || message.taskId !== taskId) {
        return queue;
      }
      return enqueue(() => dispatch(message));
    },

    /**
     * Port切断時などに受信機を破棄する。未完了なら一時ファイルも消す。
     * @returns {Promise<void>}
     */
    dispose() {
      return enqueue(async () => {
        if (closed) {
          return;
        }
        closed = true;
        clearIdle();
        await discardSession();
      });
    },

    /**
     * 現在の受信状態を返す(convert.status応答・テスト用)。
     * @returns {{epoch: number, seq: number, bytesWritten: number, closed: boolean}} 状態
     */
    state() {
      return { epoch: currentEpoch, seq: expectedSeq, bytesWritten, closed };
    },
  };
}

/**
 * 転送関連の例外を作る(index.js等からの利用向け)。
 * @param {string} code エラーコード
 * @param {string} message メッセージ
 * @returns {Error & {code: string}} コード付きError
 */
export function transferError(code, message) {
  return codedError(code, message);
}
