// player-response.mjs
// ページ自身のINNERTUBE_CONTEXTとSAPISIDHASH認証ヘッダーで/youtubei/v1/playerへPOSTし、
// playabilityStatusを作業ノートのエラーカタログ(VIDEO_*/AUTH_*)へ写像する。
// PoToken・signatureTimestamp(sts)は送らない(T4/T5/T6スパイクで不要と確認済み)。

import { YOUTUBE_ORIGIN } from "./sapisid.mjs";

export const PLAYER_ENDPOINT = "/youtubei/v1/player?prettyPrint=false";

/**
 * エラーコード定数。SW/popup側の表示マップと突き合わせる際の唯一の名前源。
 */
export const ERROR_CODES = Object.freeze({
  AUTH_NOT_LOGGED_IN: "AUTH_NOT_LOGGED_IN",
  AUTH_REJECTED: "AUTH_REJECTED",
  PLAYER_REQUEST_FAILED: "PLAYER_REQUEST_FAILED",
  VIDEO_LOGIN_REQUIRED: "VIDEO_LOGIN_REQUIRED",
  VIDEO_AGE_RESTRICTED: "VIDEO_AGE_RESTRICTED",
  VIDEO_UNPLAYABLE: "VIDEO_UNPLAYABLE",
  VIDEO_UNAVAILABLE: "VIDEO_UNAVAILABLE",
  VIDEO_LIVE: "VIDEO_LIVE",
  VIDEO_DRM: "VIDEO_DRM",
  VIDEO_NO_AUDIO_FORMAT: "VIDEO_NO_AUDIO_FORMAT",
  PLAYER_JS_UNAVAILABLE: "PLAYER_JS_UNAVAILABLE",
  EXTRACT_NSIG_FAILED: "EXTRACT_NSIG_FAILED",
  NSIG_REJECTED_BY_SERVER: "NSIG_REJECTED_BY_SERVER",
  NETWORK_UNREACHABLE: "NETWORK_UNREACHABLE",
  SABR_SERVER_ERROR: "SABR_SERVER_ERROR",
  FETCH_STALLED: "FETCH_STALLED",
  FETCH_TIMEOUT: "FETCH_TIMEOUT",
});

/**
 * playabilityStatus.reason等の文言から年齢制限を示唆するか判定する。
 * @param {object} playabilityStatus playerResponse.playabilityStatus
 * @returns {boolean} 年齢制限らしければtrue
 */
function looksAgeRestricted(playabilityStatus) {
  if (playabilityStatus.desktopLegacyAgeGate === true) {
    return true;
  }
  const reason = typeof playabilityStatus.reason === "string" ? playabilityStatus.reason : "";
  return /age|年齢/i.test(reason);
}

/**
 * playerResponse全体を検査し、ダウンロード不能ならエラーコードを返す。
 * 判定順: playabilityStatus.status → ライブ判定 → DRM判定 → streamingData有無。
 * 音声フォーマット有無(VIDEO_NO_AUDIO_FORMAT)はformat-selection側の結果で判定するため
 * ここでは扱わない。
 * @param {object} playerResponse /youtubei/v1/playerのJSON応答
 * @returns {{code: string, reason: string}|null} エラーならcode/reason、再生可能ならnull
 */
export function mapPlayabilityStatus(playerResponse) {
  const playabilityStatus =
    playerResponse && typeof playerResponse.playabilityStatus === "object" && playerResponse.playabilityStatus !== null
      ? playerResponse.playabilityStatus
      : {};
  const status = typeof playabilityStatus.status === "string" ? playabilityStatus.status : "";
  const reason = typeof playabilityStatus.reason === "string" ? playabilityStatus.reason : status;

  if (status === "LOGIN_REQUIRED") {
    return {
      code: looksAgeRestricted(playabilityStatus)
        ? ERROR_CODES.VIDEO_AGE_RESTRICTED
        : ERROR_CODES.VIDEO_LOGIN_REQUIRED,
      reason,
    };
  }
  if (status === "AGE_CHECK_REQUIRED" || status === "AGE_VERIFICATION_REQUIRED") {
    return { code: ERROR_CODES.VIDEO_AGE_RESTRICTED, reason };
  }
  if (status === "ERROR") {
    return { code: ERROR_CODES.VIDEO_UNAVAILABLE, reason };
  }
  if (status === "LIVE_STREAM_OFFLINE") {
    return { code: ERROR_CODES.VIDEO_LIVE, reason };
  }
  if (status === "UNPLAYABLE" || status === "CONTENT_CHECK_REQUIRED") {
    return { code: ERROR_CODES.VIDEO_UNPLAYABLE, reason };
  }
  if (status !== "OK") {
    return { code: ERROR_CODES.VIDEO_UNPLAYABLE, reason: reason || "unknown playabilityStatus" };
  }

  const videoDetails =
    playerResponse.videoDetails && typeof playerResponse.videoDetails === "object"
      ? playerResponse.videoDetails
      : {};
  if (videoDetails.isLive === true || playabilityStatus.liveStreamability !== undefined) {
    return { code: ERROR_CODES.VIDEO_LIVE, reason: "live stream" };
  }

  const streamingData =
    playerResponse.streamingData && typeof playerResponse.streamingData === "object"
      ? playerResponse.streamingData
      : null;
  if (streamingData === null) {
    return { code: ERROR_CODES.VIDEO_UNPLAYABLE, reason: "streamingData missing" };
  }
  const adaptiveFormats = Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats : [];
  const hasDrm =
    Array.isArray(streamingData.licenseInfos) && streamingData.licenseInfos.length > 0
      ? true
      : adaptiveFormats.length > 0 &&
        adaptiveFormats.every(
          (format) => Array.isArray(format.drmFamilies) && format.drmFamilies.length > 0,
        );
  if (hasDrm) {
    return { code: ERROR_CODES.VIDEO_DRM, reason: "DRM protected" };
  }
  return null;
}

