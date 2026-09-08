// filename.mjs
// 保存ファイル名の無害化と、同名ファイル時のスキップ判定(Q5: スキップして成功扱い、yt-dlp互換)。

/** ファイル名の最大長(拡張子込み・文字数)。 */
export const MAX_FILE_NAME_LENGTH = 200;

/** ファイル名として使えない文字(Windows/File System Access APIの共通制約)と制御文字。 */
const ILLEGAL_CHARS = new RegExp("[<>:\"/\\\\|?*\\u0000-\\u001f]", "g");

/** 末尾のドット・空白(Windowsでは保存できない)。 */
const TRAILING_DOTS_AND_SPACES = /[. ]+$/;

/**
 * ファイル名を無害化する。使用不可文字を"_"へ置換し、
 * 末尾のドット・空白を除去し、長すぎる場合は拡張子を保ったまま切り詰める。
 * @param {unknown} name 元のファイル名
 * @returns {string} 無害化済みファイル名。空になる場合は"audio"
 */
export function sanitizeFileName(name) {
  const source = typeof name === "string" ? name : "";
  let cleaned = source.replace(ILLEGAL_CHARS, "_").trim().replace(TRAILING_DOTS_AND_SPACES, "");
  if (cleaned === "") {
    return "audio";
  }
  if (cleaned.length > MAX_FILE_NAME_LENGTH) {
    const dot = cleaned.lastIndexOf(".");
    const extension = dot > 0 ? cleaned.slice(dot) : "";
    const stemLength = Math.max(1, MAX_FILE_NAME_LENGTH - extension.length);
    cleaned = cleaned.slice(0, stemLength) + extension;
  }
  return cleaned;
}

/**
 * ディレクトリ内に同名ファイルが既に存在するかを調べる。
 * NotFoundErrorは「存在しない」を意味する正常系として扱う。
 * @param {FileSystemDirectoryHandle} directoryHandle 保存先ディレクトリ
 * @param {string} fileName ファイル名
 * @returns {Promise<boolean>} 存在すればtrue
 */
export async function fileExists(directoryHandle, fileName) {
  try {
    await directoryHandle.getFileHandle(fileName, { create: false });
    return true;
  } catch (error) {
    if (error && error.name === "NotFoundError") {
      return false;
    }
    throw error;
  }
}
