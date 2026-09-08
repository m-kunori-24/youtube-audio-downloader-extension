/**
 * @jest-environment node
 */
// quality.test.mjs
// 音質ティア→エンコーダ設定の対応表(基本設計1.3)のテスト。
// 7形式×3ティア、opusのremux分岐、ロスレス形式のティア無視を確認する。

import {
  SUPPORTED_FORMATS,
  SUPPORTED_TIERS,
  fileExtensionFor,
  normalizeTier,
  resolveEncoderSettings,
} from "./quality.mjs";

describe("fileExtensionFor", () => {
  test("yt-dlp互換の拡張子を返す(vorbisはogg)", () => {
    expect(fileExtensionFor("mp3")).toBe("mp3");
    expect(fileExtensionFor("aac")).toBe("aac");
    expect(fileExtensionFor("m4a")).toBe("m4a");
    expect(fileExtensionFor("opus")).toBe("opus");
    expect(fileExtensionFor("vorbis")).toBe("ogg");
    expect(fileExtensionFor("wav")).toBe("wav");
    expect(fileExtensionFor("flac")).toBe("flac");
  });

  test("未対応形式はnull", () => {
    expect(fileExtensionFor("alac")).toBeNull();
  });

  test("設定記述子にも拡張子が含まれる", () => {
    for (const format of SUPPORTED_FORMATS) {
      expect(resolveEncoderSettings(format, "standard").extension).toBe(fileExtensionFor(format));
    }
  });
});

describe("normalizeTier", () => {
  test("既知のティアはそのまま返す", () => {
    for (const tier of SUPPORTED_TIERS) {
      expect(normalizeTier(tier)).toBe(tier);
    }
  });

  test("未知・未指定はstandardへ丸める", () => {
    expect(normalizeTier("ultra")).toBe("standard");
    expect(normalizeTier(undefined)).toBe("standard");
    expect(normalizeTier(null)).toBe("standard");
  });
});

describe("resolveEncoderSettings", () => {
  test("mp3は128/192/256kbpsのVBR", () => {
    expect(resolveEncoderSettings("mp3", "standard")).toMatchObject({
      pipeline: "mediabunny",
      container: "mp3",
      codec: "mp3",
      bitrate: 128000,
      bitrateMode: "variable",
      copy: false,
    });
    expect(resolveEncoderSettings("mp3", "high").bitrate).toBe(192000);
    expect(resolveEncoderSettings("mp3", "best").bitrate).toBe(256000);
  });

  test("aacはADTSコンテナで128/192/256kbps", () => {
    expect(resolveEncoderSettings("aac", "standard")).toMatchObject({
      container: "adts",
      codec: "aac",
      bitrate: 128000,
    });
    expect(resolveEncoderSettings("aac", "high").bitrate).toBe(192000);
    expect(resolveEncoderSettings("aac", "best").bitrate).toBe(256000);
  });

  test("m4aはMP4コンテナでaac、ビットレートはaacと同じ", () => {
    for (const tier of SUPPORTED_TIERS) {
      const aac = resolveEncoderSettings("aac", tier);
      const m4a = resolveEncoderSettings("m4a", tier);
      expect(m4a.container).toBe("mp4");
      expect(m4a.codec).toBe("aac");
      expect(m4a.bitrate).toBe(aac.bitrate);
    }
  });

  test("opusは入力がopusならティアを無視してremuxする", () => {
    for (const tier of SUPPORTED_TIERS) {
      expect(resolveEncoderSettings("opus", tier, "opus")).toEqual({
        pipeline: "mediabunny",
        container: "ogg",
        codec: "opus",
        copy: true,
        extension: "opus",
      });
    }
  });

  test("opusは入力がopus以外なら128/160/192kbpsで再エンコードする", () => {
    expect(resolveEncoderSettings("opus", "standard", "aac").bitrate).toBe(128000);
    expect(resolveEncoderSettings("opus", "high", "aac").bitrate).toBe(160000);
    expect(resolveEncoderSettings("opus", "best", "aac").bitrate).toBe(192000);
    expect(resolveEncoderSettings("opus", "standard", "aac").copy).toBe(false);
  });

  test("入力コーデック不明(null)のopusは再エンコード扱い", () => {
    const settings = resolveEncoderSettings("opus", "best", null);
    expect(settings.copy).toBe(false);
    expect(settings.bitrate).toBe(192000);
  });

  test("vorbisはwasm-media-encodersでvbrQuality 4/6/8", () => {
    expect(resolveEncoderSettings("vorbis", "standard")).toMatchObject({
      pipeline: "wasm-vorbis",
      container: "ogg",
      codec: "vorbis",
      vbrQuality: 4,
    });
    expect(resolveEncoderSettings("vorbis", "high").vbrQuality).toBe(6);
    expect(resolveEncoderSettings("vorbis", "best").vbrQuality).toBe(8);
  });

  test("wav/flacはロスレスのためティアを無視しビットレートを持たない", () => {
    for (const tier of SUPPORTED_TIERS) {
      expect(resolveEncoderSettings("wav", tier)).toEqual({
        pipeline: "mediabunny",
        container: "wav",
        codec: "pcm-s16",
        copy: false,
        extension: "wav",
      });
      expect(resolveEncoderSettings("flac", tier)).toEqual({
        pipeline: "mediabunny",
        container: "flac",
        codec: "flac",
        copy: false,
        extension: "flac",
      });
    }
  });

  test("対応7形式すべてで設定が得られる", () => {
    for (const format of SUPPORTED_FORMATS) {
      expect(resolveEncoderSettings(format, "standard")).not.toBeNull();
    }
  });

  test("未対応形式はnullを返す", () => {
    expect(resolveEncoderSettings("alac", "standard")).toBeNull();
    expect(resolveEncoderSettings("", "standard")).toBeNull();
  });

  test("未知のティアはstandard相当として扱う", () => {
    expect(resolveEncoderSettings("mp3", "ultra").bitrate).toBe(128000);
  });
});
