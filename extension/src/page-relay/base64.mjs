// base64.mjs
// Uint8Array→base64文字列。1MiB規模の入力でもコールスタックを溢れさせないよう、
// String.fromCharCode.applyを固定長ブロックで呼ぶ。

const BLOCK_SIZE = 0x8000;

/**
 * バイト列をbase64(標準アルファベット、パディングあり)へ変換する。
 * @param {Uint8Array} bytes 変換対象
 * @returns {string} base64文字列
 */
export function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BLOCK_SIZE) {
    const block = bytes.subarray(offset, Math.min(offset + BLOCK_SIZE, bytes.length));
    binary += String.fromCharCode.apply(null, block);
  }
  return btoa(binary);
}
