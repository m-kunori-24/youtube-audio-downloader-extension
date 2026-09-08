// background.js
// Popupからの開始要求を受け取り、YouTubeタブへpage-relay(ISOLATED world)と
// page-agent(MAIN world)をオンデマンド注入して音声を取得し、Offscreen Document側の
// 変換・保存を指揮する。最新状態はTaskSnapshotとしてchrome.storage.localへ保存し、
// 開いているPopupへ転送する。完了・失敗時はブラウザ通知を表示する。
//
// 音声バイト列そのものはSWを経由しない(page-relay → Offscreenへ直接Port転送される)。
// SWが扱うのは制御メッセージと進捗のみ。

const ALLOWED_FORMATS = ["mp3", "aac", "m4a", "opus", "vorbis", "wav", "flac"];
const DEFAULT_FORMAT = "mp3";
const ALLOWED_AUDIO_QUALITIES = ["standard", "high", "best"];
const DEFAULT_AUDIO_QUALITY = "standard";
const SNAPSHOT_KEY = "youtubeAudioDownloader.snapshot";
const MAX_PROGRESS_BASIS_ENTRIES = 32;
const RUNNING_STATES = ["starting", "downloading", "converting"];

// YouTube動画URLの判定パターン(Popupから渡されたURLの検証用)。
const YOUTUBE_WATCH_PATTERN = /^https:\/\/(www\.)?youtube\.com\/watch\?[^#]*\bv=[^&]+/;
const YOUTU_BE_PATTERN = /^https:\/\/youtu\.be\/[^/?#]+/;

// 注入先タブの判定(Q4: 現在開いているタブを使う)。T4-T6の実証により
// 動画再生ページである必要はなく、youtube.com配下であればどのページでもよい。
const YOUTUBE_TAB_URL_MATCH = "https://www.youtube.com/*";
const YOUTUBE_TAB_URL_PATTERN = /^https:\/\/www\.youtube\.com\//;

const PAGE_RELAY_FILE = "dist/page-relay.js";
const PAGE_AGENT_FILE = "dist/page-agent.js";

const OFFSCREEN_URL = "offscreen.html";
const OFFSCREEN_REASONS = ["WORKERS"];
const OFFSCREEN_JUSTIFICATION = "audio transfer + encoding";

// Gap1 §2のプレイヤーJSフォールバック状態。knownGoodは永続(local)、
// 拒否リストはブラウザセッション限り(session)。
const PLAYER_JS_KEY = "playerJs";
const PLAYER_JS_REJECTED_KEY = "playerJsRejected";
// 拒否エントリの有効期限。sessionストレージ自体がブラウザ再起動で消えるため、
// これは「同一セッション中に候補を永久に締め出さない」ための上限。
const PLAYER_JS_REJECTED_TTL_MS = 6 * 60 * 60 * 1000;

// SW再起動復帰時にOffscreenへconvert.statusを問い合わせる際の待ち時間。
const CONVERT_STATUS_TIMEOUT_MS = 3000;

// SW再起動復帰時、転送中のまま進捗が止まっているタスクを回復不能と判断する閾値。
// src/converter/transfer.mjs の INACTIVITY_TIMEOUT_MS と同値。
const TRANSFER_STALL_RECOVERY_MS = 120 * 1000;

// transfer完了後にpage.resultが遅れて届く正規の猶予。これを過ぎても決着しなければ結果は失われたとみなす。
const AGENT_RESULT_GRACE_MS = 30 * 1000;

// chrome.downloads.searchでダウンロード項目を確認する際の試行ごとの待ち時間(finding: 履歴消失対策)。
// 配列長がそのまま最大試行回数になる。0番目は待たずに即実行する。
const DOWNLOAD_RECONCILE_DELAYS_MS = [0, 500, 1500, 3000];

// Offscreen(src/converter/index.js)がconvert.statusのoffscreenStateとして返す状態語。
// "awaiting-download"は「変換完了・chrome.downloads側は未終端」(保存先未選択時=Q2)を指す。
const OFFSCREEN_STATES = ["transferring", "ready", "converting", "awaiting-download", "done", "failed"];

// notifications.create の iconUrl は必須のため、追加ファイルを増やさず
// 1x1の透明PNGをdata URIとして埋め込む。
const NOTIFICATION_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// エラーcodeから、messages.jsonのローカライズ済みメッセージキーへのマップ。
// popup.js側のERROR_MESSAGE_KEY_BY_CODEと同型(ESモジュール共有化は
// manifest.json/popup.html/Jest読み込み方式の変更を要するため見送り、
// コード重複を許容する)。ここに載っていないcodeは生のmessageをそのまま使う。
const ERROR_MESSAGE_KEY_BY_CODE = {
  INVALID_URL: "error_INVALID_URL",
  INVALID_FORMAT: "error_INVALID_FORMAT",
  INVALID_AUDIO_QUALITY: "error_INVALID_AUDIO_QUALITY",
  TASK_ALREADY_RUNNING: "error_TASK_ALREADY_RUNNING",
  // 認証
  AUTH_NOT_LOGGED_IN: "error_AUTH_NOT_LOGGED_IN",
  AUTH_REJECTED: "error_AUTH_REJECTED",
  // 動画側の事情
  VIDEO_LOGIN_REQUIRED: "error_VIDEO_LOGIN_REQUIRED",
  VIDEO_AGE_RESTRICTED: "error_VIDEO_AGE_RESTRICTED",
  VIDEO_UNPLAYABLE: "error_VIDEO_UNPLAYABLE",
  VIDEO_UNAVAILABLE: "error_VIDEO_UNAVAILABLE",
  VIDEO_LIVE: "error_VIDEO_LIVE",
  VIDEO_DRM: "error_VIDEO_DRM",
  VIDEO_NO_AUDIO_FORMAT: "error_VIDEO_NO_AUDIO_FORMAT",
  // YouTube側変更による破損(要拡張機能更新)
  PLAYER_JS_UNAVAILABLE: "error_PLAYER_JS_UNAVAILABLE",
  EXTRACT_NSIG_FAILED: "error_EXTRACT_NSIG_FAILED",
  NSIG_REJECTED_BY_SERVER: "error_NSIG_REJECTED_BY_SERVER",
  // ネットワーク・配信サーバー
  STREAM_URL_EXPIRED: "error_STREAM_URL_EXPIRED",
  SABR_SERVER_ERROR: "error_SABR_SERVER_ERROR",
  SABR_NETWORK_UNREACHABLE: "error_SABR_NETWORK_UNREACHABLE",
  // page-agent(T8)は同じ事象をNETWORK_UNREACHABLEというcodeで返すため、
  // 同一の訳文へ寄せる(messages.json側のキー名との差異は既知)。
  NETWORK_UNREACHABLE: "error_SABR_NETWORK_UNREACHABLE",
  FETCH_STALLED: "error_FETCH_STALLED",
  FETCH_TIMEOUT: "error_FETCH_TIMEOUT",
  PLAYER_REQUEST_FAILED: "error_PLAYER_REQUEST_FAILED",
  // 転送・変換・保存(Offscreen側)
  TAB_UNAVAILABLE: "error_TAB_UNAVAILABLE",
  TRANSFER_INCOMPLETE: "error_TRANSFER_INCOMPLETE",
  TRANSFER_SEQ_GAP: "error_TRANSFER_SEQ_GAP",
  TRANSFER_OFFSET_MISMATCH: "error_TRANSFER_OFFSET_MISMATCH",
  TRANSFER_SIZE_MISMATCH: "error_TRANSFER_SIZE_MISMATCH",
  TRANSFER_WRITE_FAILED: "error_TRANSFER_WRITE_FAILED",
  CONVERT_UNSUPPORTED: "error_CONVERT_UNSUPPORTED",
  CONVERT_FAILED: "error_CONVERT_FAILED",
  CONVERT_STALLED: "error_CONVERT_STALLED",
  SAVE_PERMISSION_DENIED: "error_SAVE_PERMISSION_DENIED",
  SAVE_NO_DIRECTORY: "error_SAVE_NO_DIRECTORY",
  SAVE_FAILED: "error_SAVE_FAILED",
  // SW内部・注入パイプラインの障害
  SW_RESTARTED: "error_SW_RESTARTED",
  OFFSCREEN_UNAVAILABLE: "error_OFFSCREEN_UNAVAILABLE",
  INJECTION_FAILED: "error_INJECTION_FAILED",
  RELAY_PORT_DISCONNECTED: "error_RELAY_PORT_DISCONNECTED",
  RELAY_IDLE: "error_RELAY_IDLE",
};

// Popupが表示の出し分けに使うカテゴリ(詳細設計2.2)。
// 明示マップに無いcodeはERROR_CATEGORY_PREFIXESの接頭辞規則、
// それにも当たらなければDEFAULT_ERROR_CATEGORYへ落とす。接頭辞規則を置くのは、
// Offscreen(T10)が将来増やすcodeをSW側の改修なしに正しく分類するため。
const ERROR_CATEGORY_BY_CODE = {
  AUTH_NOT_LOGGED_IN: "auth",
  AUTH_REJECTED: "auth",
  // 年齢確認・ログイン要求は「ログインし直せば解決しうる」ためauth扱いにする。
  VIDEO_LOGIN_REQUIRED: "auth",
  VIDEO_AGE_RESTRICTED: "auth",
  PLAYER_JS_UNAVAILABLE: "breakage",
  EXTRACT_NSIG_FAILED: "breakage",
  NSIG_REJECTED_BY_SERVER: "breakage",
  STREAM_URL_EXPIRED: "network",
  SABR_SERVER_ERROR: "network",
  SABR_NETWORK_UNREACHABLE: "network",
  NETWORK_UNREACHABLE: "network",
  PLAYER_REQUEST_FAILED: "network",
  CONVERT_UNSUPPORTED: "breakage",
  CONVERT_FAILED: "internal",
  // 変換の無進捗打ち切り(Offscreen側の監視タイマー起因)は内部障害として扱う。
  CONVERT_STALLED: "internal",
};

const ERROR_CATEGORY_PREFIXES = [
  ["AUTH_", "auth"],
  ["VIDEO_", "video"],
  ["SAVE_", "save"],
  ["FETCH_", "network"],
  ["NETWORK_", "network"],
  ["SABR_", "network"],
];

const DEFAULT_ERROR_CATEGORY = "internal";

/**
 * エラーcodeをPopup表示用のカテゴリへ分類する(詳細設計2.2)。
 * @param {string|undefined} code エラーコード
 * @returns {string} "auth"/"video"/"network"/"save"/"breakage"/"internal"のいずれか
 */
function categorizeError(code) {
  if (typeof code !== "string" || code.length === 0) {
    return DEFAULT_ERROR_CATEGORY;
  }
  const mapped = ERROR_CATEGORY_BY_CODE[code];
  if (mapped !== undefined) {
    return mapped;
  }
  for (const [prefix, category] of ERROR_CATEGORY_PREFIXES) {
    if (code.startsWith(prefix)) {
      return category;
    }
  }
  return DEFAULT_ERROR_CATEGORY;
}

/**
 * エラーcodeに対応するローカライズ済みメッセージを解決する。
 * ERROR_MESSAGE_KEY_BY_CODEに載っている既知のcodeはmessages.jsonの
 * 訳文を優先し、未知のcodeの場合のみfallbackMessageをそのまま返す。
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
 * resolveDisplayMessage()のラッパー。応答メッセージ組み立て時に
 * codeとfallbackMessageから表示用メッセージを得るために使う。
 * @param {string|undefined} code エラーコード
 * @param {string|undefined} fallbackMessage 未知のcode時に表示するメッセージ
 * @returns {string} 表示用メッセージ
 */
function errorMessageFor(code, fallbackMessage) {
  return resolveDisplayMessage(code, fallbackMessage);
}

let activeTaskId = null; // string | null
let lastSequence = -1; // number
let activeTask = null; // 実行中タスクの付帯情報 | null
let activePipeline = null; // Promise<void> | null。注入〜結果受領までの進行中処理
let offscreenSetup = null; // Promise<void> | null。Offscreen生成の多重実行防止

/**
 * onMessageの唯一の入口。typeで分岐する。sendResponseを使う要求のみtrueを返す。
 * page.* / audio.* / convert.* はSWからの応答を必要としない片方向通知のため
 * falseを返す(応答チャネルを開いたままにしない)。
 *
 * 実処理はいずれもrecoveryDone(起動時復元)の完了後に走らせる。復元中に届いた
 * download.startが復元処理と競合して状態を壊すのを防ぐため(finding 16)。
 * trueを返す分岐は、復元待ちの間も応答チャネルを開いたままにするために
 * 同期的にtrueを返す点が重要。
 * @param {unknown} message 受信メッセージ
 * @param {chrome.runtime.MessageSender} sender 送信元
 * @param {(response: object) => void} sendResponse 応答関数
 * @returns {boolean} 非同期応答を行う場合はtrue
 */
function handleRuntimeMessage(message, sender, sendResponse) {
  if (!isPlainObject(message)) {
    return false;
  }
  if (message.type === "download.start") {
    afterRecovery(() => handleDownloadStart(message)).then(sendResponse);
    return true;
  }
  if (message.type === "progress.snapshot.get") {
    afterRecovery(() => handleSnapshotGet(message)).then(sendResponse);
    return true;
  }
  if (message.type === "page.status") {
    afterRecovery(() => handlePageStatus(message));
    return false;
  }
  if (message.type === "page.result") {
    afterRecovery(() => handleAgentResult(message.taskId, message.result));
    return false;
  }
  if (message.type === "page.relay.failed") {
    afterRecovery(() => handleRelayFailed(message));
    return false;
  }
  if (message.type === "audio.transfer.complete") {
    afterRecovery(() => handleTransferComplete(message));
    return false;
  }
  if (message.type === "audio.transfer.failed") {
    afterRecovery(() => handleTransferFailed(message));
    return false;
  }
  if (message.type === "convert.progress") {
    afterRecovery(() => handleConvertProgress(message));
    return false;
  }
  if (message.type === "convert.result") {
    afterRecovery(() => handleConvertResult(message));
    return false;
  }
  if (message.type === "downloads.checkExists") {
    checkDownloadsFolderCollision(message.fileName).then(sendResponse);
    return true;
  }
  return false;
}

/**
 * 起動時復元(recoveryDone)の完了後に実処理を走らせる(finding 16)。
 * @param {() => Promise<unknown>} handler 実処理
 * @returns {Promise<unknown>} 実処理の完了を表すPromise
 */
function afterRecovery(handler) {
  return recoveryDone.then(handler);
}

chrome.runtime.onMessage.addListener(handleRuntimeMessage);

// 保存先未選択時(Q2)のchrome.downloads側の終端状態を監視する(finding 9)。
// 戻り値のPromiseはChromeからは無視されるが、テストが完了を待てるように返す。
chrome.downloads.onChanged.addListener((delta) => afterRecovery(() => handleDownloadsChanged(delta)));

/**
 * 値がプレーンオブジェクト（null以外のobject）かどうかを判定する。
 * @param {unknown} value 判定対象
 * @returns {boolean} プレーンオブジェクトならtrue
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null;
}

/**
 * 現在時刻をUTCのISO 8601文字列で返す。
 * @returns {string} ISO 8601形式の時刻文字列
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * 指定ミリ秒だけ待つ。
 * @param {number} ms 待ち時間(ミリ秒)
 * @returns {Promise<void>} 経過を表すPromise
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * codeを持つErrorを作る。タスク実行中の失敗要因を呼び出し元へ伝えるために使う。
 * @param {string} code エラーコード
 * @param {string} message 未知code時のフォールバック文言
 * @returns {Error} code付きError
 */
function makeTaskError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * URLがダウンロード対象として許可されたYouTube動画URLかどうかを判定する。
 * @param {string} url 判定対象のURL
 * @returns {boolean} 許可されたURLならtrue
 */
function isAllowedYoutubeUrl(url) {
  return YOUTUBE_WATCH_PATTERN.test(url) || YOUTU_BE_PATTERN.test(url);
}

/**
 * 許可済みYouTube URLから動画IDを取り出す。
 * @param {string} url isAllowedYoutubeUrl()を満たすURL
 * @returns {string|null} 動画ID。取り出せなければnull
 */
function extractVideoId(url) {
  const watch = /[?&]v=([^&#]+)/.exec(url);
  if (watch !== null) {
    return watch[1];
  }
  const short = /^https:\/\/youtu\.be\/([^/?#]+)/.exec(url);
  return short !== null ? short[1] : null;
}

/**
 * download.startリクエストのurl/format/audioQualityを検証する。
 * format未指定時はDEFAULT_FORMATを補完する。audioQualityは既知の3値
 * ("standard"/"high"/"best")以外・未指定ならDEFAULT_AUDIO_QUALITYへ
 * 補完する(明示的な不正値のみ拒否する)。
 * @param {object} message 受信したdownload.startメッセージ
 * @returns {{ok: true, url: string, videoId: string, format: string, audioQuality: string} | {ok: false, code: string, message: string}}
 */
function validateStartRequest(message) {
  const url = typeof message.url === "string" ? message.url : "";
  const videoId = isAllowedYoutubeUrl(url) ? extractVideoId(url) : null;
  if (videoId === null) {
    return {
      ok: false,
      code: "INVALID_URL",
      message: errorMessageFor("INVALID_URL", "YouTubeの動画URLではありません。"),
    };
  }
  const format =
    typeof message.format === "string" && message.format.length > 0
      ? message.format
      : DEFAULT_FORMAT;
  if (!ALLOWED_FORMATS.includes(format)) {
    return {
      ok: false,
      code: "INVALID_FORMAT",
      message: errorMessageFor("INVALID_FORMAT", "対応していない音声形式です。"),
    };
  }
  let audioQuality = DEFAULT_AUDIO_QUALITY;
  if (message.audioQuality !== undefined) {
    if (!ALLOWED_AUDIO_QUALITIES.includes(message.audioQuality)) {
      return {
        ok: false,
        code: "INVALID_AUDIO_QUALITY",
        message: errorMessageFor("INVALID_AUDIO_QUALITY", "対応していない音質です。"),
      };
    }
    audioQuality = message.audioQuality;
  }
  return { ok: true, url, videoId, format, audioQuality };
}

/**
 * IDLE判定とactiveTaskId/activeTaskの確定を不可分に行う同期関数。
 * awaitを一切含まない（R3、H3回帰防止）。
 * @param {string} url ダウンロード対象URL
 * @param {string} format 検証済みの音声形式
 * @param {string} [videoId] 動画ID
 * @param {string} [audioQuality] 検証済みの音質プリセット
 * @returns {{ok: true, taskId: string, snapshot: object} | {ok: false, code: string, message: string}}
 */
function claimTask(url, format, videoId, audioQuality) {
  if (activeTaskId !== null) {
    return {
      ok: false,
      code: "TASK_ALREADY_RUNNING",
      message: errorMessageFor("TASK_ALREADY_RUNNING", "別のダウンロードが実行中です。"),
    };
  }
  const taskId = `task-${crypto.randomUUID()}`;
  activeTaskId = taskId;
  lastSequence = 0;
  activeTask = {
    taskId,
    url,
    format,
    videoId: videoId ?? extractVideoId(url),
    audioQuality: audioQuality ?? DEFAULT_AUDIO_QUALITY,
    agentResult: null, // page-agentの成功結果 | null
    agentSettled: false, // boolean。永続化まで完了した「決着済み」を表す(SW再起動後も復元可能)
    agentHandling: false, // boolean。メモリ上だけの再入防止フラグ。二重送達の片方のみ処理する
    agentGraceScheduled: false, // boolean。転送完了後の猶予チェックを予約済みか(多重予約防止)
    transfer: null, // Offscreenからのaudio.transfer.complete | null
    conversionStarted: false, // boolean
  };
  const snapshot = {
    type: "download.progress",
    taskId,
    sequence: 0,
    state: "starting",
    phase: "download",
    percent: null,
    downloadedBytes: null,
    totalBytes: null,
    speedBytesPerSecond: null,
    etaSeconds: null,
    format,
    url,
    progressMaxByBasis: {},
    timestamp: nowIso(),
  };
  return { ok: true, taskId, snapshot };
}

/**
 * claimTaskが返したstartingスナップショットを保存する。
 * @param {object} snapshot claimTaskが組み立てたTaskSnapshot
 * @returns {Promise<void>} 保存完了を表すPromise
 */
async function persistStartingSnapshot(snapshot) {
  await saveSnapshot(snapshot);
}

/**
 * download.accepted応答を組み立てる（R5.1）。
 * @param {string} requestId 開始要求のrequestId
 * @param {object} snapshot claimTaskが返したstartingスナップショット
 * @returns {object} download.accepted応答
 */
function buildAccepted(requestId, snapshot) {
  return {
    type: "download.accepted",
    requestId,
    taskId: snapshot.taskId,
    sequence: snapshot.sequence,
    state: snapshot.state,
    phase: snapshot.phase,
    percent: snapshot.percent,
    format: snapshot.format,
    url: snapshot.url,
    timestamp: snapshot.timestamp,
  };
}

/**
 * 拒否応答（download.result形、taskId/sequenceはnull）を組み立てる。
 * storageは上書きしない（R5.2）。
 * @param {string} requestId 開始要求のrequestId
 * @param {string} code エラーコード
 * @param {string} message 表示用メッセージ
 * @returns {object} 拒否応答
 */
function buildRejection(requestId, code, message) {
  return {
    type: "download.result",
    requestId,
    taskId: null,
    sequence: null,
    state: "error",
    code,
    category: categorizeError(code),
    message,
    timestamp: nowIso(),
  };
}

/**
 * download.startを処理する。
 * 【重要】関数先頭からclaimTask()の呼び出しまでの間にawaitを書いてはならない。
 * 注入以降の実処理はrunTask()へ委ね、Popupへは即座にdownload.acceptedを返す。
 * @param {object} message 受信したdownload.startメッセージ
 * @returns {Promise<object>} sendResponseへ渡す応答
 */
async function handleDownloadStart(message) {
  // ---- ここから同期区間（await禁止）----
  const validated = validateStartRequest(message);
  if (!validated.ok) {
    return buildRejection(message.requestId, validated.code, validated.message);
  }
  const claim = claimTask(validated.url, validated.format, validated.videoId, validated.audioQuality);
  if (!claim.ok) {
    return buildRejection(message.requestId, claim.code, claim.message);
  }
  // ---- ここまで同期区間。activeTaskIdは確定済み ----

  await persistStartingSnapshot(claim.snapshot);
  activePipeline = runTask(claim.taskId);
  return buildAccepted(message.requestId, claim.snapshot);
}

/**
 * progress.snapshot.getを処理する。
 * @param {object} message 受信したprogress.snapshot.getメッセージ
 * @returns {Promise<object>} 保存済みスナップショットを含む応答
 */
async function handleSnapshotGet(message) {
  const task = await loadSnapshot();
  return { type: "progress.snapshot", requestId: message.requestId, task };
}

/**
 * タスク本体。Offscreen確保 → タブ取得 → page-relay/page-agent注入 の順に進める(Gap2 §1)。
 * page-agentの結果はリレー経由のpage.result(handleRuntimeMessage → handleAgentResult)で
 * のみ届く。executeScriptの戻り値による結果送達は廃止した。
 * 途中の失敗はcode付きの結果スナップショットへ変換してタスクを終了させる。
 * @param {string} taskId claimTaskが発行したtaskId
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function runTask(taskId) {
  try {
    await ensureOffscreenDocument();
    const tabId = await acquireYoutubeTab();
    const agentCfg = await buildAgentConfig(taskId);
    await injectPageScripts(tabId, taskId, agentCfg);
  } catch (error) {
    if (activeTaskId !== taskId) {
      return;
    }
    const code = error && typeof error.code === "string" ? error.code : "INJECTION_FAILED";
    const fallback =
      error && typeof error.message === "string" ? error.message : "音声の取得を開始できませんでした。";
    await failTask(code, fallback);
  }
}

/**
 * Offscreen Documentの存在を保証する(Gap2 §1のstep 0)。
 * 生成中の多重呼び出しは同じPromiseを共有する。失敗した場合は次回再試行できるよう
 * キャッシュを破棄する。
 * @returns {Promise<void>} 確保完了を表すPromise
 */
function ensureOffscreenDocument() {
  if (offscreenSetup === null) {
    offscreenSetup = createOffscreenDocumentIfAbsent().catch((error) => {
      offscreenSetup = null;
      throw makeTaskError(
        "OFFSCREEN_UNAVAILABLE",
        error && typeof error.message === "string" ? error.message : "Offscreen Documentを作成できません。",
      );
    });
  }
  return offscreenSetup;
}

/**
 * Offscreen Documentが無ければ作る。
 * @returns {Promise<void>} 作成完了を表すPromise
 */
async function createOffscreenDocumentIfAbsent() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (Array.isArray(contexts) && contexts.length > 0) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: OFFSCREEN_REASONS,
    justification: OFFSCREEN_JUSTIFICATION,
  });
}

/**
 * 注入先のYouTubeタブを決める(Q4)。現在アクティブなタブがyoutube.com配下なら
 * それを使い、そうでなければ開いている任意のyoutube.comタブを使う。
 * どちらも無ければTAB_UNAVAILABLEで失敗させる(新規タブは開かない)。
 * @returns {Promise<number>} 注入先タブのID
 */
async function acquireYoutubeTab() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeYoutubeTab = (Array.isArray(activeTabs) ? activeTabs : []).find(isUsableYoutubeTab);
  if (activeYoutubeTab !== undefined) {
    return activeYoutubeTab.id;
  }
  const anyTabs = await chrome.tabs.query({ url: YOUTUBE_TAB_URL_MATCH });
  const fallbackTab = (Array.isArray(anyTabs) ? anyTabs : []).find(isUsableYoutubeTab);
  if (fallbackTab === undefined) {
    throw makeTaskError("TAB_UNAVAILABLE", "YouTubeのタブが開かれていません。");
  }
  return fallbackTab.id;
}

/**
 * タブが注入先として使えるか(youtube.com配下かつIDを持つか)を判定する。
 * @param {object} tab chrome.tabs.Tab
 * @returns {boolean} 使えるならtrue
 */
function isUsableYoutubeTab(tab) {
  return (
    isPlainObject(tab) &&
    typeof tab.id === "number" &&
    typeof tab.url === "string" &&
    YOUTUBE_TAB_URL_PATTERN.test(tab.url)
  );
}

/**
 * page-agentへ渡すcfgを組み立てる。playerJsはGap1 §2の永続状態から読む。
 * stallTimeoutMs/maxDurationMsはpage-agent側の既定値に委ねるため指定しない。
 * secretはpage-agent⇔page-relay間のフレーム署名鍵で、タスクごとに32バイトを
 * 新規生成する(hex)。永続化せず、注入時にcfgとして渡すだけで保持しない。
 * @param {string} taskId 発行済みのtaskId
 * @returns {Promise<object>} page-agentのcfg
 */
async function buildAgentConfig(taskId) {
  const playerJs = await loadPlayerJsConfig();
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(secretBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    taskId,
    secret,
    videoId: activeTask.videoId,
    qualityTier: activeTask.audioQuality,
    playerJs,
  };
}

/**
 * page-relay(ISOLATED world)→page-agent(MAIN world)の順にオンデマンド注入する
 * (Gap2 §1)。リレーを先に起動しておくことで、page-agentが最初に送るstatus/beginを
 * 取りこぼさない。page-agentへのcfg受け渡しは2段階で行う:
 *   1. func注入でglobalThis.__ytaCfgへcfgを書き込む(fail-closed: 既にnon-configurableな
 *      同名プロパティがあれば失敗とみなしINJECTION_FAILED)
 *   2. バンドル本体を注入する(バンドルが__ytaCfgを読み取って自走する)
 * 戻り値経路は持たず、結果はリレー経由のpage.resultでのみ届く。
 * @param {number} tabId 注入先タブのID
 * @param {string} taskId 発行済みのtaskId
 * @param {object} agentCfg page-agentへ渡すcfg(secretを含む)
 * @returns {Promise<void>} 注入完了を表すPromise
 */
async function injectPageScripts(tabId, taskId, agentCfg) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: [PAGE_RELAY_FILE],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (cfg) => globalThis.__ytaRelay.start(cfg),
    args: [{ taskId, secret: agentCfg.secret }],
  });
  const handoff = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (cfg) => {
      try {
        const d = Object.getOwnPropertyDescriptor(globalThis, "__ytaCfg");
        if (d && !d.configurable) return { ok: false };
        if (d) delete globalThis.__ytaCfg;
        Object.defineProperty(globalThis, "__ytaCfg", { value: cfg, writable: false, configurable: true, enumerable: false });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    args: [agentCfg],
  });
  const handoffResult = Array.isArray(handoff) && handoff.length > 0 ? handoff[0].result : undefined;
  if (!isPlainObject(handoffResult) || handoffResult.ok !== true) {
    throw makeTaskError("INJECTION_FAILED", "ページへ設定を受け渡せませんでした。");
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: [PAGE_AGENT_FILE],
  });
}

