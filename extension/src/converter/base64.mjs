// base64.mjs
// base64文字列→Uint8Array。page-relay側のbytesToBase64(標準アルファベット・パディングあり)の逆変換。

/**
 * base64文字列をバイト列へ変換する。
 * @param {string} text base64文字列
 * @returns {Uint8Array} バイト列
 */
export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
