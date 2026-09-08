// test-utils/chromeStub.js
// jestテストで使用するchrome拡張APIの最小スタブ。
// background.js/popup.jsが呼び出すAPIのみをモックする。

const path = require("path");
const messagesJa = require(path.join("..", "_locales", "ja", "messages.json"));

/**
 * chrome.i18n.getMessage()の最小スタブを作る。
 * _locales/ja/messages.jsonを唯一のソースとして参照し(テスト環境の
 * 既定ロケールをjaとみなす)、$NAME$形式のプレースホルダーを
 * substitutionsで置換する。
 * @param {string} messageName メッセージキー
 * @param {string|string[]} [substitutions] プレースホルダーへ渡す値
 * @returns {string} 解決したメッセージ。キーが存在しなければ空文字
 */
function getMessageStub(messageName, substitutions) {
  const entry = messagesJa[messageName];
  if (!entry) {
    return "";
  }
  let text = entry.message;
  if (substitutions !== undefined) {
    const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
    if (entry.placeholders) {
      for (const [name, def] of Object.entries(entry.placeholders)) {
        const index = Number(String(def.content).replace("$", "")) - 1;
        const value = subs[index] !== undefined ? String(subs[index]) : "";
        text = text.replace(new RegExp(`\\$${name}\\$`, "gi"), value);
      }
    } else {
      subs.forEach((value, index) => {
        text = text.replace(new RegExp(`\\$${index + 1}`, "g"), String(value));
      });
    }
  }
  return text;
}

/**
 * chrome.runtime.connect()が返すPortのスタブを作る。page-relayが使う。
 * @returns {object} port風オブジェクト（onMessage/onDisconnect/postMessage/disconnect）
 */
function createPortStub() {
  const port = {
    onMessage: { addListener: jest.fn((cb) => { port._onMessage = cb; }) },
    onDisconnect: { addListener: jest.fn((cb) => { port._onDisconnect = cb; }) },
    postMessage: jest.fn(),
    disconnect: jest.fn(),
  };
  return port;
}

/**
 * chrome拡張APIの最小スタブを作る。
 * @returns {{chrome: object, storage: object, sessionStorage: object, contexts: object[],
 *   tabs: object[], downloadItems: object[], fireDownloadsChanged: (delta: object) => Promise<void>}}
 *   グローバルに設定するchromeオブジェクトと、背後の状態を直接検査・操作するための素のオブジェクト
 */
function createChromeStub() {
  const storage = {};
  const sessionStorage = {};
  // chrome.runtime.getContextsが返すコンテキスト一覧。テストから直接書き換える。
  const contexts = [];
  // 既定のタブ一覧。background.jsのタブ取得(Q4)テストから直接書き換える。
  const tabs = [{ id: 1, active: true, url: "https://www.youtube.com/watch?v=abc" }];
  // chrome.downloads.searchが返すダウンロード項目。テストから直接書き換える。
  const downloadItems = [];
  // chrome.downloads.onChangedへ登録されたリスナー。
  const downloadsChangedListeners = [];

  const chrome = {
    runtime: {
      onMessage: { addListener: jest.fn() },
      // page-relay(T8)が使うchrome.runtime.connect。
      connect: jest.fn(() => createPortStub()),
      sendMessage: jest.fn(() => Promise.resolve()),
      getContexts: jest.fn(() => Promise.resolve(contexts.slice())),
      lastError: undefined,
    },
    offscreen: {
      createDocument: jest.fn(() => Promise.resolve()),
      closeDocument: jest.fn(() => Promise.resolve()),
    },
    scripting: {
      // filesによる注入は戻り値を持たず、funcによる実行はundefinedを返す既定挙動。
      // page-agentのrun()結果を差し込むテストはmockResolvedValueOnceで上書きする。
      executeScript: jest.fn(() => Promise.resolve([{ frameId: 0, result: undefined }])),
    },
    storage: {
      local: {
        get: jest.fn((key) => Promise.resolve({ [key]: storage[key] })),
        set: jest.fn((obj) => {
          Object.assign(storage, obj);
          return Promise.resolve();
        }),
      },
      session: {
        get: jest.fn((key) => Promise.resolve({ [key]: sessionStorage[key] })),
        set: jest.fn((obj) => {
          Object.assign(sessionStorage, obj);
          return Promise.resolve();
        }),
      },
    },
    notifications: {
      create: jest.fn(),
    },
    downloads: {
      // rejectさせたいテストはmockRejectedValueOnce()で上書きする。
      download: jest.fn(() => Promise.resolve(1)),
      search: jest.fn((query) => Promise.resolve(downloadItems.filter((item) => matchesDownloadQuery(item, query)))),
      onChanged: {
        addListener: jest.fn((callback) => {
          downloadsChangedListeners.push(callback);
        }),
      },
    },
    i18n: {
      getMessage: jest.fn(getMessageStub),
    },
    tabs: {
      query: jest.fn((queryInfo) => Promise.resolve(filterTabs(tabs, queryInfo))),
    },
  };

  /**
   * chrome.downloads.onChangedの発火を模す。
   * @param {object} delta onChangedのdelta
   * @returns {Promise<void>} 全リスナーの処理完了を表すPromise
   */
  async function fireDownloadsChanged(delta) {
    for (const listener of downloadsChangedListeners) {
      await listener(delta);
    }
  }

  return { chrome, storage, sessionStorage, contexts, tabs, downloadItems, fireDownloadsChanged };
}

/**
 * chrome.downloads.searchの最小フィルタ。background.jsが使うid/filenameRegex/exists/state
 * のみ扱う(finding 14: Downloadsフォルダ同名衝突チェック用)。
 * @param {object} item ダウンロード項目(id, state, error, filename, existsを持つ)
 * @param {object} query 検索条件
 * @returns {boolean} 条件に一致すればtrue
 */
function matchesDownloadQuery(item, query) {
  const condition = query ?? {};
  if (condition.id !== undefined && item.id !== condition.id) {
    return false;
  }
  if (condition.state !== undefined && item.state !== condition.state) {
    return false;
  }
  if (condition.exists !== undefined && item.exists !== condition.exists) {
    return false;
  }
  if (condition.filenameRegex !== undefined) {
    if (typeof item.filename !== "string" || !new RegExp(condition.filenameRegex).test(item.filename)) {
      return false;
    }
  }
  return true;
}

/**
 * chrome.tabs.queryの最小フィルタ。background.jsが使うactive/currentWindow/urlのみ扱う。
 * urlは`https://www.youtube.com/*`形式の末尾ワイルドカードのみ解釈する。
 * @param {object[]} tabs タブ一覧
 * @param {object} queryInfo クエリ条件
 * @returns {object[]} 条件に一致したタブ
 */
function filterTabs(tabs, queryInfo) {
  const condition = queryInfo ?? {};
  return tabs.filter((tab) => {
    if (condition.active === true && tab.active !== true) {
      return false;
    }
    if (typeof condition.url === "string") {
      const prefix = condition.url.replace(/\*$/, "");
      if (typeof tab.url !== "string" || !tab.url.startsWith(prefix)) {
        return false;
      }
    }
    return true;
  });
}

module.exports = { createChromeStub, createPortStub };