/**
 * page-agentの結果を処理する。executeScriptの戻り値とpage.resultの二重送達
 * (Gap2、SW再起動耐性)のうち先に届いた方だけを採用する。
 * 成功時は音声バイト列がOffscreenへ転送済み・転送中のため、ここではタスクを
 * 終了させず、audio.transfer.completeの到着を待って変換へ進む。
 * 出力ファイル名はこの時点で確定させてスナップショットへ永続化する。SWが転送中に
 * 再起動した場合、「fileNameが保存済みかどうか」がagent settled済みかの判定材料に
 * なるため(finding 10)。
 *
 * agentSettledは「永続化まで終わった」ことだけを意味する。永続化の完了前に立てると、
 * その隙間でSWが落ちた際に復元側がagentSettled=falseと判定し、二度と再送されない
 * page.resultを待ち続けて停滞するため(finding: 決着の耐久性)。成功経路では
 * persistSnapshotFields()の成功を確認してから立てる。永続化中の再入は、
 * メモリ上だけのagentHandlingで防ぐ。
 * 永続化できなかった場合・途中で例外が出た場合は、決着しないまま停滞させず
 * SW_RESTARTEDで明示的に失敗させる(タスクが切り替わっていなければ)。
 * @param {string} taskId page-agentが動いていたtaskId
 * @param {object|undefined} result page-agentのrun()結果
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function handleAgentResult(taskId, result) {
  if (activeTaskId === null || taskId !== activeTaskId || activeTask === null) {
    return;
  }
  if (activeTask.agentSettled || activeTask.agentHandling) {
    return;
  }
  // await前に同期的に立てて、ほぼ同時の二重送達を弾く。
  activeTask.agentHandling = true;
  try {
    if (!isPlainObject(result)) {
      activeTask.agentSettled = true;
      await failTask("INJECTION_FAILED", "ページ側から結果を受け取れませんでした。");
      return;
    }

    await persistPlayerJsOutcome(result);
    if (activeTaskId !== taskId || activeTask === null) {
      return;
    }

    if (result.ok !== true) {
      // 失敗経路のfailTask()自体が永続化を伴うため、ここでagentSettledを先に立ててよい。
      activeTask.agentSettled = true;
      const code = typeof result.code === "string" ? result.code : "SABR_SERVER_ERROR";
      await failTask(code, "音声の取得に失敗しました。");
      return;
    }
    const fileName = buildFileName(result.title, activeTask.videoId);
    const persisted = await persistSnapshotFields(taskId, {
      fileName,
      audioQuality: activeTask.audioQuality,
    });
    if (!persisted) {
      // 永続化できなかった以上、agentSettledは立てられず、再送もされない。
      // 実行中のまま放置すると永久に停滞するため、明示的に失敗させる。
      await failCurrentTaskAsRestarted(taskId);
      return;
    }
    if (activeTaskId !== taskId || activeTask === null) {
      return;
    }
    activeTask.agentResult = result;
    activeTask.fileName = fileName;
    activeTask.agentSettled = true;
    await maybeStartConversion();
  } catch (error) {
    // 途中で例外が出た場合もagentSettledが立たないまま停滞するため、明示的に失敗させる。
    await failCurrentTaskAsRestarted(taskId);
  }
}

/**
 * handleAgentResult()が決着させられなかったタスクを、まだ実行中である場合に限り
 * SW_RESTARTEDで失敗させる。既に別タスクへ切り替わっていれば何もしない
 * (failTask()は現在のタスクへ作用するため、無関係な新タスクを失敗させないようにする)。
 * failTask()自体が投げた場合は握り潰す(呼び出し元のcatchへ二次例外を流さない)。
 * 【保証】この関数から戻った時点で、対象タスクが実行中のまま残ることは無い。
 * failTask()が投げても、その後のフォールバックまで投げても、finally節が
 * メモリ上の実行中状態を強制的に解除するため、以後のdownload.startが
 * TASK_ALREADY_RUNNINGで永久に弾かれ続けることはない。
 * @param {string} taskId 対象のtaskId
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function failCurrentTaskAsRestarted(taskId) {
  if (activeTaskId !== taskId) {
    return;
  }
  try {
    await failTask("SW_RESTARTED", "処理が中断されました。再度お試しください。");
  } catch (error) {
    // failTask()自体が投げた(内部のスナップショット読み出しが失敗した等)。
    // これ以上ストレージを読まずに手元の情報だけで最小限の結果を組み立て、
    // 停滞させずに終端状態へ到達させる。
    if (activeTaskId === taskId && activeTask !== null) {
      try {
        lastSequence += 1;
        await finishTask(
          buildErrorResult(taskId, lastSequence, "SW_RESTARTED", "処理が中断されました。再度お試しください。", {
            phase: "download",
            format: activeTask.format,
            url: activeTask.url,
            percent: null,
            progressMaxByBasis: {},
          }),
        );
      } catch (fallbackError) {
        // フォールバックも失敗した。下のfinally節がメモリ状態を強制解除する。
      }
    }
  } finally {
    if (activeTaskId === taskId) {
      activeTaskId = null;
      activeTask = null;
      lastSequence = -1;
    }
  }
}

/**
 * 実行中タスクのスナップショットへ、復元に必要な付加フィールドを書き足す。
 * タスクが既に切り替わっている場合は何もしない。
 * 呼び出し元が「永続化まで本当に終わったか」を判断できるよう、書き込みの有無を返す。
 * @param {string} taskId 対象のtaskId
 * @param {object} fields 追記するフィールド
 * @returns {Promise<boolean>} 実際に書き込めたらtrue、タスク不一致で見送ったらfalse
 */
