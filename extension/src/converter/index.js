// converter (Offscreen Document) エントリポイント。
// 役割は4つ:
//   1. Port "audio-transfer:<taskId>" でpage-relayからの分割転送を受け、OPFS一時ファイルへ書き込む
//   2. SWからの convert.start でMediabunny+WASMエンコーダによる変換・保存を実行する
//   3. SWからの convert.status で進行中タスクの状態を返す(SW再起動からの復旧用)
//   4. SWからの convert.release で、保存先未選択時に渡したobject URLとOPFS出力ファイルを解放する
// 起動時にはOPFS上の前セッションの残骸を掃除する。

import { convertAudio, withAbort } from "./convert.mjs";
import { CONVERT_FAILED, errorCode, errorMessage } from "./errors.mjs";
import { loadOutputDirectoryHandle } from "./idb.mjs";
import { cleanupLeftovers, createOpfsStorage, removeIfExists, tempFileName } from "./opfs.mjs";
import { resolveDestination } from "./save.mjs";
import { createTransferReceiver } from "./transfer.mjs";

/** Port名の接頭辞。 */
const PORT_PREFIX = "audio-transfer:";

/** 進捗通知の最小送信間隔(ms)。設計の進捗レート制限(4回/秒以下)に合わせる。 */
const PROGRESS_MIN_INTERVAL_MS = 250;

/** 変換・保存が無進捗のまま許容される時間(ms)。超えると中断しCONVERT_STALLEDで失敗させる。 */
const CONVERT_STALL_TIMEOUT_MS = 120 * 1000;

/**
 * タスクごとの状態。
 * state: "transferring" | "ready" | "converting" | "awaiting-download" | "done" | "failed"
 *   "awaiting-download" は「変換は完了したが、SW側のchrome.downloads.downloadがまだ
 *   終端状態に達していない」(保存先未選択時=Q2のみ)を表す。ここを"done"と畳むと、
 *   SW再起動からの復元がダウンロード未実行のまま成功と誤報告してしまう。
 * saveMode: null | "directory" | "downloads"
 * outputFileName: 実際に保存した拡張子込みのファイル名(convert.startで渡される
 *   拡張子無しのfileNameとは別)
 * @type {Map<string, {state: string, percent: number, byteLength: number,
 *   file: File|null, format: string|null, fileName: string|null,
 *   saveMode: string|null, outputFileName: string|null}>}
 */
const tasks = new Map();

/**
 * 保存先未選択時(Q2)にSWへ渡したobject URLとOPFS出力ファイル。
 * SWのchrome.downloads.downloadが終端状態に達すると convert.release が届き、そこで解放する。
 * @type {Map<string, {url: string, tempName: string}>}
 */
const pendingOutputs = new Map();

/**
 * OPFSルートを返す。
 * @returns {Promise<FileSystemDirectoryHandle>} OPFSルート
 */
function getRoot() {
  return navigator.storage.getDirectory();
}

/**
 * SWへメッセージを送る。受信側不在のrejectionは握り潰す。
 * @param {object} message 送信内容
 * @returns {void}
 */
function sendToRuntime(message) {
  try {
    const maybePromise = chrome.runtime.sendMessage(message);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch (error) {
    // 拡張コンテキスト無効化時の同期例外は無視する
  }
}

/**
 * タスク状態を取得する。無ければ初期値を作る。
 * @param {string} taskId タスクID
 * @returns {object} タスク状態
 */
function taskState(taskId) {
  let entry = tasks.get(taskId);
  if (entry === undefined) {
    entry = {
      state: "transferring",
      percent: 0,
      byteLength: 0,
      file: null,
      format: null,
      fileName: null,
      saveMode: null,
      outputFileName: null,
    };
    tasks.set(taskId, entry);
  }
  return entry;
}

/**
 * 内部状態を、畳み込まれた旧来の表示用語彙へ写像する。
 * SWの復元判定はこの値ではなく convert.status が返す offscreenState を使う
 * ("awaiting-download"と"done"はここでは区別できないため)。
 * @param {string} state 内部状態
 * @returns {string} 表示用の状態語("downloading"|"converting"|"completed"|"error")
 */
function toSwState(state) {
  switch (state) {
    case "transferring":
      return "downloading";
    case "ready":
    case "converting":
      return "converting";
    case "awaiting-download":
    case "done":
      return "completed";
    default:
      return "error";
  }
}

/**
 * 転送用Portの接続を処理する。
 * @param {chrome.runtime.Port} port 接続されたPort
 * @returns {void}
 */
function onConnect(port) {
  if (!port.name.startsWith(PORT_PREFIX)) {
    return;
  }
  const taskId = port.name.slice(PORT_PREFIX.length);
  const entry = taskState(taskId);
  entry.state = "transferring";
  entry.file = null;

  let disconnected = false; // boolean。Portを切断済みか

  const receiver = createTransferReceiver(
    { taskId },
    {
      storage: createOpfsStorage(getRoot),
      post: (message) => {
        if (!disconnected) {
          try {
            port.postMessage(message);
          } catch (error) {
            // 切断済みPortへの送信例外は無視する
          }
        }
      },
      notify: (message) => {
        if (message.type === "audio.transfer.failed") {
          const failed = taskState(taskId);
          failed.state = "failed";
        }
        sendToRuntime(message);
      },
      disconnect: () => {
        if (!disconnected) {
          disconnected = true;
          try {
            port.disconnect();
          } catch (error) {
            // 既に切断済みの場合の例外は無視する
          }
        }
      },
      onReceived: (id, file) => {
        const received = taskState(id);
        received.state = "ready";
        received.file = file;
        received.byteLength = file.size;
      },
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle),
    },
  );

  port.onMessage.addListener((message) => {
    receiver.handle(message);
  });

  port.onDisconnect.addListener(() => {
    disconnected = true;
    receiver.dispose();
  });

  // 接続直後にready応答を返す(relayはこれを受けるまで送信をバッファする)。
  port.postMessage({ type: "ready" });
}

