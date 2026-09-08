// test-utils/indexedDbStub.js
// jestテストで使用するindexedDBの最小スタブ。
// popup.jsが保存先ディレクトリハンドルの永続化に使うAPI
// (open/onupgradeneeded/transaction/objectStore.put/get/delete)のみを
// メモリ上で再現する。

/**
 * indexedDBの最小スタブを作る。データベース名ごとにobject storeのMapを
 * メモリ上に保持する。
 * @returns {{indexedDB: object, databases: Map}} グローバルへ設定するindexedDBオブジェクトと、
 *   内部状態を直接検査するためのMap
 */
function createIndexedDbStub() {
  const databases = new Map(); // dbName -> Map(storeName -> Map(key -> value))

  /**
   * 標準IDBRequest風のオブジェクトを作る。
   * @returns {object} onsuccess/onerror/resultを持つ疑似リクエスト
   */
  function createRequest() {
    return { result: undefined, error: undefined, onsuccess: null, onerror: null };
  }

  const indexedDB = {
    open: jest.fn((name) => {
      const request = { ...createRequest(), onupgradeneeded: null };
      Promise.resolve().then(() => {
        const isNew = !databases.has(name);
        if (isNew) {
          databases.set(name, new Map());
        }
        const stores = databases.get(name);
        const db = {
          objectStoreNames: { contains: (storeName) => stores.has(storeName) },
          createObjectStore: (storeName) => {
            stores.set(storeName, new Map());
            return {};
          },
          transaction: (storeName) => {
            const store = stores.get(storeName);
            const tx = { oncomplete: null, onerror: null };
            const objectStore = {
              put: (value, key) => {
                const req = createRequest();
                Promise.resolve().then(() => {
                  store.set(key, value);
                  if (req.onsuccess) req.onsuccess();
                  if (tx.oncomplete) tx.oncomplete();
                });
                return req;
              },
              get: (key) => {
                const req = createRequest();
                Promise.resolve().then(() => {
                  req.result = store.get(key);
                  if (req.onsuccess) req.onsuccess();
                });
                return req;
              },
              delete: (key) => {
                const req = createRequest();
                Promise.resolve().then(() => {
                  store.delete(key);
                  if (req.onsuccess) req.onsuccess();
                  if (tx.oncomplete) tx.oncomplete();
                });
                return req;
              },
            };
            tx.objectStore = () => objectStore;
            return tx;
          },
        };
        if (isNew && request.onupgradeneeded) {
          request.onupgradeneeded({ target: { result: db } });
        }
        request.result = db;
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    }),
  };

  return { indexedDB, databases };
}

module.exports = { createIndexedDbStub };