async function persistSnapshotFields(taskId, fields) {
  const previous = await loadSnapshot();
  if (previous === null || previous.taskId !== taskId || activeTaskId !== taskId) {
    return false;
  }
  await saveSnapshot({ ...previous, ...fields });
  return true;
}

/**
 * page-relayがOffscreenとのPortを維持できなかった場合の処理。
 * @param {object} message {type:"page.relay.failed", taskId, code}
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function handleRelayFailed(message) {
  if (activeTaskId === null || message.taskId !== activeTaskId) {
    return;
  }
  const code = typeof message.code === "string" ? message.code : "RELAY_PORT_DISCONNECTED";
  await failTask(code, "ページとの音声転送チャネルが切断されました。");
  sendConvertRelease(message.taskId);
}

/**
 * page-relay経由で届くpage-agentの進捗を、TaskSnapshotの進捗へ写す。
 * phase "download" のみdownloading状態として扱い、それ以前の準備フェーズ
 * (player / player-js)はstartingのまま細分フェーズだけを載せる。
 * @param {object} message {type:"page.status", taskId, phase, ...}
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function handlePageStatus(message) {
  if (activeTaskId === null || message.taskId !== activeTaskId || activeTask === null) {
    return;
  }
  if (message.phase !== "download") {
    await emitProgress(buildProgressMessage("starting", "download", { agentPhase: message.phase }));
    return;
  }
  const downloadedBytes = typeof message.bytes === "number" ? message.bytes : null;
  const totalBytes = typeof message.totalBytes === "number" ? message.totalBytes : null;
  const percent =
    downloadedBytes !== null && totalBytes !== null && totalBytes > 0
      ? (downloadedBytes / totalBytes) * 100
      : null;
  await emitProgress(
    buildProgressMessage("downloading", "download", {
      agentPhase: "download",
      percent,
      downloadedBytes,
      totalBytes,
      totalBytesSource: totalBytes !== null ? "sabr" : null,
    }),
  );
}

/**
 * Offscreenからの音声転送完了通知を処理する(T10が送信する)。
 * 転送は終わったのにpage.resultがまだ届いていない場合は、AGENT_RESULT_GRACE_MS後の
 * 再チェックを予約する。結果が失われたまま無限に待ち続けるのを防ぐため。
 * @param {object} message {type:"audio.transfer.complete", taskId, epoch, byteLength}
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function handleTransferComplete(message) {
  if (activeTaskId === null || message.taskId !== activeTaskId || activeTask === null) {
    return;
  }
  const taskId = message.taskId;
  activeTask.transfer = { epoch: message.epoch, byteLength: message.byteLength };
  await maybeStartConversion();
  if (
    activeTaskId === taskId &&
    activeTask !== null &&
    activeTask.agentSettled === false &&
    activeTask.agentHandling === false &&
    activeTask.agentGraceScheduled !== true
  ) {
    activeTask.agentGraceScheduled = true;
    setTimeout(() => {
      checkAgentResultGrace(taskId).catch(() => {});
    }, AGENT_RESULT_GRACE_MS);
  }
}

/**
 * 転送完了から猶予時間が過ぎた時点で、page.resultが結局届かなかったタスクを失敗させる。
 * 発火時に「同じタスクがまだ実行中で・決着しておらず・処理中でもなく・変換も始まって
 * おらず・転送は完了済み」を全て再検証し、1つでも崩れていれば何もしない。これにより
 * 既に解決済みのタスクへ遅れて発火したタイマーは安全なno-opになる(clearTimeoutによる
 * 明示的な後始末は行わない)。SW自体が退避されればタイマーも消えるため、あくまで
 * 単一SWライフタイム内のベストエフォート(起動時の停滞判定が第2の防御層)。
 * @param {string} taskId 転送完了通知を受けた時点のtaskId
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function checkAgentResultGrace(taskId) {
  if (
    activeTaskId !== taskId ||
    activeTask === null ||
    activeTask.agentSettled ||
    activeTask.agentHandling ||
    activeTask.conversionStarted ||
    activeTask.transfer === null
  ) {
    return;
  }
  try {
    await failCurrentTaskAsRestarted(taskId);
  } finally {
    sendConvertRelease(taskId);
  }
}

/**
 * Offscreenからの音声転送失敗通知を処理する(T10が送信する)。
 * @param {object} message {type:"audio.transfer.failed", taskId, code}
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function handleTransferFailed(message) {
  if (activeTaskId === null || message.taskId !== activeTaskId) {
    return;
  }
  const code = typeof message.code === "string" ? message.code : "TRANSFER_INCOMPLETE";
  await failTask(code, "音声データの転送に失敗しました。");
}

/**
 * page-agentの成功結果とOffscreenの転送完了が揃った時点で変換を開始する。
 * どちらが先に届くかは保証されないため、両方揃うまで何もしない。
 * 判定にはagentResultではなくagentSettledとtransferを使う。SW再起動から復元した
 * タスクはagentResultを持たないが、Offscreenの状態から「agentは決着済み・転送は
 * 完了済み」と判明する場合があるため(finding 10)。
 * ファイル名は再導出せず、handleAgentResult()または復元時に確定したものを使う。
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function maybeStartConversion() {
  if (activeTask === null || activeTask.conversionStarted) {
    return;
  }
  if (!activeTask.agentSettled || activeTask.transfer === null) {
    return;
  }
  activeTask.conversionStarted = true;
  const fileName =
    typeof activeTask.fileName === "string" && activeTask.fileName.length > 0
      ? activeTask.fileName
      : buildFileName(null, activeTask.videoId ?? activeTask.taskId);
  activeTask.fileName = fileName;
  await emitProgress(buildProgressMessage("converting", "convert", { percent: null, convertAttempt: 1 }));
  chrome.runtime
    .sendMessage({
      type: "convert.start",
      taskId: activeTask.taskId,
      format: activeTask.format,
      audioQuality: activeTask.audioQuality,
      fileName,
    })
    .catch(() => {});
}

/**
 * Offscreenからの変換進捗を処理する(T10が送信する)。
 * @param {object} message {type:"convert.progress", taskId, percent, ...}
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function handleConvertProgress(message) {
  if (activeTaskId === null || message.taskId !== activeTaskId || activeTask === null) {
    return;
  }
  await emitProgress(
    buildProgressMessage("converting", "convert", {
      percent: typeof message.percent === "number" ? message.percent : null,
      convertedSeconds: typeof message.convertedSeconds === "number" ? message.convertedSeconds : null,
      totalSeconds: typeof message.totalSeconds === "number" ? message.totalSeconds : null,
      convertAttempt: typeof message.convertAttempt === "number" ? message.convertAttempt : 1,
    }),
  );
}

/**
 * Offscreenへconvert.releaseを送り、保存先未選択時に作られたobject URLと
 * OPFS出力一時ファイルを解放させる(finding 6のSW側)。
 * chrome.downloads側が真に終端状態(complete/interrupted、あるいはdownload()自体の
 * 失敗)に達した時点でのみ呼ぶ。
 * 失敗時は必ずfailTask()の完了後に呼ぶこと(Offscreenが"done"へ遷移してから失敗が
 * 永続化されるまでの隙間でSWが落ちると、次回起動時に誤って成功と報告されるため)。
 * @param {string} taskId 対象のtaskId
 * @returns {void}
 */
