/**
 * @jest-environment node
 */
// format-selection.test.mjs
// 音声フォーマット選択(除外条件・bitrate/opus優先・itagヒント)のテスト。

import { isEligibleAudioFormat, selectAudioFormat } from "./format-selection.mjs";

/**
 * adaptiveFormatsの1要素を作る。
 * @param {object} overrides 上書きフィールド
 * @returns {object} フォーマット
 */
function format(overrides) {
  return {
    itag: 251,
    mimeType: 'audio/webm; codecs="opus"',
    bitrate: 130000,
    contentLength: "1000",
    ...overrides,
  };
}

describe("isEligibleAudioFormat", () => {
  test.each([
    ["音声のみ・contentLengthあり", format({}), true],
    ["映像フォーマット", format({ mimeType: 'video/mp4; codecs="avc1.4d401f"' }), false],
    ["DRC(xtags)", format({ xtags: "drc=1" }), false],
    ["DRC(isDrc)", format({ isDrc: true }), false],
    ["非既定音声トラック", format({ audioTrack: { id: "en.1", audioIsDefault: false } }), false],
    ["既定音声トラック", format({ audioTrack: { id: "ja.0", audioIsDefault: true } }), true],
    ["contentLength欠落", format({ contentLength: undefined }), false],
    ["contentLength不正", format({ contentLength: "abc" }), false],
    ["null", null, false],
  ])("%s → %s", (_label, input, expected) => {
    expect(isEligibleAudioFormat(input)).toBe(expected);
  });
});

describe("selectAudioFormat", () => {
  test("bitrate最大を選ぶ", () => {
    const formats = [
      format({ itag: 249, bitrate: 50000 }),
      format({ itag: 251, bitrate: 130000 }),
      format({ itag: 250, bitrate: 70000 }),
    ];
    expect(selectAudioFormat(formats).itag).toBe(251);
  });

  test("bitrate同値ならopusを優先する", () => {
    const formats = [
      format({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 }),
      format({ itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 128000 }),
    ];
    expect(selectAudioFormat(formats).itag).toBe(251);
    expect(selectAudioFormat([...formats].reverse()).itag).toBe(251);
  });

  test("除外対象(DRC・非既定トラック・contentLength欠落・映像)はbitrateが高くても選ばれない", () => {
    const formats = [
      format({ itag: 1, bitrate: 999999, xtags: "drc=1" }),
      format({ itag: 2, bitrate: 999998, audioTrack: { audioIsDefault: false } }),
      format({ itag: 3, bitrate: 999997, contentLength: undefined }),
      format({ itag: 4, bitrate: 999996, mimeType: 'video/webm; codecs="vp9"' }),
      format({ itag: 140, bitrate: 128000, mimeType: 'audio/mp4; codecs="mp4a.40.2"' }),
    ];
    expect(selectAudioFormat(formats).itag).toBe(140);
  });

  test("itagヒントが適格フォーマットにあれば優先、無ければ通常選択", () => {
    const formats = [format({ itag: 140, bitrate: 128000 }), format({ itag: 251, bitrate: 130000 })];
    expect(selectAudioFormat(formats, 140).itag).toBe(140);
    expect(selectAudioFormat(formats, 999).itag).toBe(251);
    expect(selectAudioFormat(formats, null).itag).toBe(251);
  });

  test("適格フォーマットが無ければnull", () => {
    expect(selectAudioFormat([format({ xtags: "drc=1" })])).toBeNull();
    expect(selectAudioFormat([])).toBeNull();
    expect(selectAudioFormat(undefined)).toBeNull();
  });
});