/**
 * INNERTUBE_CONTEXT.client.clientName("WEB"等)からSABR ClientInfo用の数値IDを得る。
 * @param {string|number|undefined} clientName コンテキストのclientName
 * @returns {number} 数値ID。不明ならWEB(1)
 */
export function clientNameToId(clientName) {
  if (typeof clientName === "number") {
    return clientName;
  }
  const table = { WEB: 1, MWEB: 2, WEB_REMIX: 67, WEB_KIDS: 76, WEB_EMBEDDED_PLAYER: 56 };
  if (typeof clientName === "string") {
    if (clientName in table) {
      return table[clientName];
    }
    const parsed = Number.parseInt(clientName, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 1;
}

/**
 * /youtubei/v1/playerへ認証付きPOSTを行い、JSON応答を返す。
 * HTTP 401/403はAUTH_REJECTED、その他の非2xx・JSON不正はPLAYER_REQUEST_FAILEDとして例外化する。
 * @param {{fetchFn: typeof fetch, videoId: string, context: object, authorization: string,
 *   sessionIndex: string, origin?: string}} params
 *   fetchFn: 使用するfetch、context: ytcfg INNERTUBE_CONTEXT、authorization: SAPISIDHASHヘッダー値、
 *   sessionIndex: ytcfg SESSION_INDEX(X-Goog-AuthUser)
 * @returns {Promise<object>} playerResponse JSON
 * @throws {Error & {code: string, detail?: object}} 失敗時
 */
export async function fetchPlayerResponse({
  fetchFn,
  videoId,
  context,
  authorization,
  sessionIndex,
  origin = YOUTUBE_ORIGIN,
}) {
  const client = context && typeof context.client === "object" && context.client !== null ? context.client : {};
  /** @type {Record<string, string>} */
  const headers = {
    "content-type": "application/json",
    authorization,
    "x-origin": origin,
    "x-goog-authuser": sessionIndex,
    "x-youtube-client-name": String(clientNameToId(client.clientName)),
  };
  if (typeof client.clientVersion === "string") {
    headers["x-youtube-client-version"] = client.clientVersion;
  }
  let response;
  try {
    response = await fetchFn(new URL(PLAYER_ENDPOINT, origin).toString(), {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context, videoId }),
    });
  } catch (error) {
    throw makeError(ERROR_CODES.PLAYER_REQUEST_FAILED, error && error.message ? error.message : "fetch failed");
  }
  if (response.status === 401 || response.status === 403) {
    throw makeError(ERROR_CODES.AUTH_REJECTED, `HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw makeError(ERROR_CODES.PLAYER_REQUEST_FAILED, `HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw makeError(ERROR_CODES.PLAYER_REQUEST_FAILED, "invalid JSON");
  }
}

/**
 * code付きErrorを組み立てる。agent.mjsのrun()が結果オブジェクトへ変換する。
 * @param {string} code エラーコード
 * @param {string} reason 診断用の理由文字列
 * @param {object} [detail] 追加の診断情報
 * @returns {Error & {code: string, reason: string, detail: object}} 例外
 */
export function makeError(code, reason, detail = {}) {
  const error = new Error(`${code}: ${reason}`);
  error.code = code;
  error.reason = reason;
  error.detail = detail;
  return error;
}