function sendConvertRelease(taskId) {
  chrome.runtime.sendMessage({ type: "convert.release", taskId }).catch(() => {});
}

/**
 * 正規表現の特殊文字をエスケープする。chrome.downloads.searchのfilenameRegexへ
 * ファイル名をそのまま渡すと、特殊文字を含むファイル名で構文が壊れる・誤マッチするため。
 * @param {string} value 元の文字列
 * @returns {string} エスケープ済み文字列
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Downloadsフォルダ内にfileNameと同名の完了済みダウンロード履歴が無いかを調べる(finding 14)。
 * 拡張機能はOSのDownloadsフォルダの実ファイルを直接確認できないため、chrome.downloadsの
 * ダウンロード履歴(exists:trueで実ファイルの現存も併せて確認)をベストエフォートの
 * 代理シグナルとして使う(既知の限界: 拡張機能外で置かれたファイルや履歴削除後のファイルは
 * 検出できない。ユーザー承認済み)。
 * @param {unknown} fileName 判定対象のファイル名(拡張子込み)
 * @returns {Promise<{exists: boolean}>} 完了済みの同名ダウンロード履歴があればexists:true
 */
async function checkDownloadsFolderCollision(fileName) {
  if (typeof fileName !== "string" || fileName.length === 0) {
    return { exists: false };
  }
  const pattern = `(^|[\\\\/])${escapeRegExp(fileName)}$`;
  let items;
  try {
    items = await chrome.downloads.search({ filenameRegex: pattern, exists: true, state: "complete" });
  } catch (error) {
    return { exists: false };
  }
  return { exists: Array.isArray(items) && items.length > 0 };
}

