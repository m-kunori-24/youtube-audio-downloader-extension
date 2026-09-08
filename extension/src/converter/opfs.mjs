// opfs.mjs
// OPFS(Origin Private File System)上の一時ファイル操作。
// 転送中の生バイトは audio-<taskId>.bin、保存先ディレクトリ未選択時の変換出力は
// out-<taskId>.<ext> へ書き出す。どちらもOffscreen Document起動時に残骸を掃除する。

import { TRANSFER_WRITE_FAILED, codedError, errorMessage } from "./errors.mjs";

/** 転送一時ファイルの接頭辞。 */
export const TEMP_PREFIX = "audio-";
/** 転送一時ファイルの拡張子。 */
export const TEMP_SUFFIX = ".bin";
/** 変換出力一時ファイルの接頭辞。 */
export const OUTPUT_PREFIX = "out-";

/**
 * 転送一時ファイル名を組み立てる。
 * @param {string} taskId タスクID
 * @returns {string} ファイル名
 */
export function tempFileName(taskId) {
  return `${TEMP_PREFIX}${taskId}${TEMP_SUFFIX}`;
}

/**
 * 変換出力一時ファイル名を組み立てる。
 * @param {string} taskId タスクID
 * @param {string} extension 拡張子(ドット無し)
 * @returns {string} ファイル名
 */
export function outputFileName(taskId, extension) {
  return `${OUTPUT_PREFIX}${taskId}.${extension}`;
}

/**
 * OPFS上の残骸(転送一時ファイル・変換出力一時ファイル)かどうかを判定する。
 * @param {string} name エントリ名
 * @returns {boolean} 残骸ならtrue
 */
export function isLeftoverName(name) {
  return (name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX)) || name.startsWith(OUTPUT_PREFIX);
}

/**
 * OPFSルート直下の残骸ファイルを全て削除する。前セッションのクラッシュからの復旧用。
 * @param {FileSystemDirectoryHandle} root OPFSルート
 * @returns {Promise<string[]>} 削除したファイル名一覧
 */
export async function cleanupLeftovers(root) {
  /** @type {string[]} */
  const names = [];
  for await (const name of root.keys()) {
    if (isLeftoverName(name)) {
      names.push(name);
    }
  }
  /** @type {string[]} */
  const removed = [];
  for (const name of names) {
    try {
      await root.removeEntry(name);
      removed.push(name);
    } catch (error) {
      // 他コンテキストが掴んでいる等で消せない場合は次回起動に委ねる
    }
  }
  return removed;
}

/**
 * OPFSの読み書き操作を実行し、失敗を TRANSFER_WRITE_FAILED 付きの例外へ変換する。
 * 容量超過(QuotaExceededError)・書込み失敗・close失敗を、汎用の
 * TRANSFER_INCOMPLETE ではなく専用コードでSWへ伝えるため。
 * @template T
 * @param {() => Promise<T>} operation 実行するOPFS操作
 * @returns {Promise<T>} 操作の結果
 */
async function withWriteFailure(operation) {
  try {
    return await operation();
  } catch (error) {
    throw codedError(TRANSFER_WRITE_FAILED, errorMessage(error));
  }
}

/**
 * transfer.mjsが要求するストレージ実装をOPFSで作る。
 * @param {() => Promise<FileSystemDirectoryHandle>} getRoot OPFSルートを返す関数
 * @returns {{open: Function, write: Function, close: Function, discard: Function}} ストレージ実装
 */
export function createOpfsStorage(getRoot) {
  return {
    /**
     * 一時ファイルを新規に開く(既存内容は切り詰められる)。
     * @param {string} taskId タスクID
     * @returns {Promise<{name: string, handle: FileSystemFileHandle, writable: FileSystemWritableFileStream}>} セッション
     */
    async open(taskId) {
      return withWriteFailure(async () => {
        const root = await getRoot();
        const name = tempFileName(taskId);
        const handle = await root.getFileHandle(name, { create: true });
        let writable;
        try {
          writable = await handle.createWritable();
        } catch (error) {
          await root.removeEntry(name).catch(() => {});
          throw error;
        }
        return { name, handle, writable };
      });
    },

    /**
     * セッションへバイト列を追記する。
     * @param {{writable: FileSystemWritableFileStream}} session セッション
     * @param {Uint8Array} bytes 書き込むバイト列
     * @returns {Promise<void>}
     */
    async write(session, bytes) {
      await withWriteFailure(() => session.writable.write(bytes));
    },

    /**
     * セッションを閉じ、書き上がったFileを返す。
     * @param {{handle: FileSystemFileHandle, writable: FileSystemWritableFileStream}} session セッション
     * @returns {Promise<File>} 書き上がったファイル
     */
    async close(session) {
      return withWriteFailure(async () => {
        await session.writable.close();
        return session.handle.getFile();
      });
    },

    /**
     * セッションを破棄し、一時ファイルを削除する。
     * @param {{name: string, writable: FileSystemWritableFileStream}} session セッション
     * @returns {Promise<void>}
     */
    async discard(session) {
      try {
        await session.writable.abort();
      } catch (error) {
        // 既にcloseされている場合の例外は無視する
      }
      const root = await getRoot();
      try {
        await root.removeEntry(session.name);
      } catch (error) {
        // 既に削除済みの場合の例外は無視する
      }
    },
  };
}

/**
 * OPFSルート直下のファイルを削除する。存在しない場合は何もしない。
 * @param {() => Promise<FileSystemDirectoryHandle>} getRoot OPFSルートを返す関数
 * @param {string} name ファイル名
 * @returns {Promise<void>}
 */
export async function removeIfExists(getRoot, name) {
  try {
    const root = await getRoot();
    await root.removeEntry(name);
  } catch (error) {
    // 未作成・削除済みの場合は正常系として扱う
  }
}
