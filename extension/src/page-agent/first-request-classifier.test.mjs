/**
 * @jest-environment node
 */
// first-request-classifier.test.mjs
// 最初のSABR POST失敗の分類(403/その他HTTP/不透明失敗+no-corsプローブ)のテスト。

import { jest } from "@jest/globals";
import { classifyFetchException, classifyHttpFailure, FIRST_REQUEST_OUTCOME } from "./first-request-classifier.mjs";

describe("classifyHttpFailure", () => {
  test("403 → SIGNATURE_REJECTED", () => {
    expect(classifyHttpFailure(403)).toEqual({ outcome: FIRST_REQUEST_OUTCOME.SIGNATURE_REJECTED, status: 403 });
  });

  test.each([400, 404, 429, 500, 503])("%s → SABR_SERVER_ERROR", (status) => {
    expect(classifyHttpFailure(status)).toEqual({ outcome: FIRST_REQUEST_OUTCOME.SABR_SERVER_ERROR, status });
  });
});

describe("classifyFetchException", () => {
  const URL_UNDER_TEST = "https://rr1---sn-example.googlevideo.com/videoplayback?sabr=1&n=abc";

  test("TypeError + プローブ解決 → SIGNATURE_REJECTED(no-cors GETプローブを同一URLへ打つ)", async () => {
    const probe = jest.fn(async () => ({ type: "opaque", ok: false, status: 0 }));
    const result = await classifyFetchException(new TypeError("Failed to fetch"), URL_UNDER_TEST, probe);
    expect(result.outcome).toBe(FIRST_REQUEST_OUTCOME.SIGNATURE_REJECTED);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0]).toBe(URL_UNDER_TEST);
    expect(probe.mock.calls[0][1]).toEqual({ method: "GET", mode: "no-cors", cache: "no-store", credentials: "omit" });
  });

  test("TypeError + プローブ拒否 → NETWORK_UNREACHABLE", async () => {
    const probe = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await classifyFetchException(new TypeError("Failed to fetch"), URL_UNDER_TEST, probe);
    expect(result.outcome).toBe(FIRST_REQUEST_OUTCOME.NETWORK_UNREACHABLE);
  });

  test("TypeError以外の例外はプローブせずSABR_SERVER_ERROR", async () => {
    const probe = jest.fn();
    const result = await classifyFetchException(new Error("aborted"), URL_UNDER_TEST, probe);
    expect(result.outcome).toBe(FIRST_REQUEST_OUTCOME.SABR_SERVER_ERROR);
    expect(probe).not.toHaveBeenCalled();
  });
});