/**
 * 保存先ディレクトリ未選択時(Q2)のフォールバックとして、Offscreenが作った
 * object URLをchrome.downloads.downloadでDownloadsフォルダへ保存する。
 * download()自体のrejectはここで捕捉してSAVE_FAILEDへ落とす(finding 9)。
 * 成功してもここではタスクを完了させず、downloadIdを控えて実際のダウンロードが
 * 終端状態へ到達するのを待つ。既に終端に達していた場合に備え、直後に
 * chrome.downloads.searchで突き合わせる。
 * @param {string} taskId 対象のtaskId
 * @param {string} downloadUrl Offscreenが作ったobject URL
 * @param {string|null|undefined} fileName 保存ファイル名(拡張子込み)
 * @returns {Promise<void>} 保存要求完了を表すPromise
 */
async function downloadToDownloadsFolder(taskId, downloadUrl, fileName) {
  let downloadId; // number | undefined
  try {
    downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename: typeof fileName === "string" ? fileName : undefined,
    });
  } catch (error) {
    // 待っている間に別タスクが実行中になっていた場合、failTask()は「現在の」タスクを
    // 失敗させてしまうため呼ばない。古いタスク側のOffscreenリソースだけ解放する。
    if (activeTaskId !== taskId) {
      sendConvertRelease(taskId);
      return;
    }
    await failTask(
      "SAVE_FAILED",
      error && typeof error.message === "string" ? error.message : "ファイルを保存できませんでした。",
    );
    sendConvertRelease(taskId);
    return;
  }
  if (typeof downloadId !== "number") {
    if (activeTaskId !== taskId) {
      sendConvertRelease(taskId);
      return;
    }
    await failTask("SAVE_FAILED", "ダウンロードを開始できませんでした。");
    sendConvertRelease(taskId);
    return;
  }
  if (activeTaskId !== taskId || activeTask === null) {
    // 待っている間にタスクが終了していた場合は解放だけ行う。
    sendConvertRelease(taskId);
    return;
  }
  activeTask.downloadId = downloadId;
  await persistSnapshotFields(taskId, { downloadId });
  await reconcileDownloadState(taskId, downloadId);
}

/**
 * chrome.downloads.searchで現在のダウンロード項目を取得し、既に終端状態へ
 * 達していればonChangedと同じ処理を行う(finding 9)。onChangedの登録前や
 * SW停止中に遷移が済んでしまい、イベントが二度と来ない場合の取りこぼし対策。
 *
 * 項目が見つからない(ユーザーがダウンロード履歴を消した等)・searchが失敗する・
 * stateが既知の値("complete"/"interrupted"/"in_progress")でない場合は
 * DOWNLOAD_RECONCILE_DELAYS_MSに従って有限回だけ再試行する。存在しない項目には
 * onChangedが二度と来ないため、諦めずに待ち続けるとタスクが永久に実行中のまま
 * 残り、object URLとOPFS出力一時ファイルを掴んだままになるため。全試行で状態を
 * 確認できなければSAVE_FAILEDで終了させる。
 * 試行回数はスナップショットへ永続化しない。SWが再試行中に落ちた場合は次回の
 * recoverOnStartup()が同じ突き合わせを最初からやり直すため、それで十分。
 * @param {string} taskId 対象のtaskId
 * @param {number} downloadId chrome.downloadsのダウンロードID
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function reconcileDownloadState(taskId, downloadId) {
  for (const delayMs of DOWNLOAD_RECONCILE_DELAYS_MS) {
    if (delayMs > 0) {
      await delay(delayMs);
    }
    if (activeTaskId !== taskId) {
      return;
    }
    let items; // chrome.downloads.DownloadItem[] | undefined
    try {
      items = await chrome.downloads.search({ id: downloadId });
    } catch (error) {
      continue;
    }
    if (activeTaskId !== taskId) {
      return;
    }
    const item = Array.isArray(items) ? items.find((entry) => isPlainObject(entry)) : undefined;
    if (item === undefined) {
      continue;
    }
    if (item.state === "complete") {
      await completeDownloadedTask(taskId);
      return;
    }
    if (item.state === "interrupted") {
      await failDownloadedTask(taskId, item.error);
      return;
    }
    if (item.state === "in_progress") {
      // 項目は実在し、まだ進行中。この後のonChangedが終端を伝えるため再試行しない。
      return;
    }
    // 未知・欠落したstateは「進行中」とみなさず再試行する。進行中と誤認すると
    // 二度と来ないonChangedを待ち続けてタスクが永久に実行中のまま残るため。
  }
  if (activeTaskId !== taskId) {
    return;
  }
  await failTask("SAVE_FAILED", "ファイルを保存できませんでした。(ダウンロード状態を確認できませんでした)");
  sendConvertRelease(taskId);
}

/**
 * chrome.downloads.onChangedを処理する(finding 9)。実行中タスクのdownloadIdと
 * 一致する項目が終端状態になったときのみ、解放とタスク終了を行う。
 * @param {object} delta chrome.downloads.onChangedのdelta
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function handleDownloadsChanged(delta) {
  if (!isPlainObject(delta) || typeof delta.id !== "number") {
    return;
  }
  const state = isPlainObject(delta.state) ? delta.state.current : undefined;
  if (state !== "complete" && state !== "interrupted") {
    return;
  }
  const taskId = activeTaskId;
  if (taskId === null) {
    return;
  }
  const downloadId = await resolveActiveDownloadId();
  if (downloadId === null || downloadId !== delta.id || activeTaskId !== taskId) {
    return;
  }
  if (state === "complete") {
    await completeDownloadedTask(taskId);
    return;
  }
  await failDownloadedTask(taskId, isPlainObject(delta.error) ? delta.error.current : undefined);
}

/**
 * 実行中タスクのdownloadIdを解決する。メモリ上に無ければ(SW再起動直後など)
 * 保存済みスナップショットから読む。
 * @returns {Promise<number|null>} downloadId。無ければnull
 */
