/**
 * @jest-environment node
 */
// player-response.test.mjs
// playabilityStatus→エラーコード写像(テーブル駆動)と、playerエンドポイントのHTTP失敗写像のテスト。

import { jest } from "@jest/globals";
import { clientNameToId, ERROR_CODES, fetchPlayerResponse, mapPlayabilityStatus } from "./player-response.mjs";

/**
 * 再生可能な最小playerResponseを作る。
 * @param {object} [overrides] 上書きフィールド
 * @returns {object} playerResponse
 */
function playableResponse(overrides = {}) {
  return {
    playabilityStatus: { status: "OK" },
    videoDetails: { isLive: false, lengthSeconds: "10" },
    streamingData: { adaptiveFormats: [{ itag: 251, mimeType: 'audio/webm; codecs="opus"' }] },
    ...overrides,
  };
}

describe("mapPlayabilityStatus", () => {
  test.each([
    ["LOGIN_REQUIRED(通常)", { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you’re not a bot" }, ERROR_CODES.VIDEO_LOGIN_REQUIRED],
    ["LOGIN_REQUIRED(年齢制限文言)", { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" }, ERROR_CODES.VIDEO_AGE_RESTRICTED],
    ["LOGIN_REQUIRED(desktopLegacyAgeGate)", { status: "LOGIN_REQUIRED", desktopLegacyAgeGate: true }, ERROR_CODES.VIDEO_AGE_RESTRICTED],
    ["AGE_CHECK_REQUIRED", { status: "AGE_CHECK_REQUIRED" }, ERROR_CODES.VIDEO_AGE_RESTRICTED],
    ["AGE_VERIFICATION_REQUIRED", { status: "AGE_VERIFICATION_REQUIRED" }, ERROR_CODES.VIDEO_AGE_RESTRICTED],
    ["ERROR", { status: "ERROR", reason: "Video unavailable" }, ERROR_CODES.VIDEO_UNAVAILABLE],
    ["LIVE_STREAM_OFFLINE", { status: "LIVE_STREAM_OFFLINE" }, ERROR_CODES.VIDEO_LIVE],
    ["UNPLAYABLE", { status: "UNPLAYABLE" }, ERROR_CODES.VIDEO_UNPLAYABLE],
    ["CONTENT_CHECK_REQUIRED", { status: "CONTENT_CHECK_REQUIRED" }, ERROR_CODES.VIDEO_UNPLAYABLE],
    ["未知のstatus", { status: "SOMETHING_NEW" }, ERROR_CODES.VIDEO_UNPLAYABLE],
    ["playabilityStatus欠落", undefined, ERROR_CODES.VIDEO_UNPLAYABLE],
  ])("%s → %s", (_label, playabilityStatus, expectedCode) => {
    const response = { playabilityStatus, streamingData: { adaptiveFormats: [] } };
    expect(mapPlayabilityStatus(response)?.code).toBe(expectedCode);
  });

  test("OKでもisLive=trueならVIDEO_LIVE", () => {
    const response = playableResponse({ videoDetails: { isLive: true } });
    expect(mapPlayabilityStatus(response)).toEqual({ code: ERROR_CODES.VIDEO_LIVE, reason: "live stream" });
  });

  test("OKでもliveStreamabilityがあればVIDEO_LIVE", () => {
    const response = playableResponse({ playabilityStatus: { status: "OK", liveStreamability: {} } });
    expect(mapPlayabilityStatus(response)?.code).toBe(ERROR_CODES.VIDEO_LIVE);
  });

  test("OKでstreamingData欠落ならVIDEO_UNPLAYABLE", () => {
    const response = playableResponse({ streamingData: undefined });
    expect(mapPlayabilityStatus(response)?.code).toBe(ERROR_CODES.VIDEO_UNPLAYABLE);
  });

  test("licenseInfosがあればVIDEO_DRM", () => {
    const response = playableResponse({
      streamingData: { adaptiveFormats: [{ itag: 140 }], licenseInfos: [{ drmFamily: "WIDEVINE" }] },
    });
    expect(mapPlayabilityStatus(response)?.code).toBe(ERROR_CODES.VIDEO_DRM);
  });

  test("全フォーマットがdrmFamilies付きならVIDEO_DRM、一部だけならOK扱い", () => {
    const allDrm = playableResponse({
      streamingData: { adaptiveFormats: [{ itag: 140, drmFamilies: ["WIDEVINE"] }] },
    });
    expect(mapPlayabilityStatus(allDrm)?.code).toBe(ERROR_CODES.VIDEO_DRM);
    const partial = playableResponse({
      streamingData: { adaptiveFormats: [{ itag: 140, drmFamilies: ["WIDEVINE"] }, { itag: 251 }] },
    });
    expect(mapPlayabilityStatus(partial)).toBeNull();
  });

  test("再生可能ならnull", () => {
    expect(mapPlayabilityStatus(playableResponse())).toBeNull();
  });
});

describe("clientNameToId", () => {
  test("WEB→1、数値文字列はそのまま、不明はWEB(1)", () => {
    expect(clientNameToId("WEB")).toBe(1);
    expect(clientNameToId("MWEB")).toBe(2);
    expect(clientNameToId("67")).toBe(67);
    expect(clientNameToId(5)).toBe(5);
    expect(clientNameToId(undefined)).toBe(1);
  });
});

describe("fetchPlayerResponse", () => {
  const context = { client: { clientName: "WEB", clientVersion: "2.20260901.00.00" } };

  test("認証ヘッダー付きでPOSTし、JSONを返す", async () => {
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ playabilityStatus: { status: "OK" } }) }));
    const result = await fetchPlayerResponse({
      fetchFn,
      videoId: "abc123",
      context,
      authorization: "SAPISIDHASH 1_x",
      sessionIndex: "0",
    });
    expect(result).toEqual({ playabilityStatus: { status: "OK" } });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://www.youtube.com/youtubei/v1/player?prettyPrint=false");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.headers.authorization).toBe("SAPISIDHASH 1_x");
    expect(init.headers["x-origin"]).toBe("https://www.youtube.com");
    expect(init.headers["x-youtube-client-name"]).toBe("1");
    expect(init.headers["x-youtube-client-version"]).toBe("2.20260901.00.00");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ context, videoId: "abc123" });
    expect(body.playbackContext).toBeUndefined();
  });

  test.each([
    [401, ERROR_CODES.AUTH_REJECTED],
    [403, ERROR_CODES.AUTH_REJECTED],
    [500, ERROR_CODES.PLAYER_REQUEST_FAILED],
  ])("HTTP %s → %s", async (status, expectedCode) => {
    const fetchFn = jest.fn(async () => ({ ok: false, status, json: async () => ({}) }));
    await expect(
      fetchPlayerResponse({ fetchFn, videoId: "v", context, authorization: "a", sessionIndex: "0" }),
    ).rejects.toMatchObject({ code: expectedCode });
  });

  test("fetch例外・JSON不正はPLAYER_REQUEST_FAILED", async () => {
    const throwing = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      fetchPlayerResponse({ fetchFn: throwing, videoId: "v", context, authorization: "a", sessionIndex: "0" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.PLAYER_REQUEST_FAILED });
    const badJson = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad");
      },
    }));
    await expect(
      fetchPlayerResponse({ fetchFn: badJson, videoId: "v", context, authorization: "a", sessionIndex: "0" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.PLAYER_REQUEST_FAILED });
  });
});
