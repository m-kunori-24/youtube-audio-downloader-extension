// frame-auth.mjs
// MAIN world(page-agent)とISOLATED world(page-relay)の間でwindow.postMessage越しに
// やり取りするフレームのHMAC-SHA256署名・検証(finding 1)。
// 鍵はSWがタスクごとに生成する32バイトの秘密(hex)から導出する。
// MACはフレームのヘッダ(macを除いたJSON。dataフレームではbytesも除く)とbytesペイロードの連結に対して計算する。
// (statusフレームのbytesは進捗バイト数の数値でありペイロードではないため、ヘッダに残す。)

const FRAME_KEY_ALGORITHM = { name: "HMAC", hash: "SHA-256" };

/**
 * hex文字列をバイト列へ変換する。
 * @param {string} hex 偶数長のhex文字列
 * @returns {Uint8Array} バイト列
 */
export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * バイト列をhex文字列へ変換する。
 * @param {Uint8Array} bytes バイト列
 * @returns {string} 小文字hex
 */
export function bytesToHex(bytes) {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * 2つのバイト列を連結する。
 * @param {Uint8Array} a 先頭
 * @param {Uint8Array} b 後続
 * @returns {Uint8Array} 連結結果
 */
export function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * 秘密(hex)からHMAC鍵をインポートする。
 * @param {SubtleCrypto} subtle Web Crypto
 * @param {string} secretHex SWが生成した秘密(hex)
 * @returns {Promise<CryptoKey>} sign/verify用の鍵
 */
export async function importFrameKey(subtle, secretHex) {
  const bytes = hexToBytes(secretHex);
  return subtle.importKey("raw", bytes, FRAME_KEY_ALGORITHM, false, ["sign", "verify"]);
}

/**
 * フレームのこのキーがペイロード(MACヘッダから除外し、生バイト列として連結する側)かを返す。
 * @param {object} frame フレーム
 * @param {string} key フィールド名
 * @returns {boolean} dataフレームのbytesならtrue
 */
export function isPayloadField(frame, key) {
  return key === "bytes" && frame.type === "data";
}

/**
 * MAC計算対象のバイト列(ヘッダJSON + ペイロード)を組み立てる。
 * ヘッダはフレームからmacと(dataフレームの)bytesを除いたもの。キー順はフレーム作成時の
 * 挿入順をそのまま使う(structured cloneは挿入順を保つため送受信で一致する)。
 * @param {object} frame フレーム(macを含んでいてもよい)
 * @param {Uint8Array|undefined} bytesPayload dataフレームのbytesの生バイト列
 * @returns {Uint8Array} MAC計算対象
 */
function macInput(frame, bytesPayload) {
  /** @type {Record<string, unknown>} */
  const header = {};
  for (const [key, value] of Object.entries(frame)) {
    if (key !== "mac" && !isPayloadField(frame, key)) {
      header[key] = value;
    }
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  return concatBytes(headerBytes, bytesPayload ?? new Uint8Array(0));
}

/**
 * フレームに付けるMAC(hex)を計算する。
 * @param {SubtleCrypto} subtle Web Crypto
 * @param {CryptoKey} key importFrameKeyの鍵
 * @param {object} frameWithoutMac macを付ける前のフレーム
 * @param {Uint8Array} [bytesPayload] bytesフィールドの生バイト列(無ければ空)
 * @returns {Promise<string>} MAC(hex)
 */
export async function signFrame(subtle, key, frameWithoutMac, bytesPayload) {
  const macBuffer = await subtle.sign("HMAC", key, macInput(frameWithoutMac, bytesPayload));
  return bytesToHex(new Uint8Array(macBuffer));
}

/**
 * フレームのMACを検証する。
 * @param {SubtleCrypto} subtle Web Crypto
 * @param {CryptoKey} key importFrameKeyの鍵
 * @param {object} frameWithoutMac 検証対象フレーム(macフィールドは無視される)
 * @param {Uint8Array|undefined} bytesPayload bytesフィールドの生バイト列
 * @param {string} mac 受信したMAC(hex)
 * @returns {Promise<boolean>} 正当ならtrue
 */
export async function verifyFrame(subtle, key, frameWithoutMac, bytesPayload, mac) {
  if (typeof mac !== "string" || mac.length !== 64) {
    return false;
  }
  let macBytes;
  try {
    macBytes = hexToBytes(mac);
  } catch (error) {
    return false;
  }
  return subtle.verify("HMAC", key, macBytes, macInput(frameWithoutMac, bytesPayload));
}

/**
 * 有限の非負整数かを判定する(epoch/offset/seq/byteLength等の検証用)。
 * @param {unknown} value 判定対象
 * @returns {boolean} 有限の非負整数ならtrue
 */
export function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