async function resolveActiveDownloadId() {
  if (activeTask !== null && typeof activeTask.downloadId === "number") {
    return activeTask.downloadId;
  }
  const snapshot = await loadSnapshot();
  return typeof snapshot?.downloadId === "number" ? snapshot.downloadId : null;
}

/**
 * Downloadsフォルダへの保存が完了したタスクを完了として終了させる。
 * @param {string} taskId 対象のtaskId
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function completeDownloadedTask(taskId) {
  if (activeTaskId !== taskId) {
    return;
  }
  sendConvertRelease(taskId);
  await completeTask(taskId, activeTask?.savedFileName ?? null);
}

/**
 * Downloadsフォルダへの保存が失敗したタスクをSAVE_FAILEDで終了させる。
 * failTask()による失敗の永続化を先に完了させてからconvert.releaseを送る。逆順だと、
 * Offscreenが"done"へ遷移した直後・失敗が保存される前にSWが落ちた場合、次回起動時の
 * 復元がOffscreenの"done"を見て「成功」と誤報告してしまうため。
 * @param {string} taskId 対象のtaskId
 * @param {string|undefined} downloadError chrome.downloads側のエラー識別子
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function failDownloadedTask(taskId, downloadError) {
  if (activeTaskId !== taskId) {
    return;
  }
  const detail =
    typeof downloadError === "string" && downloadError.length > 0
      ? `ファイルを保存できませんでした。(${downloadError})`
      : "ファイルを保存できませんでした。";
  await failTask("SAVE_FAILED", detail);
  sendConvertRelease(taskId);
}

/**
 * 実行中タスクを完了として終了させる。
 * @param {string} taskId 対象のtaskId
 * @param {string|null} resultFileName Offscreenが返した保存ファイル名
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function completeTask(taskId, resultFileName) {
  const previous = await loadSnapshot();
  if (activeTaskId !== taskId) {
    return;
  }
  lastSequence += 1;
  await finishTask({
    type: "download.result",
    taskId,
    sequence: lastSequence,
    state: "completed",
    phase: "done",
    percent: 100,
    format: previous?.format ?? DEFAULT_FORMAT,
    url: previous?.url ?? null,
    fileName: resultFileName ?? activeTask?.fileName ?? null,
    progressMaxByBasis: previous?.progressMaxByBasis ?? {},
    timestamp: nowIso(),
  });
}

/**
 * Offscreenからの変換結果を処理し、タスクを終了させる(T10が送信する)。
 * downloadUrlを伴う場合(保存先ディレクトリ未選択、Q2)はここでは終了させず、
 * chrome.downloads側が終端状態へ達するのを待つ(finding 9)。
 * @param {object} message {type:"convert.result", taskId, ok, code?, message?, fileName?, downloadUrl?}
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function handleConvertResult(message) {
  if (activeTaskId === null || message.taskId !== activeTaskId) {
    return;
  }
  if (message.ok === true || message.state === "completed") {
    const taskId = activeTaskId;
    const resultFileName = typeof message.fileName === "string" ? message.fileName : null;
    if (typeof message.downloadUrl === "string" && message.downloadUrl.length > 0) {
      // dirName===null(保存先ディレクトリハンドル未選択)の場合のみOffscreenがdownloadUrlを載せる(Q2)。
      if (activeTask !== null) {
        activeTask.savedFileName = resultFileName;
      }
      await downloadToDownloadsFolder(taskId, message.downloadUrl, message.fileName);
      return;
    }
    await completeTask(taskId, resultFileName);
    return;
  }
  const code = typeof message.code === "string" ? message.code : "CONVERT_FAILED";
  await failTask(code, typeof message.message === "string" ? message.message : "音声の変換に失敗しました。");
}

/**
 * ファイル名の基底部分を作る。拡張子はコンテナを決めるOffscreen側(T10)が付ける。
 * @param {string|null|undefined} title videoDetails.title
 * @param {string} videoId 動画ID(titleが使えない場合のフォールバック)
 * @returns {string} サニタイズ済みのファイル名
 */
function buildFileName(title, videoId) {
  const sanitized = sanitizeFileName(typeof title === "string" ? title : "");
  return sanitized.length > 0 ? sanitized : videoId;
}

/**
 * Windows/Chromeのダウンロードで使えない文字を除去し、長さを制限する。
 * @param {string} name 元の文字列
 * @returns {string} サニタイズ済み文字列
 */
function sanitizeFileName(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120)
    .trim();
}

/**
 * 進捗メッセージを組み立てる。sequenceはSWが単調増加で採番する。
 * @param {string} state タスク状態("starting"/"downloading"/"converting")
 * @param {string} phase 表示フェーズ("download"/"convert")
 * @param {object} extra 上書きするフィールド
 * @returns {object} download.progress形のメッセージ
 */
function buildProgressMessage(state, phase, extra) {
  lastSequence += 1;
  return {
    type: "download.progress",
    taskId: activeTaskId,
    sequence: lastSequence,
    state,
    phase,
    percent: null,
    downloadedBytes: null,
    totalBytes: null,
    totalBytesSource: null,
    speedBytesPerSecond: null,
    etaSeconds: null,
    format: activeTask !== null ? activeTask.format : DEFAULT_FORMAT,
    url: activeTask !== null ? activeTask.url : null,
    timestamp: nowIso(),
    ...extra,
  };
}

/**
 * 進捗メッセージを正規化して保存し、Popupへ転送する。
 * @param {object} message buildProgressMessage()が返したメッセージ
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function emitProgress(message) {
  const previous = await loadSnapshot();
  const normalized = normalizeProgress(message, previous);
  await saveSnapshot(normalized);
  broadcastToPopup(normalized);
}

/**
 * 進捗を表示用に正規化する。percentの0-100クランプ、基準（basis）ごとの
 * 過去最大値との比較による後退防止を行う（R8.2）。
 * @param {object} message 進捗メッセージ
 * @param {object|null} previous 直前に保存したスナップショット
 * @returns {object} 正規化済みのTaskSnapshot
 */
function normalizeProgress(message, previous) {
  const attemptSuffix =
    typeof message.convertAttempt === "number" ? `:${message.convertAttempt}` : "";
  const basis =
    `${message.phase}:${message.totalBytesSource ?? "none"}:${message.totalBytes ?? "NA"}${attemptSuffix}`;
  const maxByBasis = { ...(previous?.progressMaxByBasis ?? {}) };

  let percent =
    typeof message.percent === "number" ? Math.min(100, Math.max(0, message.percent)) : null;

  if (percent !== null) {
    const recordedMax = maxByBasis[basis];
    if (typeof recordedMax === "number" && percent < recordedMax) {
      percent = recordedMax;
    }
    maxByBasis[basis] = percent;
    evictOldestBasisEntries(maxByBasis, basis);
  }

  return {
    ...message,
    percent,
    progressMaxByBasis: maxByBasis,
    timestamp: message.timestamp,
  };
}

/**
 * progressMaxByBasisのエントリ数がMAX_PROGRESS_BASIS_ENTRIESを超えた場合、
 * currentBasis以外の最古のエントリから削除する。
 * @param {Record<string, number>} maxByBasis basisごとの最大percent
 * @param {string} currentBasis 現在のbasis（削除対象から除外する）
 * @returns {void}
 */
function evictOldestBasisEntries(maxByBasis, currentBasis) {
  let keys = Object.keys(maxByBasis);
  while (keys.length > MAX_PROGRESS_BASIS_ENTRIES) {
    const victim = keys.find((key) => key !== currentBasis);
    if (victim === undefined) {
      return;
    }
    delete maxByBasis[victim];
    keys = Object.keys(maxByBasis);
  }
}

/**
 * 実行中タスクをエラーで終了させる。
 * @param {string} code エラーコード
 * @param {string} fallbackMessage 未知code時の表示メッセージ
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function failTask(code, fallbackMessage) {
  const taskId = activeTaskId;
  if (taskId === null) {
    return;
  }
  const previous = await loadSnapshot();
  if (activeTaskId !== taskId) {
    return;
  }
  lastSequence += 1;
  await finishTask(buildErrorResult(taskId, lastSequence, code, fallbackMessage, previous));
}

/**
 * エラー終了時の結果スナップショットを組み立てる。
 * @param {string} taskId 発行済みのtaskId
 * @param {number} sequence 採番済みのsequence
 * @param {string} code エラーコード
 * @param {string} fallbackMessage 未知code時の表示メッセージ
 * @param {object|null} previous 直前に保存したスナップショット
 * @returns {object} finishTaskへ渡す結果スナップショット
 */
