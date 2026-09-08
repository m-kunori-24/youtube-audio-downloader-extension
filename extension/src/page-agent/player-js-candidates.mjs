// player-js-candidates.mjs
// プレイヤーJS(base.js)の取得元候補を優先順に列挙する(Gap1「候補順序」)。
//   (a) SWが渡す既知成功URL(knownGoodUrl)
//   (b) 現ページのytcfg PLAYER_JS_URL(無ければ<script src*="/s/player/">)
//   (c) /iframe_api から解析したビルドハッシュ
//   (d) (b)/(c)で得たハッシュのバンドルバリアント書き換え(player_ias <-> player_ias_tce)
// SWから渡された除外リスト(excluded: {buildHash, variant}[])に該当する候補は列挙しない。
// finding 3: knownGoodUrl(chrome.storage永続化)やytcfg値が汚染された場合に備え、
// 候補は列挙時点でisAllowedPlayerJsUrl()の原点・パス形状検証を通ったものだけを残す。

import { YOUTUBE_ORIGIN } from "./sapisid.mjs";

const PLAYER_JS_URL_PATTERN = /\/s\/player\/([0-9a-zA-Z_-]+)\/([A-Za-z0-9_]+)\.vflset\//;
// 実在するプレイヤーJSパス形状(例: /s/player/f572e43c/player_es6.vflset/ja_JP/base.js、
// /s/player/8c3fda2d/player_ias.vflset/en_US/base.js)を厳密に固定する。第2セグメントは
// VARIANT_REWRITESで使う player_es6/player_ias/player_ias_tce をすべて含む[A-Za-z0-9_]+。
const PLAYER_JS_PATH_PATTERN = /^\/s\/player\/[0-9A-Za-z_-]+\/[A-Za-z0-9_]+\.vflset\/[A-Za-z_-]+\/base\.js$/;
const ALLOWED_PLAYER_JS_HOSTNAME = new URL(YOUTUBE_ORIGIN).hostname;
const IFRAME_API_HASH_PATTERN = /player\\\/([0-9a-zA-Z_-]+)\\\//;
// (c)でページ側のバリアントが不明な場合の既定。youtubei.js自身がプレイヤー取得に使う
// バンドルで、現行のPLAYER_JS_URLもこれを指す(2026-09-07時点、f572e43c)。
const DEFAULT_VARIANT = "player_es6";
const VARIANT_REWRITES = {
  player_ias: "player_es6",
  player_ias_tce: "player_es6",
  player_es6: "player_ias",
};

/**
 * プレイヤーJS URLからビルドハッシュとバリアントを取り出す。
 * @param {string} url 絶対URLまたはサイト相対パス
 * @returns {{buildHash: string, variant: string}|null} 解析結果。形式不一致ならnull
 */
export function parsePlayerJsUrl(url) {
  const match = PLAYER_JS_URL_PATTERN.exec(url);
  if (!match) {
    return null;
  }
  return { buildHash: match[1], variant: match[2] };
}

/**
 * プレイヤーJS候補URLが、原点(https://www.youtube.com)・httpsプロトコル・既知のパス形状を
 * すべて満たすか検証する(finding 3)。汚染されたknownGoodUrl/ytcfg値によって攻撃者制御の
 * JSがfetch・eval実行されることを防ぐための、フェッチ前の必須ゲート。
 * @param {string} url 検証対象URL
 * @returns {boolean} 許可されたURLならtrue
 */
export function isAllowedPlayerJsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.hostname !== ALLOWED_PLAYER_JS_HOSTNAME) {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return false;
  }
  return PLAYER_JS_PATH_PATTERN.test(parsed.pathname);
}

/**
 * ビルドハッシュとバリアントからbase.jsの絶対URLを組み立てる。
 * @param {string} buildHash プレイヤービルドハッシュ
 * @param {string} variant バンドルバリアント(player_ias等)
 * @param {string} origin ページのorigin
 * @returns {string} 絶対URL
 */
export function buildPlayerJsUrl(buildHash, variant, origin) {
  return new URL(`/s/player/${buildHash}/${variant}.vflset/en_US/base.js`, origin).toString();
}

/**
 * /iframe_api の本文からビルドハッシュを取り出す。
 * @param {string} iframeApiSource /iframe_apiのJS本文
 * @returns {string|null} ビルドハッシュ。見つからなければnull
 */