/**
 * convert.startを処理し、変換・保存を実行して結果をSWへ返す。
 * @param {{taskId: string, format: string, audioQuality: string, fileName: string}} message 要求
 * @returns {Promise<void>}
 */
async function onConvertStart(message) {
  const taskId = message.taskId;
  const entry = taskState(taskId);
  entry.format = message.format;
  entry.fileName = message.fileName;

  if (entry.file === null) {
    entry.state = "failed";
    sendToRuntime({
      type: "convert.result",
      taskId,
      ok: false,
      code: CONVERT_FAILED,
      message: "転送済みの音声データがありません",
    });
    return;
  }

  entry.state = "converting";
  entry.percent = 0;

  let lastProgressAt = Number.NEGATIVE_INFINITY; // number。直近の進捗送信時刻(ms)

  const controller = new AbortController();
  let stallHandle = null; // 無進捗監視タイマーのハンドル

  /**
   * 無進捗監視タイマーを張り直す。進捗通知・書込み完了のたびに呼ぶ。
   * @returns {void}
   */
  const armStallWatchdog = () => {
    if (stallHandle !== null) {
      globalThis.clearTimeout(stallHandle);
    }
    stallHandle = globalThis.setTimeout(() => {
      stallHandle = null;
      controller.abort();
    }, CONVERT_STALL_TIMEOUT_MS);
  };

  /**
   * 無進捗監視タイマーを解除する。
   * @returns {void}
   */
  const clearStallWatchdog = () => {
    if (stallHandle !== null) {
      globalThis.clearTimeout(stallHandle);
      stallHandle = null;
    }
  };

  try {
    // 変換本体に入る前の段取り(IndexedDBからの保存先ハンドル読み出し)で固まった場合も
    // 打ち切れるよう、監視タイマーはここで張る。
    armStallWatchdog();
    const directoryHandle = await withAbort(
      controller.signal,
      loadOutputDirectoryHandle(globalThis.indexedDB).catch(() => null),
    );

    const result = await convertAudio(
      { file: entry.file, format: message.format, audioQuality: message.audioQuality },
      {
        signal: controller.signal,
        onActivity: armStallWatchdog,
        // SWは拡張子無しのファイル名を渡してくるため、コンテナに応じた拡張子をここで付ける。
        destinationFor: (settings) =>
          resolveDestination(
            {
              taskId,
              fileName: `${message.fileName}.${settings.extension}`,
              extension: settings.extension,
            },
            { directoryHandle, getRoot },
          ),
        onProgress: (percent, convertedSeconds, totalSeconds) => {
          armStallWatchdog();
          entry.percent = percent;
          const now = Date.now();
          if (now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) {
            return;
          }
          lastProgressAt = now;
          sendToRuntime({ type: "convert.progress", taskId, percent, convertedSeconds, totalSeconds });
        },
      },
    );

    entry.percent = 100;
    entry.outputFileName = typeof result.fileName === "string" ? result.fileName : null;
    /** @type {object} SWへ返す成功結果 */
    const payload = {
      type: "convert.result",
      taskId,
      ok: true,
      fileName: result.fileName,
      dirName: result.dirName ?? null,
    };
    if (result.downloadUrl !== undefined) {
      // 保存先未選択時(Q2): Offscreenでobject URLを作り、SW側がchrome.downloads.downloadで保存する。
      // 実際のダウンロードが終端状態に達するまでURLとOPFS出力ファイルは残す必要があるため、
      // 解放はSWからの convert.release を待つ。この間は"done"ではなく"awaiting-download"とし、
      // SWが再起動しても「保存はまだ終わっていない」と判別できるようにする。
      entry.state = "awaiting-download";
      entry.saveMode = "downloads";
      payload.downloadUrl = result.downloadUrl;
      pendingOutputs.set(taskId, { url: result.downloadUrl, tempName: result.tempName });
    } else {
      entry.state = "done";
      entry.saveMode = "directory";
    }
    if (result.skipped) {
      payload.skipped = true;
    }
    sendToRuntime(payload);
  } catch (error) {
    entry.state = "failed";
    sendToRuntime({
      type: "convert.result",
      taskId,
      ok: false,
      code: errorCode(error, CONVERT_FAILED),
      message: errorMessage(error),
    });
  } finally {
    clearStallWatchdog();
    entry.file = null;
    await removeIfExists(getRoot, tempFileName(taskId));
  }
}