function buildErrorResult(taskId, sequence, code, fallbackMessage, previous) {
  return {
    type: "download.result",
    taskId,
    sequence,
    state: "error",
    phase: previous?.phase ?? "download",
    code,
    category: categorizeError(code),
    message: errorMessageFor(code, fallbackMessage),
    format: previous?.format ?? DEFAULT_FORMAT,
    url: previous?.url ?? null,
    percent: previous?.percent ?? null,
    progressMaxByBasis: previous?.progressMaxByBasis ?? {},
    timestamp: nowIso(),
  };
}

/**
 * タスクを終了させる。関数先頭の同期区間でガード判定・状態変数リセットまでを
 * 完了させ、その後に保存・転送・通知を行う（R4）。
 * @param {object} resultSnapshot 保存する結果スナップショット
 * @returns {Promise<void>} 終了処理完了を表すPromise
 */
function finishTask(resultSnapshot) {
  // ---- 同期区間（await禁止）----
  if (activeTaskId === null) {
    return Promise.resolve();
  }
  activeTaskId = null;
  activeTask = null;
  lastSequence = -1;
  return finalizeTask(resultSnapshot);
}

/**
 * finishTaskの非同期区間。保存・Popup転送・通知を行う。
 * @param {object} resultSnapshot 保存する結果スナップショット
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function finalizeTask(resultSnapshot) {
  await saveSnapshot(resultSnapshot);
  broadcastToPopup(resultSnapshot);
  if (resultSnapshot.state === "completed") {
    showNotification(
      chrome.i18n.getMessage("notificationTitleCompleted"),
      chrome.i18n.getMessage("notificationBodyCompleted"),
    );
  } else {
    const errorMessage = resolveDisplayMessage(
      resultSnapshot.code,
      resultSnapshot.message || "不明なエラーが発生しました。",
    );
    showNotification(chrome.i18n.getMessage("notificationTitleFailed"), errorMessage);
  }
}

/**
 * Gap1 §2の永続状態から、page-agentへ渡すplayerJs設定を組み立てる。
 * session側の拒否リストのうち有効期限内のものだけをexcludedとして渡す。
 * @returns {Promise<{knownGoodUrl: string|null, excluded: Array<{buildHash: string, variant: string}>}>}
 */
async function loadPlayerJsConfig() {
  const [localStored, sessionStored] = await Promise.all([
    chrome.storage.local.get(PLAYER_JS_KEY),
    chrome.storage.session.get(PLAYER_JS_REJECTED_KEY),
  ]);
  const knownGood = localStored?.[PLAYER_JS_KEY]?.knownGood;
  const rejected = sessionStored?.[PLAYER_JS_REJECTED_KEY];
  const now = Date.now();
  const excluded = [];
  for (const [key, entry] of Object.entries(isPlainObject(rejected) ? rejected : {})) {
    if (!isPlainObject(entry) || typeof entry.at !== "number") {
      continue;
    }
    if (now - entry.at >= PLAYER_JS_REJECTED_TTL_MS) {
      continue;
    }
    const parsed = parseRejectedKey(key);
    if (parsed !== null) {
      excluded.push(parsed);
    }
  }
  return {
    knownGoodUrl: typeof knownGood?.url === "string" ? knownGood.url : null,
    excluded,
  };
}

/**
 * 拒否リストのキー("<buildHash>:<variant>")を組み立てる。
 * @param {{buildHash: string, variant: string}} candidate 候補
 * @returns {string} キー
 */
function rejectedKey(candidate) {
  return `${candidate.buildHash}:${candidate.variant}`;
}

/**
 * 拒否リストのキーをbuildHash/variantへ戻す。
 * @param {string} key キー
 * @returns {{buildHash: string, variant: string}|null} 復元結果。壊れていればnull
 */
function parseRejectedKey(key) {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) {
    return null;
  }
  return { buildHash: key.slice(0, separator), variant: key.slice(separator + 1) };
}

/**
 * page-agentの結果からGap1 §2の永続状態を更新する。
 * 成功時のacceptedCandidateはlocalのknownGoodへ、成功・失敗いずれの
 * rejectedCandidatesもsessionの拒否リストへ書き込む。
 * @param {object} result page-agentのrun()結果
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function persistPlayerJsOutcome(result) {
  const writes = [];
  if (result.ok === true && isPlainObject(result.acceptedCandidate)) {
    writes.push(recordKnownGoodCandidate(result.acceptedCandidate));
  }
  if (Array.isArray(result.rejectedCandidates) && result.rejectedCandidates.length > 0) {
    writes.push(recordRejectedCandidates(result.rejectedCandidates, result.code));
  }
  await Promise.all(writes);
}

/**
 * 採用された候補をchrome.storage.localへ記録する。同一URLの再採用は
 * acceptCountを加算し、別URLなら1から数え直す。
 * @param {{url: string, buildHash: string, variant: string}} candidate 採用候補
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function recordKnownGoodCandidate(candidate) {
  const stored = await chrome.storage.local.get(PLAYER_JS_KEY);
  const current = stored?.[PLAYER_JS_KEY]?.knownGood;
  const acceptCount =
    isPlainObject(current) && current.url === candidate.url && typeof current.acceptCount === "number"
      ? current.acceptCount + 1
      : 1;
  await chrome.storage.local.set({
    [PLAYER_JS_KEY]: {
      knownGood: {
        url: candidate.url,
        buildHash: candidate.buildHash,
        variant: candidate.variant,
        acceptedAt: nowIso(),
        acceptCount,
      },
    },
  });
}

/**
 * 拒否された候補をchrome.storage.sessionへ記録する。
 * @param {Array<{buildHash: string, variant: string}>} candidates 拒否候補
 * @param {string|undefined} code 失敗結果のエラーコード(成功結果ではundefined)
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function recordRejectedCandidates(candidates, code) {
  const stored = await chrome.storage.session.get(PLAYER_JS_REJECTED_KEY);
  const current = stored?.[PLAYER_JS_REJECTED_KEY];
  const rejected = { ...(isPlainObject(current) ? current : {}) };
  const at = Date.now();
  const reason = typeof code === "string" ? code : "NSIG_REJECTED_BY_SERVER";
  for (const candidate of candidates) {
    if (!isPlainObject(candidate) || typeof candidate.buildHash !== "string") {
      continue;
    }
    rejected[rejectedKey(candidate)] = { reason, at };
  }
  await chrome.storage.session.set({ [PLAYER_JS_REJECTED_KEY]: rejected });
}

/**
 * スナップショットをchrome.storage.localへ保存する。
 * @param {object} task 保存するTaskSnapshot
 * @returns {Promise<void>} 保存完了を表すPromise
 */
async function saveSnapshot(task) {
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: task });
}

/**
 * chrome.storage.localから最新のスナップショットを読み出す。
 * @returns {Promise<object|null>} 保存済みTaskSnapshot。無ければnull
 */
async function loadSnapshot() {
  const stored = await chrome.storage.local.get(SNAPSHOT_KEY);
  return stored[SNAPSHOT_KEY] ?? null;
}

/**
 * 開いているPopupへスナップショットを転送する。
 * Popup不在時の「Receiving end does not exist」は握り潰す
 * （タスク失敗にしない）。
 * @param {object} task 転送するTaskSnapshot
 * @returns {void}
 */
function broadcastToPopup(task) {
  chrome.runtime.sendMessage(task).catch(() => {});
}

/**
 * ブラウザ通知を表示する。
 * @param {string} title 通知のタイトル
 * @param {string} message 通知の本文
 */
function showNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: NOTIFICATION_ICON,
    title,
    message,
  });
}

/**
 * service worker評価時に1回実行し、保存済み状態を復元する(Gap2 §3.4、finding 10)。
 * 保存上は実行中の場合、Offscreen Documentへconvert.statusを問い合わせて
 * 「転送中/転送完了/変換中/ダウンロード待ち/完了/失敗」のどれだったのかまで見分け、状態ごとに
 * 復元内容を変える。判別できない・Offscreenが無い・応答しない場合はSW_RESTARTEDで
 * 失敗させる。
 * 保存上は終端(完了・失敗)の場合でも、Offscreen側に残っているかもしれない
 * リソースの解放だけは促す。
 * @returns {Promise<void>} 復元処理完了を表すPromise
 */
async function recoverOnStartup() {
  const snapshot = await loadSnapshot();
  if (!snapshot || !RUNNING_STATES.includes(snapshot.state)) {
    // 既に終端(完了・失敗)しているタスクでも、Offscreen側のobject URL・OPFS出力
    // 一時ファイルが解放されないままSWが落ちていた可能性があるため解放を促す。
    // onConvertRelease()は未知のtaskIdに対して無害な冪等処理のため、そのまま送ってよい。
    if (snapshot && typeof snapshot.taskId === "string") {
      sendConvertRelease(snapshot.taskId);
    }
    return;
  }
  const status = await queryOffscreenStatus(snapshot.taskId);
  const offscreenState = status === null ? null : classifyOffscreenState(status);
  if (offscreenState === null) {
    await saveSnapshot({
      ...snapshot,
      type: "download.result",
      state: "error",
      code: "SW_RESTARTED",
      category: categorizeError("SW_RESTARTED"),
      message: errorMessageFor("SW_RESTARTED", "処理が中断されました。再度お試しください。"),
      timestamp: nowIso(),
    });
    return;
  }
  restoreActiveTask(snapshot, offscreenState, status);
  if (offscreenState === "transferring" && activeTask.agentSettled === false && isTransferStalled(snapshot)) {
    // 転送中のまま決着していないタスクは、page.resultが再送されないため待っても前進しない。
    // 一定時間進捗が無ければ無限待機ではなく明示的な失敗として見せる。
    await failTask("SW_RESTARTED", "処理が中断されました。再度お試しください。");
    sendConvertRelease(snapshot.taskId);
    return;
  }
  if (offscreenState === "awaiting-download") {
    if (typeof snapshot.downloadId === "number") {
      // download()までは済んでいた。SW停止中に終端へ達している可能性があるため突き合わせる
      // (finding 9)。まだ進行中なら実行中タスクのまま残し、onChangedの到着を待つ。
      await reconcileDownloadState(snapshot.taskId, snapshot.downloadId);
      return;
    }
    // 変換完了とdownload()呼び出しの間でSWが落ちた。ここで改めてダウンロードを開始する。
    await resumePendingDownload(snapshot.taskId, status);
    return;
  }
  if (offscreenState === "ready") {
    // 転送は完了しているのに変換開始の指示が届いていない状態。前進させる。
    await maybeStartConversion();
    return;
  }
  if (offscreenState === "done" || offscreenState === "failed") {
    await handleConvertResult(buildRecoveredConvertResult(snapshot.taskId, offscreenState, status));
  }
}

