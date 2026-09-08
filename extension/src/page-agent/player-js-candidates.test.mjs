/**
 * @jest-environment node
 */
// player-js-candidates.test.mjs
// プレイヤーJS候補の列挙順・重複排除・除外・バリアント書き換え、URL/iframe_api解析のテスト。

import {
  buildCandidateList,
  buildPlayerJsUrl,
  isAllowedPlayerJsUrl,
  parseIframeApiBuildHash,
  parsePlayerJsUrl,
  readPagePlayerJsUrl,
} from "./player-js-candidates.mjs";

const ORIGIN = "https://www.youtube.com";

describe("parsePlayerJsUrl / buildPlayerJsUrl / parseIframeApiBuildHash", () => {
  test("相対パス・絶対URL・ロケール違いを解析できる", () => {
    expect(parsePlayerJsUrl("/s/player/f572e43c/player_es6.vflset/ja_JP/base.js")).toEqual({ buildHash: "f572e43c", variant: "player_es6" });
    expect(parsePlayerJsUrl(`${ORIGIN}/s/player/8c3fda2d/player_ias_tce.vflset/en_US/base.js`)).toEqual({ buildHash: "8c3fda2d", variant: "player_ias_tce" });
    expect(parsePlayerJsUrl("https://example.com/other.js")).toBeNull();
  });

  test("buildPlayerJsUrlはen_USのbase.js絶対URLを組み立てる", () => {
    expect(buildPlayerJsUrl("abcd1234", "player_ias", ORIGIN)).toBe(`${ORIGIN}/s/player/abcd1234/player_ias.vflset/en_US/base.js`);
  });

  test("iframe_api本文のエスケープ済みURLからハッシュを取る", () => {
    const source = 'a.src="https:\\/\\/www.youtube.com\\/s\\/player\\/f572e43c\\/www-widgetapi.vflset\\/www-widgetapi.js"';
    expect(parseIframeApiBuildHash(source)).toBe("f572e43c");
    expect(parseIframeApiBuildHash("nothing here")).toBeNull();
  });
});

describe("buildCandidateList", () => {
  test("順序: known-good → page → iframe_api → variant書き換え(最大4候補)", () => {
    const candidates = buildCandidateList({
      knownGoodUrl: `${ORIGIN}/s/player/kkkk0000/player_ias.vflset/en_US/base.js`,
      excluded: [],
      pagePlayerJsUrl: "/s/player/aaaa1111/player_ias.vflset/ja_JP/base.js",
      iframeApiBuildHash: "bbbb2222",
      origin: ORIGIN,
    });
    expect(candidates.map((c) => [c.source, c.buildHash, c.variant])).toEqual([
      ["known-good", "kkkk0000", "player_ias"],
      ["page", "aaaa1111", "player_ias"],
      ["iframe-api", "bbbb2222", "player_ias"],
      ["variant-rewrite", "aaaa1111", "player_es6"],
    ]);
    expect(candidates[1].url).toBe(`${ORIGIN}/s/player/aaaa1111/player_ias.vflset/ja_JP/base.js`);
  });

  test("iframe_api候補はpageのバリアントを引き継ぎ、pageが無ければplayer_es6", () => {
    const withPage = buildCandidateList({
      knownGoodUrl: null,
      excluded: [],
      pagePlayerJsUrl: "/s/player/aaaa1111/player_es6.vflset/ja_JP/base.js",
      iframeApiBuildHash: "bbbb2222",
      origin: ORIGIN,
    });
    expect(withPage.map((c) => [c.source, c.buildHash, c.variant])).toEqual([
      ["page", "aaaa1111", "player_es6"],
      ["iframe-api", "bbbb2222", "player_es6"],
      ["variant-rewrite", "aaaa1111", "player_ias"],
    ]);
    const withoutPage = buildCandidateList({ knownGoodUrl: null, excluded: [], pagePlayerJsUrl: null, iframeApiBuildHash: "bbbb2222", origin: ORIGIN });
    expect(withoutPage.map((c) => [c.source, c.buildHash, c.variant])).toEqual([
      ["iframe-api", "bbbb2222", "player_es6"],
      ["variant-rewrite", "bbbb2222", "player_ias"],
    ]);
  });

  test("同一ハッシュ・同一バリアントは重複排除し、書き換えは(b)が無ければ(c)のハッシュに適用する", () => {
    const candidates = buildCandidateList({
      knownGoodUrl: `${ORIGIN}/s/player/aaaa1111/player_ias.vflset/en_US/base.js`,
      excluded: [],
      pagePlayerJsUrl: null,
      iframeApiBuildHash: "aaaa1111",
      origin: ORIGIN,
    });
    expect(candidates.map((c) => [c.source, c.buildHash, c.variant])).toEqual([
      ["known-good", "aaaa1111", "player_ias"],
      ["iframe-api", "aaaa1111", "player_es6"],
    ]);
  });

  test("excludedに一致する候補(known-good含む)は列挙しない", () => {
    const candidates = buildCandidateList({
      knownGoodUrl: `${ORIGIN}/s/player/aaaa1111/player_ias.vflset/en_US/base.js`,
      excluded: [
        { buildHash: "aaaa1111", variant: "player_ias" },
        { buildHash: "aaaa1111", variant: "player_ias_tce" },
      ],
      pagePlayerJsUrl: "/s/player/aaaa1111/player_ias.vflset/en_US/base.js",
      iframeApiBuildHash: "bbbb2222",
      origin: ORIGIN,
    });
    expect(candidates.map((c) => [c.source, c.buildHash, c.variant])).toEqual([
      ["iframe-api", "bbbb2222", "player_ias"],
      ["variant-rewrite", "aaaa1111", "player_es6"],
    ]);
  });

  test("何も見つからなければ空", () => {
    expect(buildCandidateList({ knownGoodUrl: null, excluded: [], pagePlayerJsUrl: null, iframeApiBuildHash: null, origin: ORIGIN })).toEqual([]);
  });
});

