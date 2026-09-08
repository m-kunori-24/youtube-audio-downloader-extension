// popup.js
// ツールバーアイコンから開くPopup UI。対象URL・音声形式の入力、開始要求の送信、
// 進捗・結果の表示を行う。Popupが閉じられている間の状態はbackground側の
// chrome.storage.localスナップショットとして保持され、再表示時に復元する。

const urlInput = document.getElementById("url-input");
const formatSelect = document.getElementById("format-select");
const qualitySelect = document.getElementById("quality-select");
const startButton = document.getElementById("start-button");
const progressArea = document.getElementById("progress-area");
const stateText = document.getElementById("state-text");
const progressBar = document.getElementById("progress-bar");
const detailText = document.getElementById("detail-text");
const resultArea = document.getElementById("result-area");
const resultText = document.getElementById("result-text");
const outputDirDisplay = document.getElementById("output-dir-display");
const browseButton = document.getElementById("browse-button");
const clearOutputDirButton = document.getElementById("clear-output-dir-button");
const pickerUnsupportedNotice = document.getElementById("picker-unsupported-notice");

let currentTaskId = null; // string | null
let lastSequence = -1; // number
let isRunning = false; // boolean
let directoryHandle = null; // FileSystemDirectoryHandle | null。IndexedDBの内容をメモリへ複製したもの
let audioQuality = "standard"; // "standard" | "high" | "best"。Popupのメモリ上のみで保持し、永続化はしない
let isBrowsePending = false; // boolean。参照ボタンクリックの多重実行防止
let directoryPickerSupported = true; // boolean。window.showDirectoryPickerが利用可能か(Braveの既定等では false)

// wav/flacは元々ロスレスであり、音質(ビットレート)選択の対象外。
const LOSSLESS_FORMATS = ["wav", "flac"];

// 保存先ディレクトリハンドルを永続化するIndexedDBの設定。
// FileSystemDirectoryHandleはJSON化できずchrome.storageには保存できないため、
// structured cloneが可能なIndexedDBを使用する(T0スパイクで検証済みのパターン)。
const SETTINGS_DB_NAME = "ytae-settings";
const SETTINGS_DB_VERSION = 1;
const SETTINGS_STORE_NAME = "handles";
const OUTPUT_DIR_KEY = "outputDir";

// エラーcodeから、messages.jsonのローカライズ済みメッセージキーへのマップ。
// ここに載っていないcode(CONVERT_FAILED等、動的な詳細を含むメッセージ)は
// 従来通りbackground側のmessageフィールドをそのまま表示する。
const ERROR_MESSAGE_KEY_BY_CODE = {
  // 既存のバリデーション系エラー。
  INVALID_URL: "error_INVALID_URL",
  INVALID_FORMAT: "error_INVALID_FORMAT",
  INVALID_AUDIO_QUALITY: "error_INVALID_AUDIO_QUALITY",
  TASK_ALREADY_RUNNING: "error_TASK_ALREADY_RUNNING",
  // auth: 認証関連。
  AUTH_NOT_LOGGED_IN: "error_AUTH_NOT_LOGGED_IN",
  AUTH_REJECTED: "error_AUTH_REJECTED",
  // video: 動画自体の状態に起因するエラー。
  VIDEO_LOGIN_REQUIRED: "error_VIDEO_LOGIN_REQUIRED",
  VIDEO_AGE_RESTRICTED: "error_VIDEO_AGE_RESTRICTED",
  VIDEO_UNPLAYABLE: "error_VIDEO_UNPLAYABLE",
  VIDEO_UNAVAILABLE: "error_VIDEO_UNAVAILABLE",
  VIDEO_LIVE: "error_VIDEO_LIVE",
  VIDEO_DRM: "error_VIDEO_DRM",
  VIDEO_NO_AUDIO_FORMAT: "error_VIDEO_NO_AUDIO_FORMAT",
  // breakage: YouTube側の実装変更で拡張機能の前提が崩れた場合のエラー。
  PLAYER_JS_UNAVAILABLE: "error_PLAYER_JS_UNAVAILABLE",
  EXTRACT_NSIG_FAILED: "error_EXTRACT_NSIG_FAILED",
  NSIG_REJECTED_BY_SERVER: "error_NSIG_REJECTED_BY_SERVER",
  // network: 配信取得時のネットワーク/サーバー起因のエラー。
  STREAM_URL_EXPIRED: "error_STREAM_URL_EXPIRED",
  SABR_SERVER_ERROR: "error_SABR_SERVER_ERROR",
  SABR_NETWORK_UNREACHABLE: "error_SABR_NETWORK_UNREACHABLE",
  FETCH_STALLED: "error_FETCH_STALLED",
  TAB_UNAVAILABLE: "error_TAB_UNAVAILABLE",
  // internal: MAIN world→Offscreen間の転送・変換パイプライン内部のエラー。
  TRANSFER_INCOMPLETE: "error_TRANSFER_INCOMPLETE",
  TRANSFER_SEQ_GAP: "error_TRANSFER_SEQ_GAP",
  TRANSFER_OFFSET_MISMATCH: "error_TRANSFER_OFFSET_MISMATCH",
  TRANSFER_SIZE_MISMATCH: "error_TRANSFER_SIZE_MISMATCH",
  TRANSFER_WRITE_FAILED: "error_TRANSFER_WRITE_FAILED",
  CONVERT_UNSUPPORTED: "error_CONVERT_UNSUPPORTED",
  CONVERT_FAILED: "error_CONVERT_FAILED",
  CONVERT_STALLED: "error_CONVERT_STALLED",
  // save: 保存先(File System Access API)に起因するエラー。
  SAVE_PERMISSION_DENIED: "error_SAVE_PERMISSION_DENIED",
  SAVE_NO_DIRECTORY: "error_SAVE_NO_DIRECTORY",
  SAVE_FAILED: "error_SAVE_FAILED",
};

