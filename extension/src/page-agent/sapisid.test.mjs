/**
 * @jest-environment node
 */
// sapisid.test.mjs
// SAPISIDHASH計算とCookie解析の単体テスト。

import { webcrypto } from "node:crypto";
import { computeSapisidHash, parseCookieString, readSapisidCookie, sha1Hex } from "./sapisid.mjs";

// テストベクトルの出所: 公開仕様 sha1("{timestamp} {SAPISID} {origin}") を Node の
// `crypto.createHash("sha1").update("1700000000 TESTSAPISIDVALUE https://www.youtube.com").digest("hex")`
// で独立に計算した値(実装とは別経路のnode:cryptoで導出)。
const VECTOR_TIMESTAMP = 1700000000;
const VECTOR_SAPISID = "TESTSAPISIDVALUE";
const VECTOR_SHA1 = "a570178bb8d37dae3d5154f66118984698a6de86";

describe("sha1Hex", () => {
  test("既知入力のSHA-1が小文字16進40桁で一致する", async () => {
    await expect(
      sha1Hex(`${VECTOR_TIMESTAMP} ${VECTOR_SAPISID} https://www.youtube.com`, webcrypto.subtle),
    ).resolves.toBe(VECTOR_SHA1);
  });
});

describe("computeSapisidHash", () => {
  test("既定originでSAPISIDHASH {ts}_{hash}形式を返す", async () => {
    await expect(
      computeSapisidHash({ sapisid: VECTOR_SAPISID, timestampSeconds: VECTOR_TIMESTAMP, subtle: webcrypto.subtle }),
    ).resolves.toBe(`SAPISIDHASH ${VECTOR_TIMESTAMP}_${VECTOR_SHA1}`);
  });

  test("originを変えるとハッシュが変わる", async () => {
    const other = await computeSapisidHash({
      sapisid: VECTOR_SAPISID,
      timestampSeconds: VECTOR_TIMESTAMP,
      origin: "https://music.youtube.com",
      subtle: webcrypto.subtle,
    });
    expect(other).not.toBe(`SAPISIDHASH ${VECTOR_TIMESTAMP}_${VECTOR_SHA1}`);
    expect(other).toMatch(/^SAPISIDHASH 1700000000_[0-9a-f]{40}$/);
  });
});

describe("parseCookieString / readSapisidCookie", () => {
  test("複数Cookieから名前で引ける。値中の=も保持する", () => {
    const cookies = parseCookieString("A=1; SAPISID=abc=def ; B=x=y");
    expect(cookies).toEqual({ A: "1", SAPISID: "abc=def", B: "x=y" });
  });

  test("SAPISIDを優先し、無ければ__Secure-3PAPISID、どちらも無ければnull", () => {
    expect(readSapisidCookie("__Secure-3PAPISID=second; SAPISID=first")).toBe("first");
    expect(readSapisidCookie("__Secure-3PAPISID=second")).toBe("second");
    expect(readSapisidCookie("SAPISID=; OTHER=1")).toBeNull();
    expect(readSapisidCookie("")).toBeNull();
  });
});