/**
 * 転送中のまま復元されたタスクのスナップショットが、TRANSFER_STALL_RECOVERY_MS以上
 * 更新されていない(=もう前進しない)かどうかを判定する。
 * timestampが無い・解釈できない場合も停滞とみなす。無限に待ち続けるより、
 * 明示的な失敗として見せる方を優先するため(fail-safe)。
 * 差の絶対値で判定するため、時刻の巻き戻し等でtimestampが未来日時になっている場合も
 * 「鮮度が高い」とは扱わず停滞とみなす(信頼できない値のため同じくfail-safe側へ倒す)。
 * @param {object} snapshot 保存済みTaskSnapshot
 * @returns {boolean} 停滞していればtrue
 */
function isTransferStalled(snapshot) {
  const updatedAt = Date.parse(snapshot.timestamp);
  if (Number.isNaN(updatedAt)) {
    return true;
  }
  return Math.abs(Date.now() - updatedAt) >= TRANSFER_STALL_RECOVERY_MS;
}

/**
 * "awaiting-download"かつdownloadId未保存の状態から復帰する。Offscreenが保持している
 * object URLで改めてchrome.downloads.downloadを呼び、保存をやり直す。
 * 既に発行済みで宙に浮いたダウンロードの検出・重複排除は行わない(ユーザー判断により
 * 稀な重複を許容し、スコープを最小に保つ)。URLが失われていれば保存不能として終了させる。
 * taskIdが現在の実行中タスクと一致しない場合は何もしない。
 * @param {string} taskId 対象のtaskId
 * @param {object} status convert.statusの応答
 * @returns {Promise<void>} 処理完了を表すPromise
 */
async function resumePendingDownload(taskId, status) {
  // 既に別タスクが実行中なら、この復帰処理は古いタスクのものなので何もしない
  // (failTask()が現在のタスクを誤って失敗させるのを防ぐ)。
  if (activeTaskId !== taskId) {
    return;
  }
  if (typeof status.pendingDownloadUrl !== "string" || status.pendingDownloadUrl.length === 0) {
    await failTask("SAVE_FAILED", "ファイルを保存できませんでした。");
    sendConvertRelease(taskId);
    return;
  }
  await downloadToDownloadsFolder(taskId, status.pendingDownloadUrl, status.outputFileName);
}

/**
 * Offscreen Documentへconvert.statusを問い合わせる。Offscreenが存在しない・
 * CONVERT_STATUS_TIMEOUT_MS以内に応答しない・taskIdが一致しない場合はnullを返す。
 * @param {string} taskId 問い合わせ対象のtaskId
 * @returns {Promise<object|null>} convert.statusの応答。取得できなければnull
 */
async function queryOffscreenStatus(taskId) {
  let contexts;
  try {
    contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  } catch (error) {
    return null;
  }
  if (!Array.isArray(contexts) || contexts.length === 0) {
    return null;
  }
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), CONVERT_STATUS_TIMEOUT_MS);
  });
  const query = chrome.runtime
    .sendMessage({ type: "convert.status", taskId })
    .catch(() => null);
  const response = await Promise.race([query, timeout]);
  if (!isPlainObject(response) || response.taskId !== taskId) {
    return null;
  }
  return response;
}

/**
 * convert.statusの応答からOffscreenの内部状態を読み取る(finding 10)。
 * Offscreenは畳み込まないoffscreenStateを返すため、推測は行わず既知の状態語のみ受け入れる。
 * offscreenStateを持たない応答(追跡していないtaskId・古い形式の応答)は判別不能として
 * nullを返し、呼び出し元のSW_RESTARTED経路へ落とす。
 * @param {object} status convert.statusの応答
 * @returns {string|null} OFFSCREEN_STATESのいずれか。判別不能ならnull
 */
function classifyOffscreenState(status) {
  return OFFSCREEN_STATES.includes(status.offscreenState) ? status.offscreenState : null;
}

/**
 * 復元したスナップショットとOffscreenの状態から、実行中タスクの内部状態を組み立てる。
 * transferring時はagentSettledを一律trueにせず、fileNameが永続化済みか
 * (=handleAgentResultまで到達済みか)で決める(finding 10)。
 * "awaiting-download"は変換自体は完了しているため、"done"と同様に
 * agentSettled/transfer/conversionStartedを決着済みとして扱う。
 * @param {object} snapshot 保存済みTaskSnapshot
 * @param {string} offscreenState classifyOffscreenState()の判定結果
 * @param {object} status convert.statusの応答
 * @returns {void}
 */
function restoreActiveTask(snapshot, offscreenState, status) {
  const transferring = offscreenState === "transferring";
  activeTaskId = snapshot.taskId;
  lastSequence = typeof snapshot.sequence === "number" ? snapshot.sequence : 0;
  activeTask = {
    taskId: snapshot.taskId,
    url: snapshot.url ?? null,
    format: snapshot.format ?? DEFAULT_FORMAT,
    videoId: null,
    audioQuality: snapshot.audioQuality ?? DEFAULT_AUDIO_QUALITY,
    agentResult: null,
    agentSettled: transferring
      ? typeof snapshot.fileName === "string" && snapshot.fileName.length > 0
      : true,
    agentHandling: false,
    agentGraceScheduled: false,
    transfer: transferring
      ? null
      : { byteLength: typeof status.byteLength === "number" ? status.byteLength : null },
    conversionStarted: !(transferring || offscreenState === "ready"),
    fileName: snapshot.fileName ?? null,
    downloadId: typeof snapshot.downloadId === "number" ? snapshot.downloadId : undefined,
    savedFileName: typeof status.outputFileName === "string" ? status.outputFileName : null,
  };
}

/**
 * 復元時に、Offscreenが既に終わっていた場合のconvert.result相当を組み立てる。
 * Offscreen(T2)は直前に送ったconvert.resultを保持していないため、convert.statusが
 * 返す範囲で復元する。保存済みファイル名はoutputFileNameを優先し、
 * 無ければ従来のfileNameへ落とす。
 * @param {string} taskId 対象のtaskId
 * @param {string} offscreenState "done"または"failed"
 * @param {object} status convert.statusの応答
 * @returns {object} handleConvertResult()へ渡すメッセージ
 */
function buildRecoveredConvertResult(taskId, offscreenState, status) {
  if (offscreenState === "done") {
    const fileName =
      typeof status.outputFileName === "string" ? status.outputFileName : status.fileName;
    return {
      type: "convert.result",
      taskId,
      ok: true,
      fileName: typeof fileName === "string" ? fileName : undefined,
    };
  }
  return {
    type: "convert.result",
    taskId,
    ok: false,
    code: "CONVERT_FAILED",
    message: "音声の変換に失敗しました。",
  };
}

// 起動時復元。全メッセージハンドラはこのPromiseの解決を待ってから走る(finding 16)。
const recoveryDone = recoverOnStartup().catch(() => {});

// jestからのテスト用エクスポート。拡張機能としての読み込み時は
// moduleが存在しないため、この分岐には入らない。
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ALLOWED_FORMATS,
    DEFAULT_FORMAT,
    ALLOWED_AUDIO_QUALITIES,
    DEFAULT_AUDIO_QUALITY,
    SNAPSHOT_KEY,
    PLAYER_JS_KEY,
    PLAYER_JS_REJECTED_KEY,
    ERROR_MESSAGE_KEY_BY_CODE,
    resolveDisplayMessage,
    errorMessageFor,
    categorizeError,
    handleRuntimeMessage,
    validateStartRequest,
    isAllowedYoutubeUrl,
    extractVideoId,
    claimTask,
    buildAccepted,
    buildRejection,
    buildErrorResult,
    handleDownloadStart,
    handleSnapshotGet,
    runTask,
    ensureOffscreenDocument,
    acquireYoutubeTab,
    buildAgentConfig,
    injectPageScripts,
    handleAgentResult,
    handleRelayFailed,
    handlePageStatus,
    handleTransferComplete,
    handleTransferFailed,
    handleConvertProgress,
    handleConvertResult,
    handleDownloadsChanged,
    escapeRegExp,
    checkDownloadsFolderCollision,
    downloadToDownloadsFolder,
    reconcileDownloadState,
    classifyOffscreenState,
    resumePendingDownload,
    persistSnapshotFields,
    maybeStartConversion,
    buildFileName,
    sanitizeFileName,
    normalizeProgress,
    evictOldestBasisEntries,
    loadPlayerJsConfig,
    persistPlayerJsOutcome,
    failTask,
    finishTask,
    finalizeTask,
    saveSnapshot,
    loadSnapshot,
    broadcastToPopup,
    showNotification,
    recoverOnStartup,
    // テストがモジュール内部状態をリセットするためのヘルパー。
    __resetStateForTest: () => {
      activeTaskId = null;
      activeTask = null;
      lastSequence = -1;
      activePipeline = null;
      offscreenSetup = null;
    },
    __getStateForTest: () => ({ activeTaskId, activeTask, lastSequence, activePipeline }),
  };
}
