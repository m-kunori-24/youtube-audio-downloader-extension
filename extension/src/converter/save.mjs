// save.mjs
// 変換結果の書き出し先の解決。
// 保存先ディレクトリハンドルがあればFile System Access APIで直接書き、
// 未選択ならOPFS上の一時ファイルへ書いてからobject URLを作り、SW側のchrome.downloads.downloadへ委ねる(Q2)。

import { SAVE_PERMISSION_DENIED, codedError } from "./errors.mjs";
import { fileExists, sanitizeFileName } from "./filename.mjs";
import { outputFileName, removeIfExists } from "./opfs.mjs";

/**
 * ディレクトリハンドルの読み書き権限を確認する。
 * Offscreen Documentではユーザージェスチャが無く requestPermission を出せないため、
 * queryPermissionが"granted"でなければ権限エラーとして扱う。
 * @param {FileSystemDirectoryHandle} directoryHandle 保存先ディレクトリ
 * @returns {Promise<void>}
 */
export async function ensureWritePermission(directoryHandle) {
  if (typeof directoryHandle.queryPermission !== "function") {
    return;
  }
  const state = await directoryHandle.queryPermission({ mode: "readwrite" });
  if (state !== "granted") {
    throw codedError(SAVE_PERMISSION_DENIED, "保存先フォルダへの書き込み許可がありません");
  }
}

/**
 * Downloadsフォルダ内にfileNameと同名の完了済みダウンロード履歴が無いかをSWへ照会する(finding 14)。
 * chrome.downloads APIはSW側にしか無いため、Offscreenからはメッセージで問い合わせる。
 * OSのDownloadsフォルダの実ファイルを直接見ることはできず、あくまでChromeのダウンロード履歴を
 * ベストエフォートの代理シグナルとして使う(拡張機能外で置かれたファイルや履歴削除後のファイルは
 * 検出できない既知の限界。ユーザー承認済み)。応答が得られない場合は衝突なしとみなし、
 * 通常の保存フローへ進む(誤スキップによる保存漏れより、稀な上書きの方を許容する)。
 * @param {string} fileName 判定対象のファイル名(拡張子込み・サニタイズ済み)
 * @returns {Promise<boolean>} 完了済みの同名ダウンロード履歴があればtrue
 */
async function checkDownloadsFolderCollision(fileName) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "downloads.checkExists", fileName });
    return Boolean(response && response.exists === true);
  } catch (error) {
    return false;
  }
}

/**
 * 書き出し先を解決する。
 * @param {{taskId: string, fileName: string, extension: string}} params 出力情報
 * @param {{directoryHandle: FileSystemDirectoryHandle|null,
 *   getRoot: () => Promise<FileSystemDirectoryHandle>}} deps 依存
 * @returns {Promise<{skipped: boolean, fileName: string, dirName: string|null,
 *   open?: () => Promise<FileSystemWritableFileStream>, finish?: () => Promise<object>,
 *   discard?: () => Promise<void>}>}
 *   書き出し先。skipped=trueなら同名ファイル既存につき何も書かずに成功扱い
 */
export async function resolveDestination(params, deps) {
  const fileName = sanitizeFileName(params.fileName);

  if (deps.directoryHandle !== null) {
    await ensureWritePermission(deps.directoryHandle);
    if (await fileExists(deps.directoryHandle, fileName)) {
      // Q5: 同名ファイルがあれば変換も書き込みも行わず成功扱いにする(yt-dlp互換)。
      return { skipped: true, fileName, dirName: deps.directoryHandle.name };
    }
    let created = false; // boolean。getFileHandle(create:true)でエントリを作ったか
    return {
      skipped: false,
      fileName,
      dirName: deps.directoryHandle.name,
      async open() {
        const handle = await deps.directoryHandle.getFileHandle(fileName, { create: true });
        created = true;
        return handle.createWritable();
      },
      async finish() {
        return { fileName, dirName: deps.directoryHandle.name };
      },
      async discard() {
        // 変換途中で失敗した場合のロールバック。open()で作ったエントリ(0バイト・
        // 途中まで書かれたファイル)を消す。作っていなければ何もしない。
        if (!created) {
          return;
        }
        await deps.directoryHandle.removeEntry(fileName);
      },
    };
  }

  // 保存先未選択: OPFSへ書いてobject URLを作り、SWのchrome.downloads.downloadへ渡す。
  // その前に、Q5をこの経路でも可能な限り再現するため同名ダウンロード履歴を確認する(finding 14)。
  if (await checkDownloadsFolderCollision(fileName)) {
    return { skipped: true, fileName, dirName: null };
  }

  const tempName = outputFileName(params.taskId, params.extension);
  return {
    skipped: false,
    fileName,
    dirName: null,
    async open() {
      const root = await deps.getRoot();
      const handle = await root.getFileHandle(tempName, { create: true });
      return handle.createWritable();
    },
    async finish() {
      const root = await deps.getRoot();
      const handle = await root.getFileHandle(tempName, { create: false });
      const file = await handle.getFile();
      return { fileName, dirName: null, downloadUrl: URL.createObjectURL(file), tempName };
    },
    async discard() {
      await removeIfExists(deps.getRoot, tempName);
    },
  };
}
