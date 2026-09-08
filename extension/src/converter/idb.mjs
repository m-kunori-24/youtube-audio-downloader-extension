// idb.mjs
// popup(T11)が保存先選択時に格納したFileSystemDirectoryHandleを、
// Offscreen DocumentからIndexedDB経由で読み出す(T0スパイクのパターン)。
// DirectoryHandleはstructured cloneでIndexedDBへ格納できるが、
// chrome.storageやメッセージでは受け渡せないためこの経路を使う。

// 定数はpopup.js(T11)側のSETTINGS_DB_NAME/SETTINGS_DB_VERSION/SETTINGS_STORE_NAME/
// OUTPUT_DIR_KEYと一致していなければならない。
/** ハンドル置き場のデータベース名。 */
export const DB_NAME = "ytae-settings";
/** データベースのバージョン。 */
export const DB_VERSION = 1;
/** ハンドルを入れるオブジェクトストア名。 */
export const STORE_NAME = "handles";
/** 保存先ディレクトリハンドルのキー。 */
export const OUTPUT_DIR_KEY = "outputDir";

/**
 * データベースを開く。存在しなければオブジェクトストアを作成する。
 * @param {IDBFactory} factory indexedDB実装
 * @returns {Promise<IDBDatabase>} データベース
 */
export function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 保存先ディレクトリハンドルを読み出す。未選択ならnull。
 * @param {IDBFactory} factory indexedDB実装
 * @returns {Promise<FileSystemDirectoryHandle|null>} ディレクトリハンドル
 */
export async function loadOutputDirectoryHandle(factory) {
  const db = await openDatabase(factory);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(OUTPUT_DIR_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
