// format-selection.mjs
// streamingData.adaptiveFormatsから取得対象の音声フォーマットを1つ選ぶ。
// 音質ティア(qualityTier)はOffscreen側エンコーダにのみ影響し、ここでの選択には使わない。

/**
 * フォーマットが取得候補として適格か判定する。
 * 除外: 音声以外、DRC(xtagsにdrc / isDrc)、既定でない音声トラック、contentLength欠落。
 * @param {object} format adaptiveFormatsの1要素
 * @returns {boolean} 適格ならtrue
 */
export function isEligibleAudioFormat(format) {
  if (!format || typeof format !== "object") {
    return false;
  }
  const mimeType = typeof format.mimeType === "string" ? format.mimeType : "";
  if (!mimeType.startsWith("audio/")) {
    return false;
  }
  const xtags = typeof format.xtags === "string" ? format.xtags : "";
  if (xtags.includes("drc") || format.isDrc === true) {
    return false;
  }
  if (format.audioTrack && format.audioTrack.audioIsDefault === false) {
    return false;
  }
  const contentLength = Number.parseInt(format.contentLength, 10);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return false;
  }
  return true;
}

/**
 * 2フォーマットを「bitrate降順、同値ならopus優先」で比較する。
 * @param {object} a 比較対象
 * @param {object} b 比較対象
 * @returns {number} sort用比較値
 */
function compareByPreference(a, b) {
  const bitrateA = Number(a.bitrate) || 0;
  const bitrateB = Number(b.bitrate) || 0;
  if (bitrateA !== bitrateB) {
    return bitrateB - bitrateA;
  }
  const opusA = String(a.mimeType).includes("opus") ? 1 : 0;
  const opusB = String(b.mimeType).includes("opus") ? 1 : 0;
  return opusB - opusA;
}

/**
 * 取得対象の音声フォーマットを選ぶ。
 * preferredItagが指定され、かつ適格フォーマットに含まれていればそれを優先する。
 * @param {object[]} adaptiveFormats streamingData.adaptiveFormats
 * @param {number|null|undefined} [preferredItag] SWからのitagヒント(任意)
 * @returns {object|null} 選ばれたフォーマット。適格なものが無ければnull
 */
export function selectAudioFormat(adaptiveFormats, preferredItag) {
  const eligible = (Array.isArray(adaptiveFormats) ? adaptiveFormats : []).filter(isEligibleAudioFormat);
  if (eligible.length === 0) {
    return null;
  }
  if (typeof preferredItag === "number") {
    const preferred = eligible.find((format) => format.itag === preferredItag);
    if (preferred) {
      return preferred;
    }
  }
  return [...eligible].sort(compareByPreference)[0];
}