export function parseIframeApiBuildHash(iframeApiSource) {
  const match = IFRAME_API_HASH_PATTERN.exec(iframeApiSource);
  return match ? match[1] : null;
}

/**
 * 候補を優先順に列挙する。重複URL・除外対象は落とす。
 * @param {{knownGoodUrl: string|null, excluded: Array<{buildHash: string, variant: string}>,
 *   pagePlayerJsUrl: string|null, iframeApiBuildHash: string|null, origin: string}} params
 *   pagePlayerJsUrl: (b)で得たURL、iframeApiBuildHash: (c)で得たハッシュ
 * @returns {Array<{url: string, buildHash: string, variant: string, source: string}>} 候補一覧
 */
export function buildCandidateList({ knownGoodUrl, excluded, pagePlayerJsUrl, iframeApiBuildHash, origin }) {
  const excludedKeys = new Set(
    (Array.isArray(excluded) ? excluded : []).map((entry) => `${entry.buildHash}/${entry.variant}`),
  );
  /** @type {Array<{url: string, buildHash: string, variant: string, source: string}>} */
  const candidates = [];
  const seenUrls = new Set();

  const push = (url, source) => {
    if (typeof url !== "string" || url.length === 0) {
      return;
    }
    const absolute = new URL(url, origin).toString();
    if (!isAllowedPlayerJsUrl(absolute)) {
      return;
    }
    const parsed = parsePlayerJsUrl(absolute);
    if (!parsed) {
      return;
    }
    if (excludedKeys.has(`${parsed.buildHash}/${parsed.variant}`) || seenUrls.has(absolute)) {
      return;
    }
    seenUrls.add(absolute);
    candidates.push({ url: absolute, buildHash: parsed.buildHash, variant: parsed.variant, source });
  };

  push(knownGoodUrl, "known-good");
  push(pagePlayerJsUrl, "page");
  // (c)はハッシュしか得られないので、バリアントは(b)で観測したものを引き継ぐ(無ければ既定)。
  const pageParsed = pagePlayerJsUrl ? parsePlayerJsUrl(new URL(pagePlayerJsUrl, origin).toString()) : null;
  const iframeVariant = pageParsed ? pageParsed.variant : DEFAULT_VARIANT;
  if (iframeApiBuildHash) {
    push(buildPlayerJsUrl(iframeApiBuildHash, iframeVariant, origin), "iframe-api");
  }

  // (d) (b)/(c)で見つかったハッシュ1つ((b)優先)の逆バリアントを1候補だけ追加する(最大4候補)。
  const rewriteSource =
    pageParsed ?? (iframeApiBuildHash ? { buildHash: iframeApiBuildHash, variant: iframeVariant } : null);
  if (rewriteSource) {
    const rewritten = VARIANT_REWRITES[rewriteSource.variant];
    if (rewritten) {
      push(buildPlayerJsUrl(rewriteSource.buildHash, rewritten, origin), "variant-rewrite");
    }
  }
  return candidates;
}

/**
 * 現ページからプレイヤーJS URLを読む((b))。
 * @param {{ytcfgGet: (key: string) => unknown, document: Document|null}} deps ページアクセス手段
 * @returns {string|null} URL。取れなければnull
 */
export function readPagePlayerJsUrl({ ytcfgGet, document }) {
  const fromYtcfg = ytcfgGet("PLAYER_JS_URL");
  if (typeof fromYtcfg === "string" && fromYtcfg.length > 0) {
    return fromYtcfg;
  }
  if (document && typeof document.querySelector === "function") {
    const script = document.querySelector('script[src*="/s/player/"]');
    if (script && typeof script.src === "string" && script.src.length > 0) {
      return script.src;
    }
  }
  return null;
}

/**
 * /iframe_api を取得してビルドハッシュを得る((c))。失敗時はnull(候補から外すだけ)。
 * @param {typeof fetch} fetchFn 使用するfetch
 * @param {string} origin ページのorigin
 * @returns {Promise<string|null>} ビルドハッシュ
 */
export async function fetchIframeApiBuildHash(fetchFn, origin) {
  try {
    const response = await fetchFn(new URL("/iframe_api", origin).toString(), { credentials: "omit" });
    if (!response.ok) {
      return null;
    }
    return parseIframeApiBuildHash(await response.text());
  } catch (error) {
    return null;
  }
}
