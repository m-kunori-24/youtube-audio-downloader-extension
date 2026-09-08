// sapisid.mjs
// ページ自身のSAPISID Cookieから、/youtubei/v1/player認証用の
// `Authorization: SAPISIDHASH {timestamp}_{sha1hex}` ヘッダー値を計算する。
// 標準スキーム: sha1("{timestamp} {SAPISID} {origin}")、originはhttps://www.youtube.com固定。

export const YOUTUBE_ORIGIN = "https://www.youtube.com";

// 認証に使うCookie名。優先順に並べる(__Secure-3PAPISIDはSAPISIDと同値だが
// サードパーティ文脈用に分離されているため、どちらか存在する方を使う)。
const SAPISID_COOKIE_NAMES = ["SAPISID", "__Secure-3PAPISID"];

/**
 * document.cookie形式の文字列を{name: value}に分解する。
 * @param {string} cookieString document.cookieの値
 * @returns {Record<string, string>} Cookie名→値
 */
export function parseCookieString(cookieString) {
  /** @type {Record<string, string>} */
  const cookies = {};
  for (const pair of cookieString.split(";")) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }
    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!(name in cookies)) {
      cookies[name] = value;
    }
  }
  return cookies;
}

/**
 * document.cookieからSAPISID(または__Secure-3PAPISID)の値を取り出す。
 * @param {string} cookieString document.cookieの値
 * @returns {string|null} Cookie値。未ログイン等で存在しなければnull
 */
export function readSapisidCookie(cookieString) {
  const cookies = parseCookieString(cookieString);
  for (const name of SAPISID_COOKIE_NAMES) {
    const value = cookies[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * UTF-8文字列のSHA-1ダイジェストを小文字16進文字列で返す。
 * @param {string} text ハッシュ対象文字列
 * @param {SubtleCrypto} subtle 使用するSubtleCrypto実装
 * @returns {Promise<string>} 40桁の16進文字列
 */
export async function sha1Hex(text, subtle) {
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * SAPISIDHASH形式のAuthorizationヘッダー値を計算する。
 * @param {{sapisid: string, timestampSeconds: number, origin?: string, subtle: SubtleCrypto}} params
 *   sapisid: Cookie値、timestampSeconds: UNIX秒、origin: 既定はYOUTUBE_ORIGIN
 * @returns {Promise<string>} "SAPISIDHASH {timestamp}_{sha1hex}"
 */
export async function computeSapisidHash({ sapisid, timestampSeconds, origin = YOUTUBE_ORIGIN, subtle }) {
  const hash = await sha1Hex(`${timestampSeconds} ${sapisid} ${origin}`, subtle);
  return `SAPISIDHASH ${timestampSeconds}_${hash}`;
}