/**
 * エラーcodeに対応するローカライズ済みメッセージを解決する。
 * ERROR_MESSAGE_KEY_BY_CODEに載っている既知のcodeはmessages.jsonの
 * 訳文を優先し、未知のcodeの場合のみfallbackMessage(background側の
 * messageフィールド)をそのまま返す。
 * @param {string|undefined} code エラーコード
 * @param {string|undefined} fallbackMessage 未知のcode時に表示するメッセージ
 * @returns {string} 表示用メッセージ
 */
function resolveDisplayMessage(code, fallbackMessage) {
  const key = ERROR_MESSAGE_KEY_BY_CODE[code];
  if (key) {
    const localized = chrome.i18n.getMessage(key);
    if (localized) {
      return localized;
    }
  }
  return fallbackMessage;
}

/**
 * data-i18n / data-i18n-placeholder / data-i18n-title属性を持つ全要素へ、
 * chrome.i18n.getMessage()で解決した文言を反映する。
 * @returns {void}
 */
function applyI18n() {
  const uiLanguage =
    typeof chrome.i18n.getUILanguage === "function" ? chrome.i18n.getUILanguage() : "";
  document.documentElement.lang = uiLanguage.startsWith("ja") ? "ja" : "en";
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    const message = chrome.i18n.getMessage(key);
    if (message) {
      element.textContent = message;
    }
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const key = element.getAttribute("data-i18n-placeholder");
    const message = chrome.i18n.getMessage(key);
    if (message) {
      element.placeholder = message;
    }
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const key = element.getAttribute("data-i18n-title");
    const message = chrome.i18n.getMessage(key);
    if (message) {
      element.title = message;
    }
  });
}

/**
 * ytae-settings IndexedDBデータベースを開く。存在しなければhandlesストアを作成する。
 * FileSystemDirectoryHandleはJSONへ変換できないためchrome.storageには保存できず、
 * structured cloneが可能なIndexedDBへ保存する(T0スパイクで検証済みのパターン)。
 * @returns {Promise<IDBDatabase>} オープン済みのデータベース
 */
function openSettingsDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SETTINGS_DB_NAME, SETTINGS_DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) {
        db.createObjectStore(SETTINGS_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 選択済みの保存先ディレクトリハンドルをIndexedDBへ保存する。
 * @param {FileSystemDirectoryHandle} handle 保存対象のディレクトリハンドル
 * @returns {Promise<void>} 保存完了を表すPromise
 */
async function saveDirectoryHandle(handle) {
  const db = await openSettingsDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE_NAME, "readwrite");
    tx.objectStore(SETTINGS_STORE_NAME).put(handle, OUTPUT_DIR_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * IndexedDBに保存済みの保存先ディレクトリハンドルを読み込む。
 * @returns {Promise<FileSystemDirectoryHandle|null>} 保存済みハンドル。未保存ならnull
 */
async function loadDirectoryHandle() {
  const db = await openSettingsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE_NAME, "readonly");
    const request = tx.objectStore(SETTINGS_STORE_NAME).get(OUTPUT_DIR_KEY);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * IndexedDBに保存済みの保存先ディレクトリハンドルを削除する。
 * @returns {Promise<void>} 削除完了を表すPromise
 */
async function clearDirectoryHandle() {
  const db = await openSettingsDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE_NAME, "readwrite");
    tx.objectStore(SETTINGS_STORE_NAME).delete(OUTPUT_DIR_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * IndexedDBに保存済みの保存先ディレクトリハンドルを読み込み、
 * メモリ上のdirectoryHandleと#output-dir-displayへ反映する。
 * 保存済みでなければ何もしない(表示欄はplaceholderの
 * 「Downloadsフォルダ」のままとなり、絶対パスは表示しない
 * ―― File System Access APIの既知の制約であり、handle.nameのみを表示する)。
 * @returns {Promise<void>} 読み込み完了を表すPromise
 */
async function loadStoredDirectoryHandle() {
  const handle = await loadDirectoryHandle();
  if (handle) {
    directoryHandle = handle;
    outputDirDisplay.value = handle.name;
  }
}

/**
 * DOMContentLoaded時に1回実行する初期化処理。
 * applyI18n() → detectDirectoryPickerSupport() → fillUrlFromActiveTab() →
 * requestSnapshot() → loadStoredDirectoryHandle() の順で実行する。
 * @returns {Promise<void>} 初期化完了を表すPromise
 */
async function initialize() {
  applyI18n();
  syncQualityForFormat();
  detectDirectoryPickerSupport();
  await fillUrlFromActiveTab();
  await requestSnapshot();
  await loadStoredDirectoryHandle();
}

/**
 * window.showDirectoryPickerの有無を検出する。Brave等、プライバシー設定により
 * File System Access APIの各種pickerが既定でundefinedとなるブラウザでは、
 * 参照ボタンを押した時点で初めてTypeErrorとして表面化し、実際には保存に
 * 失敗していないにもかかわらずSAVE_FAILEDの誤ったエラー表示につながって
 * しまうため、初期化時点で先回りして検出し、参照/クリアボタンを無効化した上で
 * Downloadsフォルダへ保存される旨の中立的な注意書き(#picker-unsupported-notice)を
 * 表示する。対応ブラウザ(通常のChrome等)では何も変更せず、既存の挙動を維持する。
 * @returns {void}
 */
function detectDirectoryPickerSupport() {
  directoryPickerSupported = typeof window.showDirectoryPicker === "function";
  if (!directoryPickerSupported) {
    browseButton.title = chrome.i18n.getMessage("titleBrowseButtonUnsupported");
    pickerUnsupportedNotice.hidden = false;
  }
  updateControls();
}

/**
 * アクティブタブのURLを#url-inputへ設定する。
 * YouTube以外のURLでもここではブロックしない（検証はbackgroundが行う）。
 * @returns {Promise<void>} 設定完了を表すPromise
 */
async function fillUrlFromActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0] && typeof tabs[0].url === "string") {
    urlInput.value = tabs[0].url;
  }
}

/**
 * backgroundへprogress.snapshot.getを要求し、応答をapplyTask()へ渡す。
 * ただし復元されたtaskのstateがcompleted/errorの場合は、Popup新規オープン時に
 * 過去の結果が再表示されてしまうのを防ぐため、applyTask(null)を渡す
 * (進行中状態の復元、および実行中に受信するdownload.resultの表示は変更しない)。
 * @returns {Promise<void>} 要求完了を表すPromise
 */
async function requestSnapshot() {
  const requestId = `snap-${crypto.randomUUID()}`;
  const response = await chrome.runtime.sendMessage({
    type: "progress.snapshot.get",
    requestId,
  });
  const task = response ? response.task : null;
  if (task && (task.state === "completed" || task.state === "error")) {
    applyTask(null);
  } else {
    applyTask(task);
  }
}

/**
 * 保存先ディレクトリの書き込み権限を確認し、必要なら再許可を要求する。
 * queryPermissionが"prompt"の場合のみrequestPermissionを呼び出す。
 * ブラウザ再起動後は許可が失効し明示的な再許可が必須になるため
 * (T0スパイクで確認済みの挙動)、この関数はStartボタンのクリックハンドラ内から
 * 直接(コールバックを介さず)呼び出し、ユーザー操作起因の許可プロンプトとして
 * 機能させる。
 * @param {FileSystemDirectoryHandle} handle 確認対象のディレクトリハンドル
 * @returns {Promise<boolean>} 書き込み権限があればtrue
 */
async function ensureDirectoryPermission(handle) {
  const options = { mode: "readwrite" };
  const state = await handle.queryPermission(options);
  if (state === "granted") {
    return true;
  }
  if (state === "prompt") {
    const requested = await handle.requestPermission(options);
    return requested === "granted";
  }
  return false;
}

/**
 * 開始ボタンのクリックハンドラ。directoryHandleが存在する場合は
 * ensureDirectoryPermission()で書き込み権限を確認し、拒否されたら
 * SAVE_PERMISSION_DENIEDとして表示しdownload.startを送信しない。
 * 権限確認後、入力値を読みdownload.startを送信する
 * (outputDirは含めない。Offscreen Document側がIndexedDBから
 * ディレクトリハンドルを直接読み込むため)。
 * 応答がdownload.acceptedなら実行中状態へ遷移し、拒否応答なら
 * renderRejection()で表示する。isRunning/isBrowsePending中は
 * DOMのdisabledのみに依存せず先頭でガードする。
 * @returns {Promise<void>} 送信完了を表すPromise
 */
async function onStartClicked() {
  if (isRunning || isBrowsePending) {
    return;
  }
  if (directoryHandle) {
    const granted = await ensureDirectoryPermission(directoryHandle);
    if (!granted) {
      renderRejection({
        code: "SAVE_PERMISSION_DENIED",
        message: chrome.i18n.getMessage("error_SAVE_PERMISSION_DENIED"),
      });
      return;
    }
  }
  const requestId = `req-${crypto.randomUUID()}`;
  const response = await chrome.runtime.sendMessage({
    type: "download.start",
    requestId,
    url: urlInput.value,
    format: formatSelect.value,
    audioQuality,
    source: "popup",
  });
  if (response && response.type === "download.accepted") {
    currentTaskId = response.taskId;
    lastSequence = response.sequence;
    isRunning = true;
    updateControls();
    return;
  }
  if (response && response.type === "download.result" && response.state === "error") {
    renderRejection(response);
  }
}

/**
 * 「参照...」ボタンのクリックハンドラ。window.showDirectoryPicker()で
 * 保存先フォルダを選択させ、選択されたFileSystemDirectoryHandleをIndexedDBへ
 * 保存した上で、handle.name(絶対パスではなくフォルダ名。File System Access APIは
 * 絶対パスを公開しないため)を保存先欄へ反映する。isRunning中または
 * isBrowsePending中は即returnして多重実行を防ぐ。ユーザーによるキャンセル
 * (AbortError)は無視し、それ以外のエラーはSAVE_FAILEDとして表示する
 * (いずれもdirectoryHandle・表示欄は変更しない)。
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function onBrowseClicked() {
  if (isRunning || isBrowsePending) {
    return;
  }
  isBrowsePending = true;
  updateControls();
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await saveDirectoryHandle(handle);
    directoryHandle = handle;
    outputDirDisplay.value = handle.name;
  } catch (error) {
    if (error && error.name !== "AbortError") {
      resultText.textContent = `[SAVE_FAILED] ${resolveDisplayMessage("SAVE_FAILED", error.message)}`;
      resultArea.hidden = false;
    }
  } finally {
    isBrowsePending = false;
    updateControls();
  }
}

/**
 * 「クリア」ボタンのクリックハンドラ。IndexedDBの保存先ハンドルを削除し、
 * メモリ上のdirectoryHandleと保存先欄をリセットする
 * (未選択状態に戻り、以降はDownloadsフォルダへの自動保存にフォールバックする。
 * 実際の保存処理自体はOffscreen Document側の責務)。
 * isRunning中またはisBrowsePending中は即returnする。
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function onClearOutputDirClicked() {
  if (isRunning || isBrowsePending) {
    return;
  }
  await clearDirectoryHandle();
  directoryHandle = null;
  outputDirDisplay.value = "";
}

/**
 * 拒否応答専用の描画。#result-textに[code] messageを表示し、
 * #result-areaを表示した上でupdateControls()するだけで、
 * currentTaskId/lastSequence/isRunningは変更しない。
 * @param {object} result 拒否応答（download.result, state:"error"）
 * @returns {void}
 */
function renderRejection(result) {
  resultText.textContent = `[${result.code}] ${resolveDisplayMessage(result.code, result.message)}`;
  resultArea.hidden = false;
  updateControls();
}

/**
 * chrome.runtime.onMessageハンドラ。download.progress / download.resultを
 * applyTask()へ渡す。
 * @param {object} message 受信メッセージ
 * @returns {void}
 */
function onRuntimeMessage(message) {
  if (!message) {
    return;
  }
  if (message.type === "download.progress" || message.type === "download.result") {
    applyTask(message);
  }
}

chrome.runtime.onMessage.addListener(onRuntimeMessage);

/**
 * 唯一の描画入口。sequenceガード→状態別描画→コントロール活性制御の順で
 * 処理する（D5の判定順序）。
 * @param {object|null} task 表示対象のTaskSnapshot。存在しなければnull
 * @returns {void}
 */
function applyTask(task) {
  if (task === null) {
    stateText.textContent = chrome.i18n.getMessage("state_waiting");
    progressArea.hidden = true;
    resultArea.hidden = true;
    currentTaskId = null;
    isRunning = false;
    updateControls();
    return;
  }
  if (currentTaskId !== null && task.taskId !== currentTaskId) {
    return;
  }
  if (task.taskId === currentTaskId && task.sequence <= lastSequence) {
    return;
  }
  if (task.taskId !== currentTaskId && currentTaskId === null) {
    currentTaskId = task.taskId;
    lastSequence = -1;
  }
  lastSequence = task.sequence;
  renderProgress(task);
  if (task.state === "completed" || task.state === "error") {
    isRunning = false;
  } else {
    isRunning = true;
  }
  updateControls();
}

/**
 * 状態文・バー・詳細文を更新する（D5の表示規則）。
 * @param {object} task 表示対象のTaskSnapshot
 * @returns {void}
 */
function renderProgress(task) {
  switch (task.state) {
    case "starting":
      stateText.textContent = chrome.i18n.getMessage("state_starting");
      progressBar.removeAttribute("value");
      detailText.textContent = "";
      progressArea.hidden = false;
      resultArea.hidden = true;
      break;
    case "downloading": {
      stateText.textContent = chrome.i18n.getMessage("state_downloading");
      progressArea.hidden = false;
      resultArea.hidden = true;
      if (typeof task.percent === "number") {
        progressBar.value = task.percent;
      } else {
        progressBar.removeAttribute("value");
      }
      const parts = [];
      if (typeof task.percent === "number") {
        parts.push(`${task.percent.toFixed(1)}%`);
      }
      const speedText = formatBytesPerSecond(task.speedBytesPerSecond ?? null);
      if (speedText) {
        parts.push(speedText);
      }
      const etaText = formatEta(task.etaSeconds ?? null);
      if (etaText) {
        parts.push(etaText);
      }
      detailText.textContent = parts.join(" ・ ");
      break;
    }
    case "converting": {
      stateText.textContent = chrome.i18n.getMessage("state_converting");
      progressArea.hidden = false;
      resultArea.hidden = true;
      if (typeof task.percent === "number") {
        progressBar.value = task.percent;
      } else {
        progressBar.removeAttribute("value");
      }
      const parts = [];
      if (typeof task.percent === "number") {
        parts.push(`${task.percent.toFixed(1)}%`);
      }
      const durationText = formatConvertDuration(
        task.convertedSeconds ?? null,
        task.totalSeconds ?? null,
      );
      if (durationText) {
        parts.push(durationText);
      }
      detailText.textContent = parts.join(" ・ ");
      break;
    }
    case "completed":
      stateText.textContent = chrome.i18n.getMessage("state_completed");
      progressBar.value = 100;
      detailText.textContent = "";
      resultText.textContent = task.fileName ?? "";
      progressArea.hidden = true;
      resultArea.hidden = false;
      break;
    case "error":
      stateText.textContent = chrome.i18n.getMessage("state_error");
      resultText.textContent = `[${task.code}] ${resolveDisplayMessage(task.code, task.message)}`;
      progressArea.hidden = true;
      resultArea.hidden = false;
      break;
    default:
      break;
  }
}

/**
 * 速度を表示用文字列へ整形する。
 * @param {number|null} value バイト毎秒の速度
 * @returns {string} 整形済み文字列。nullは空文字
 */
function formatBytesPerSecond(value) {
  if (value === null || typeof value !== "number") {
    return "";
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
}

/**
 * 残り秒数を表示用文字列へ整形する。
 * @param {number|null} value 残り秒数
 * @returns {string} 整形済み文字列。nullは空文字
 */
function formatEta(value) {
  if (value === null || typeof value !== "number") {
    return "";
  }
  return chrome.i18n.getMessage("etaRemaining", [String(value)]);
}

/**
 * 秒数をmm:ss形式へ整形する。
 * @param {number} value 秒数
 * @returns {string} "mm:ss"形式の文字列
 */
function formatMinutesSeconds(value) {
  const totalSeconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 変換済み秒数/合計秒数を"mm:ss / mm:ss"形式へ整形する。
 * @param {number|null} convertedSeconds 変換済み秒数
 * @param {number|null} totalSeconds 合計秒数(動画の長さ)
 * @returns {string} 整形済み文字列。どちらもnullなら空文字
 */
function formatConvertDuration(convertedSeconds, totalSeconds) {
  if (typeof convertedSeconds !== "number" && typeof totalSeconds !== "number") {
    return "";
  }
  const convertedText =
    typeof convertedSeconds === "number" ? formatMinutesSeconds(convertedSeconds) : "?";
  const totalText = typeof totalSeconds === "number" ? formatMinutesSeconds(totalSeconds) : "?";
  return `${convertedText} / ${totalText}`;
}

/**
 * #url-input #format-select #start-button #browse-button #clear-output-dir-buttonの
 * disabledをisRunning/isBrowsePendingに基づいて一括設定する。
 * #browse-button/#clear-output-dir-buttonはさらにdirectoryPickerSupportedがfalseの間、
 * isRunning/isBrowsePendingの状態によらず常時disabledとする。
 * @returns {void}
 */
/**
 * 現在選択中のformatがロスレス形式(wav/flac)かどうかを判定する。
 * @returns {boolean} ロスレス形式ならtrue
 */
function isLosslessFormat() {
  return LOSSLESS_FORMATS.includes(formatSelect.value);
}

/**
 * formatの変更に合わせて音質選択欄の有効/無効を同期する。
 * ロスレス形式選択時は音質選択を"standard"へリセットし
 * (ロスレス形式にビットレート指定は無意味なため)、
 * updateControls()でdisabled状態を反映する。
 */
function syncQualityForFormat() {
  if (isLosslessFormat()) {
    qualitySelect.value = "standard";
    audioQuality = "standard";
  }
  updateControls();
}

function updateControls() {
  const interactionDisabled = isRunning || isBrowsePending;
  urlInput.disabled = interactionDisabled;
  formatSelect.disabled = interactionDisabled;
  qualitySelect.disabled = interactionDisabled || isLosslessFormat();
  startButton.disabled = interactionDisabled;
  browseButton.disabled = interactionDisabled || !directoryPickerSupported;
  clearOutputDirButton.disabled = interactionDisabled || !directoryPickerSupported;
}

/**
 * #quality-selectの変更ハンドラ。選択値をaudioQuality変数へ反映する。
 * @returns {void}
 */
function onQualityChanged() {
  audioQuality = qualitySelect.value;
}

startButton.addEventListener("click", onStartClicked);
browseButton.addEventListener("click", onBrowseClicked);
clearOutputDirButton.addEventListener("click", onClearOutputDirClicked);
qualitySelect.addEventListener("change", onQualityChanged);
formatSelect.addEventListener("change", syncQualityForFormat);
document.addEventListener("DOMContentLoaded", initialize);

// jestからのテスト用エクスポート。拡張機能としての読み込み時は
// moduleが存在しないため、この分岐には入らない。
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    initialize,
    detectDirectoryPickerSupport,
    applyI18n,
    resolveDisplayMessage,
    fillUrlFromActiveTab,
    requestSnapshot,
    openSettingsDb,
    saveDirectoryHandle,
    loadDirectoryHandle,
    clearDirectoryHandle,
    loadStoredDirectoryHandle,
    ensureDirectoryPermission,
    onStartClicked,
    onBrowseClicked,
    onClearOutputDirClicked,
    onQualityChanged,
    onRuntimeMessage,
    applyTask,
    renderProgress,
    renderRejection,
    formatBytesPerSecond,
    formatEta,
    formatConvertDuration,
    updateControls,
    __resetStateForTest: () => {
      currentTaskId = null;
      lastSequence = -1;
      isRunning = false;
      directoryHandle = null;
      audioQuality = "standard";
      isBrowsePending = false;
      directoryPickerSupported = true;
    },
    __getStateForTest: () => ({
      currentTaskId,
      lastSequence,
      isRunning,
      directoryHandle,
      audioQuality,
      isBrowsePending,
      directoryPickerSupported,
    }),
    __setDirectoryHandleForTest: (handle) => {
      directoryHandle = handle;
    },
  };
}
