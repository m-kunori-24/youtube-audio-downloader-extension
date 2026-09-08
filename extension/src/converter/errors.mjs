// errors.mjs
// Offscreen Document(転送受信・変換・保存)が使うエラーコードと、
// コード付き例外を作るためのヘルパー。
// コード文字列は設計のエラーカタログに準拠し、SWへそのまま渡す。

/** 転送フレームのseqが期待値と一致しない。 */
export const TRANSFER_SEQ_GAP = "TRANSFER_SEQ_GAP";
/** 転送フレームのoffsetが書込み済みバイト数と一致しない。 */
export const TRANSFER_OFFSET_MISMATCH = "TRANSFER_OFFSET_MISMATCH";
/** endのbyteLengthが書込み済みバイト数と一致しない。 */
export const TRANSFER_SIZE_MISMATCH = "TRANSFER_SIZE_MISMATCH";
/** endが来ない/chunkCountが不足しているなど、転送が完結していない。 */
export const TRANSFER_INCOMPLETE = "TRANSFER_INCOMPLETE";
/** OPFS一時ファイルへの書込み(容量超過・open/close失敗を含む)が失敗した。 */
export const TRANSFER_WRITE_FAILED = "TRANSFER_WRITE_FAILED";

/** 要求された形式・音質の組合せを変換できない。 */
export const CONVERT_UNSUPPORTED = "CONVERT_UNSUPPORTED";
/** 変換処理そのものが失敗した。 */
export const CONVERT_FAILED = "CONVERT_FAILED";
/** 変換・保存が一定時間まったく進捗せず、監視タイマーにより打ち切られた。 */
export const CONVERT_STALLED = "CONVERT_STALLED";

/** 保存先ディレクトリハンドルの読み書き権限が無い。 */
export const SAVE_PERMISSION_DENIED = "SAVE_PERMISSION_DENIED";
/** 保存先ディレクトリハンドルが保存されていない。 */
export const SAVE_NO_DIRECTORY = "SAVE_NO_DIRECTORY";
/** 保存先への書込みが失敗した。 */
export const SAVE_FAILED = "SAVE_FAILED";

/**
 * codeプロパティを持つErrorを作る。
 * @param {string} code エラーコード
 * @param {string} message 人間向けメッセージ
 * @returns {Error & {code: string}} コード付きError
 */
export function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 任意の例外からエラーコードを取り出す。code未設定ならfallbackを返す。
 * @param {unknown} error 例外
 * @param {string} fallback code未設定時のコード
 * @returns {string} エラーコード
 */
export function errorCode(error, fallback) {
  if (error && typeof error === "object" && typeof error.code === "string") {
    return error.code;
  }
  return fallback;
}

/**
 * 任意の例外からメッセージ文字列を取り出す。
 * @param {unknown} error 例外
 * @returns {string} メッセージ
 */
export function errorMessage(error) {
  if (error && typeof error === "object" && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}
