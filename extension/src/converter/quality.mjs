// quality.mjs
// 出力形式(7種)×音質ティア(3段)→エンコーダ設定の対応表(基本設計1.3の音質ティア表)。
// mediabunnyのクラスには依存せず、純粋な記述子を返す。実際のOutputFormat生成はconvert.mjsが行う。

/** 対応する出力形式。 */
export const SUPPORTED_FORMATS = ["mp3", "aac", "m4a", "opus", "vorbis", "wav", "flac"];

/** 対応する音質ティア。 */
export const SUPPORTED_TIERS = ["standard", "high", "best"];

/** mp3のティア別ビットレート(bps)。 */
const MP3_BITRATES = { standard: 128000, high: 192000, best: 256000 };

/** aac/m4aのティア別ビットレート(bps)。 */
const AAC_BITRATES = { standard: 128000, high: 192000, best: 256000 };

/** opus再エンコード時のティア別ビットレート(bps)。 */
const OPUS_BITRATES = { standard: 128000, high: 160000, best: 192000 };

/** vorbis(wasm-media-encoders)のティア別VBR品質。 */
const VORBIS_VBR_QUALITY = { standard: 4, high: 6, best: 8 };

/**
 * 出力形式→ファイル拡張子(yt-dlp互換)。
 * SWは拡張子無しのファイル名を渡してくるため、Offscreen側でこれを付与する。
 */
const FILE_EXTENSIONS = {
  mp3: "mp3",
  aac: "aac",
  m4a: "m4a",
  opus: "opus",
  vorbis: "ogg",
  wav: "wav",
  flac: "flac",
};

/**
 * 出力形式に対応するファイル拡張子(ドット無し)を返す。
 * @param {string} format 出力形式
 * @returns {string|null} 拡張子。未対応形式ならnull
 */
export function fileExtensionFor(format) {
  return FILE_EXTENSIONS[format] ?? null;
}

/**
 * 音質ティアを正規化する。未知・未指定はstandardへ丸める。
 * @param {unknown} audioQuality 要求ティア
 * @returns {string} "standard" | "high" | "best"
 */
export function normalizeTier(audioQuality) {
  return SUPPORTED_TIERS.includes(audioQuality) ? audioQuality : "standard";
}

/**
 * 出力形式・音質ティア・入力コーデックからエンコーダ設定を決める。
 * @param {string} format 出力形式("mp3"|"aac"|"m4a"|"opus"|"vorbis"|"wav"|"flac")
 * @param {string} audioQuality 音質ティア("standard"|"high"|"best")
 * @param {string|null} sourceCodec 入力トラックのコーデック(mediabunnyのAudioCodec)。不明ならnull
 * @returns {{pipeline: string, container: string, codec: string, copy: boolean, extension: string,
 *   bitrate?: number, bitrateMode?: string, vbrQuality?: number} | null}
 *   設定記述子。formatが未対応ならnull
 */
export function resolveEncoderSettings(format, audioQuality, sourceCodec = null) {
  const settings = resolveCore(format, normalizeTier(audioQuality), sourceCodec);
  if (settings === null) {
    return null;
  }
  return { ...settings, extension: fileExtensionFor(format) };
}

/**
 * 拡張子を除いたエンコーダ設定本体を決める。
 * @param {string} format 出力形式
 * @param {string} tier 正規化済み音質ティア
 * @param {string|null} sourceCodec 入力トラックのコーデック
 * @returns {object|null} 設定記述子。formatが未対応ならnull
 */
function resolveCore(format, tier, sourceCodec) {
  switch (format) {
    case "mp3":
      return {
        pipeline: "mediabunny",
        container: "mp3",
        codec: "mp3",
        copy: false,
        bitrate: MP3_BITRATES[tier],
        bitrateMode: "variable",
      };
    case "aac":
      return {
        pipeline: "mediabunny",
        container: "adts",
        codec: "aac",
        copy: false,
        bitrate: AAC_BITRATES[tier],
        bitrateMode: "variable",
      };
    case "m4a":
      return {
        pipeline: "mediabunny",
        container: "mp4",
        codec: "aac",
        copy: false,
        bitrate: AAC_BITRATES[tier],
        bitrateMode: "variable",
      };
    case "opus":
      // 入力が既にopusならティアを無視して再エンコードせずremuxする(Q3)。
      if (sourceCodec === "opus") {
        return { pipeline: "mediabunny", container: "ogg", codec: "opus", copy: true };
      }
      return {
        pipeline: "mediabunny",
        container: "ogg",
        codec: "opus",
        copy: false,
        bitrate: OPUS_BITRATES[tier],
        bitrateMode: "variable",
      };
    case "vorbis":
      return {
        pipeline: "wasm-vorbis",
        container: "ogg",
        codec: "vorbis",
        copy: false,
        vbrQuality: VORBIS_VBR_QUALITY[tier],
      };
    case "wav":
      // ロスレスのためティアは無視する。
      return { pipeline: "mediabunny", container: "wav", codec: "pcm-s16", copy: false };
    case "flac":
      // ロスレスのためティアは無視する。
      return { pipeline: "mediabunny", container: "flac", codec: "flac", copy: false };
    default:
      return null;
  }
}