/**
 * convert.releaseを処理する。SWがchrome.downloads側の終端状態を検知したときに届き、
 * 保存先未選択時に作ったobject URLとOPFS出力一時ファイルを解放する。
 * @param {{taskId: string}} message 要求
 * @returns {Promise<void>}
 */
async function onConvertRelease(message) {
  const pending = pendingOutputs.get(message.taskId);
  if (pending === undefined) {
    return;
  }
  pendingOutputs.delete(message.taskId);
  try {
    URL.revokeObjectURL(pending.url);
  } catch (error) {
    // 既に無効化済みのURLに対する例外は無視する
  }
  if (typeof pending.tempName === "string") {
    await removeIfExists(getRoot, pending.tempName);
  }
  const entry = tasks.get(message.taskId);
  if (entry !== undefined && entry.state === "awaiting-download") {
    // ダウンロードが終端状態に達したことをSWが確認したので、ここで初めて"done"にする。
    entry.state = "done";
  }
}

/**
 * convert.statusへ現在の状態を返す(SW再起動からの復旧用)。
 * taskId指定時はbackground.jsのisTaskStillRunningInOffscreen()が読む形
 * ({taskId, running, state, ...})で返し、未指定なら追跡中の全タスクを返す。
 * @param {{taskId?: string}} message 要求
 * @returns {object} 状態
 */
function onConvertStatus(message) {
  /**
   * 1タスク分の状態を組み立てる。
   * @param {string} taskId タスクID
   * @param {object} entry タスク状態
   * @returns {object} 応答用の状態
   */
  const describe = (taskId, entry) => ({
    taskId,
    running: entry.state === "transferring" || entry.state === "ready" || entry.state === "converting",
    state: toSwState(entry.state),
    percent: entry.percent,
    byteLength: entry.byteLength,
    format: entry.format,
    fileName: entry.fileName,
    // SWの復元判定はここから下の畳み込まない状態を使う。
    offscreenState: entry.state,
    saveMode: entry.saveMode,
    pendingDownloadUrl: pendingOutputs.get(taskId)?.url ?? null,
    outputFileName: entry.outputFileName,
  });

  if (typeof message.taskId === "string") {
    const entry = tasks.get(message.taskId);
    if (entry === undefined) {
      return { taskId: message.taskId, running: false, state: "error", percent: 0, offscreenState: null };
    }
    return describe(message.taskId, entry);
  }

  /** @type {object[]} */
  const entries = [];
  for (const [taskId, entry] of tasks) {
    entries.push(describe(taskId, entry));
  }
  return { tasks: entries };
}

/**
 * SWからのメッセージを処理する。
 * @param {object} message 受信メッセージ
 * @param {object} sender 送信元
 * @param {(response: object) => void} sendResponse 応答関数
 * @returns {boolean|undefined} 非同期応答を使う場合はtrue
 */
function onMessage(message, sender, sendResponse) {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if (message.type === "convert.start") {
    onConvertStart(message);
    return undefined;
  }
  if (message.type === "convert.release") {
    onConvertRelease(message);
    return undefined;
  }
  if (message.type === "convert.status") {
    sendResponse(onConvertStatus(message));
    return undefined;
  }
  return undefined;
}

chrome.runtime.onConnect.addListener(onConnect);
chrome.runtime.onMessage.addListener(onMessage);

// 起動時のOPFS残骸掃除(前セッションのクラッシュからの復旧)。
getRoot()
  .then((root) => cleanupLeftovers(root))
  .catch(() => {});