describe("isAllowedPlayerJsUrl(finding 3)", () => {
  test("実在するパス形状(player_es6/player_ias/player_ias_tce)を許可する", () => {
    expect(isAllowedPlayerJsUrl(`${ORIGIN}/s/player/f572e43c/player_es6.vflset/ja_JP/base.js`)).toBe(true);
    expect(isAllowedPlayerJsUrl(`${ORIGIN}/s/player/8c3fda2d/player_ias.vflset/en_US/base.js`)).toBe(true);
    expect(isAllowedPlayerJsUrl(`${ORIGIN}/s/player/8c3fda2d/player_ias_tce.vflset/en_US/base.js`)).toBe(true);
  });

  test("プロトコル・ホスト・パス形状のいずれかが違えば拒否する", () => {
    expect(isAllowedPlayerJsUrl(`http://www.youtube.com/s/player/aaaa1111/player_es6.vflset/en_US/base.js`)).toBe(false);
    expect(isAllowedPlayerJsUrl(`https://evil.example/s/player/aaaa1111/player_es6.vflset/en_US/base.js`)).toBe(false);
    expect(isAllowedPlayerJsUrl(`https://www.youtube.com.evil.example/s/player/aaaa1111/player_es6.vflset/en_US/base.js`)).toBe(false);
    expect(isAllowedPlayerJsUrl(`${ORIGIN}/not/a/player/path.js`)).toBe(false);
    expect(isAllowedPlayerJsUrl(`${ORIGIN}/s/player/aaaa1111/player_es6.vflset/en_US/other.js`)).toBe(false);
  });

  test("認証情報・クエリ・フラグメントが付与されたURLは拒否する", () => {
    expect(isAllowedPlayerJsUrl(`https://user:pass@www.youtube.com/s/player/aaaa1111/player_es6.vflset/en_US/base.js`)).toBe(false);
    expect(isAllowedPlayerJsUrl(`${ORIGIN}/s/player/aaaa1111/player_es6.vflset/en_US/base.js?x=1`)).toBe(false);
    expect(isAllowedPlayerJsUrl(`${ORIGIN}/s/player/aaaa1111/player_es6.vflset/en_US/base.js#frag`)).toBe(false);
  });

  test("不正なURL文字列やnullを渡した場合は例外を投げずfalseを返す", () => {
    expect(isAllowedPlayerJsUrl("not a url")).toBe(false);
    expect(isAllowedPlayerJsUrl("")).toBe(false);
  });
});

describe("buildCandidateListは許可されないURLの候補を列挙前に落とす(finding 3)", () => {
  test("汚染されたknownGoodUrl(別ホスト)は候補に現れない(他の正当な候補元は影響を受けない)", () => {
    const candidates = buildCandidateList({
      knownGoodUrl: "https://evil.example/s/player/aaaa1111/player_es6.vflset/en_US/base.js",
      excluded: [],
      pagePlayerJsUrl: "/s/player/bbbb2222/player_es6.vflset/en_US/base.js",
      iframeApiBuildHash: null,
      origin: ORIGIN,
    });
    expect(candidates.map((c) => [c.source, c.buildHash])).toEqual([
      ["page", "bbbb2222"],
      ["variant-rewrite", "bbbb2222"],
    ]);
    expect(candidates.every((c) => c.buildHash !== "aaaa1111")).toBe(true);
  });

  test("http(非https)のknownGoodUrlは候補に現れない(他に候補元が無ければ空)", () => {
    const candidates = buildCandidateList({
      knownGoodUrl: "http://www.youtube.com/s/player/aaaa1111/player_es6.vflset/en_US/base.js",
      excluded: [],
      pagePlayerJsUrl: null,
      iframeApiBuildHash: null,
      origin: ORIGIN,
    });
    expect(candidates).toEqual([]);
  });
});

describe("readPagePlayerJsUrl", () => {
  test("ytcfg PLAYER_JS_URLを優先し、無ければscript[src*=/s/player/]、どちらも無ければnull", () => {
    expect(readPagePlayerJsUrl({ ytcfgGet: () => "/s/player/x/player_es6.vflset/en_US/base.js", document: null })).toBe("/s/player/x/player_es6.vflset/en_US/base.js");
    const document = { querySelector: (selector) => (selector === 'script[src*="/s/player/"]' ? { src: `${ORIGIN}/s/player/y/player_es6.vflset/en_US/base.js` } : null) };
    expect(readPagePlayerJsUrl({ ytcfgGet: () => undefined, document })).toBe(`${ORIGIN}/s/player/y/player_es6.vflset/en_US/base.js`);
    expect(readPagePlayerJsUrl({ ytcfgGet: () => undefined, document: { querySelector: () => null } })).toBeNull();
  });
});
