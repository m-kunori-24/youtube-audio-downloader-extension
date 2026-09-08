// popup.test.js
// D9.3の単体テスト観点(21〜24, 31)を検証する。

const { createChromeStub } = require("./test-utils/chromeStub");
const { createIndexedDbStub } = require("./test-utils/indexedDbStub");

/**
 * popup.htmlのDOM構造(D4)を再現したフィクスチャをdocument.bodyへ設定する。
 * @returns {void}
 */
function setupDom() {
  document.body.innerHTML = `
    <div id="url-row">
      <input id="url-input" type="text" data-i18n-title="titleUrlInput" />
    </div>
    <div id="format-row">
      <select id="format-select" data-i18n-title="titleFormatSelect">
        <option value="mp3" selected>mp3</option>
        <option value="aac">aac</option>
        <option value="m4a">m4a</option>
        <option value="opus">opus</option>
        <option value="vorbis">vorbis</option>
        <option value="wav">wav</option>
        <option value="flac">flac</option>
      </select>
    </div>
    <div id="quality-row">
      <label for="quality-select" data-i18n="labelQuality">Audio Quality</label>
      <select id="quality-select" data-i18n-title="titleQualitySelect">
        <option value="standard" selected data-i18n="qualityStandard">standard</option>
        <option value="high" data-i18n="qualityHigh">high</option>
        <option value="best" data-i18n="qualityBest">best</option>
      </select>
    </div>
    <div id="output-dir-row">
      <input id="output-dir-display" type="text" readonly data-i18n-title="titleOutputDir" />
      <button id="browse-button" type="button" data-i18n-title="titleBrowseButton"></button>
      <button id="clear-output-dir-button" type="button" data-i18n-title="titleClearOutputDirButton"></button>
      <p id="picker-unsupported-notice" data-i18n="noticeDirectoryPickerUnsupported" hidden></p>
    </div>
    <button id="start-button" data-i18n-title="titleStartButton"></button>
    <section id="progress-area">
      <p id="state-text"></p>
      <progress id="progress-bar" value="0" max="100"></progress>
      <p id="detail-text"></p>
    </section>
    <section id="result-area">
      <p id="result-text"></p>
    </section>
  `;
}

/**
 * popup.jsをテスト用にフレッシュな状態でロードする。
 * indexedDBは新規のインメモリスタブに、window.showDirectoryPickerは
 * 未設定時にAbortErrorを投げるjest.fn()に、それぞれ差し替える
 * (個別テストで上書き可能)。
 * @returns {{popup: object, chrome: object, indexedDbDatabases: Map}} ロード結果
 */
function loadPopupModule() {
  jest.resetModules();
  setupDom();
  const { chrome } = createChromeStub();
  global.chrome = chrome;
  let uuidCounter = 0;
  global.crypto.randomUUID = () => `uuid-${(uuidCounter += 1)}`;
  const { indexedDB, databases } = createIndexedDbStub();
  global.indexedDB = indexedDB;
  global.window.showDirectoryPicker = jest.fn(() => {
    const error = new Error("The user aborted a request.");
    error.name = "AbortError";
    return Promise.reject(error);
  });
  const popup = require("./popup.js");
  return { popup, chrome, indexedDbDatabases: databases };
}

/**
 * テスト用のFileSystemDirectoryHandleモックを作る。
 * @param {string} name ハンドルのフォルダ名
 * @param {{queryPermission?: string, requestPermission?: string}} [permissions]
 *   queryPermission/requestPermissionの戻り値("granted"/"prompt"/"denied")
 * @returns {object} FileSystemDirectoryHandle風オブジェクト
 */
function createDirectoryHandleStub(name, permissions = {}) {
  return {
    name,
    kind: "directory",
    queryPermission: jest.fn(() => Promise.resolve(permissions.queryPermission ?? "granted")),
    requestPermission: jest.fn(() => Promise.resolve(permissions.requestPermission ?? "granted")),
  };
}

test("21: applyTaskのsequence/taskIdガード(D5の判定順序1-4)", () => {
  const { popup } = loadPopupModule();

  // 1. task === null -> 待機中
  popup.applyTask(null);
  expect(popup.__getStateForTest().currentTaskId).toBeNull();

  // 4. currentTaskId===nullでのスナップショット復元 -> 採用
  popup.applyTask({
    taskId: "A",
    sequence: 2,
    state: "downloading",
    phase: "download",
    percent: 10,
    timestamp: "t",
  });
  expect(popup.__getStateForTest().currentTaskId).toBe("A");
  expect(popup.__getStateForTest().lastSequence).toBe(2);

  // 2. taskId不一致は無視
  popup.applyTask({
    taskId: "B",
    sequence: 5,
    state: "downloading",
    phase: "download",
    percent: 50,
    timestamp: "t",
  });
  expect(popup.__getStateForTest().currentTaskId).toBe("A");
  expect(popup.__getStateForTest().lastSequence).toBe(2);

  // 3. 同一taskIdでsequence<=lastSequenceは無視
  popup.applyTask({
    taskId: "A",
    sequence: 2,
    state: "downloading",
    phase: "download",
    percent: 99,
    timestamp: "t",
  });
  expect(popup.__getStateForTest().lastSequence).toBe(2);

  // 新しいsequenceは採用
  popup.applyTask({
    taskId: "A",
    sequence: 3,
    state: "downloading",
    phase: "download",
    percent: 60,
    timestamp: "t",
  });
  expect(popup.__getStateForTest().lastSequence).toBe(3);
});

test("22: convertingかつpercent:nullで<progress>のvalue属性が除去され不定表示になる", () => {
  const { popup } = loadPopupModule();
  const bar = document.getElementById("progress-bar");
  bar.value = 50;

  popup.applyTask({
    taskId: "A",
    sequence: 1,
    state: "converting",
    phase: "convert",
    percent: null,
    timestamp: "t",
  });

  expect(bar.hasAttribute("value")).toBe(false);
});

test("23: completed/errorでコントロールが再度有効化され、downloading中は無効のまま", () => {
  const { popup } = loadPopupModule();
  const startButton = document.getElementById("start-button");

  popup.applyTask({
    taskId: "A",
    sequence: 1,
    state: "downloading",
    phase: "download",
    percent: 10,
    timestamp: "t",
  });
  expect(startButton.disabled).toBe(true);

  popup.applyTask({
    taskId: "A",
    sequence: 2,
    state: "completed",
    phase: "done",
    percent: 100,
    fileName: "C:\\a.mp3",
    timestamp: "t",
  });
  expect(startButton.disabled).toBe(false);

  popup.applyTask(null);
  popup.applyTask({
    taskId: "B",
    sequence: 1,
    state: "downloading",
    phase: "download",
    percent: 10,
    timestamp: "t",
  });
  expect(startButton.disabled).toBe(true);

  popup.applyTask({
    taskId: "B",
    sequence: 2,
    state: "error",
    code: "CONVERT_FAILED",
    message: "boom",
    timestamp: "t",
  });
  expect(startButton.disabled).toBe(false);
});

test("24: スナップショット応答より先にdownload.progressが届いても最終的に新しいsequenceが表示される", async () => {
  const { popup, chrome } = loadPopupModule();
  let resolveSnapshot;
  chrome.runtime.sendMessage.mockImplementation((message) => {
    if (message.type === "progress.snapshot.get") {
      return new Promise((resolve) => {
        resolveSnapshot = resolve;
      });
    }
    return Promise.resolve();
  });

  const requestPromise = popup.requestSnapshot();

  const onMessageListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  onMessageListener({
    type: "download.progress",
    taskId: "A",
    sequence: 4,
    state: "downloading",
    phase: "download",
    percent: 40,
    timestamp: "t",
  });
  expect(popup.__getStateForTest().lastSequence).toBe(4);

  resolveSnapshot({
    type: "progress.snapshot",
    requestId: "s",
    task: {
      taskId: "A",
      sequence: 2,
      state: "downloading",
      phase: "download",
      percent: 20,
      timestamp: "t",
    },
  });
  await requestPromise;

  expect(popup.__getStateForTest().lastSequence).toBe(4);
  expect(document.getElementById("state-text").textContent).toBe("ダウンロード中");
});

test("31: onStartClickedはdownload.acceptedと拒否応答それぞれで状態遷移する", async () => {
  const { popup, chrome } = loadPopupModule();
  document.getElementById("url-input").value = "https://www.youtube.com/watch?v=abc";
  chrome.runtime.sendMessage.mockResolvedValueOnce({
    type: "download.accepted",
    requestId: "r1",
    taskId: "task-1",
    sequence: 0,
    state: "starting",
    phase: "download",
    percent: null,
    format: "mp3",
    url: "https://www.youtube.com/watch?v=abc",
    timestamp: "t",
  });

  await popup.onStartClicked();

  expect(popup.__getStateForTest().currentTaskId).toBe("task-1");
  expect(popup.__getStateForTest().lastSequence).toBe(0);
  expect(popup.__getStateForTest().isRunning).toBe(true);
  expect(document.getElementById("start-button").disabled).toBe(true);

  const { popup: popup2, chrome: chrome2 } = loadPopupModule();
  document.getElementById("start-button").disabled = true;
  chrome2.runtime.sendMessage.mockResolvedValueOnce({
    type: "download.result",
    requestId: "r2",
    taskId: null,
    sequence: null,
    state: "error",
    code: "TASK_ALREADY_RUNNING",
    message: "別のダウンロードが実行中です。",
    timestamp: "t",
  });

  await popup2.onStartClicked();

  expect(popup2.__getStateForTest().currentTaskId).toBeNull();
  expect(document.getElementById("result-text").textContent).toBe(
    "[TASK_ALREADY_RUNNING] 別のダウンロードが実行中です。",
  );
  expect(document.getElementById("start-button").disabled).toBe(false);
});

test("36: renderProgressのconverting分岐はdownloadingと同様にvalue属性を切り替える(第2ラウンド①)", () => {
  const { popup } = loadPopupModule();
  const bar = document.getElementById("progress-bar");

  popup.applyTask({
    taskId: "A",
    sequence: 1,
    state: "converting",
    phase: "convert",
    percent: 42.3,
    convertedSeconds: 12,
    totalSeconds: 30,
    timestamp: "t",
  });

  expect(bar.value).toBe(42.3);
  expect(document.getElementById("detail-text").textContent).toBe("42.3% ・ 0:12 / 0:30");

  popup.applyTask({
    taskId: "A",
    sequence: 2,
    state: "converting",
    phase: "convert",
    percent: null,
    convertedSeconds: null,
    totalSeconds: null,
    timestamp: "t2",
  });

  expect(bar.hasAttribute("value")).toBe(false);
});

test("44: onBrowseClickedはshowDirectoryPickerで選択したハンドルをIndexedDBへ保存し、保存先欄へhandle.nameを反映する", async () => {
  const { popup } = loadPopupModule();
  const handle = createDirectoryHandleStub("music");
  window.showDirectoryPicker.mockResolvedValueOnce(handle);

  await popup.onBrowseClicked();

  expect(document.getElementById("output-dir-display").value).toBe("music");
  expect(popup.__getStateForTest().directoryHandle).toBe(handle);

  const stored = await popup.loadDirectoryHandle();
  expect(stored).toBe(handle);
});

test("45: onBrowseClickedはキャンセル(AbortError)時に保存先欄・directoryHandleを変更しない", async () => {
  const { popup } = loadPopupModule();
  document.getElementById("output-dir-display").value = "D:/existing";
  // loadPopupModule()の既定モックがAbortErrorをrejectする。

  await popup.onBrowseClicked();

  expect(document.getElementById("output-dir-display").value).toBe("D:/existing");
  expect(popup.__getStateForTest().directoryHandle).toBeNull();
});

test("46: onStartClickedはdownload.startにoutputDirフィールドを含めない", async () => {
  const { popup, chrome } = loadPopupModule();
  document.getElementById("url-input").value = "https://www.youtube.com/watch?v=abc";
  const handle = createDirectoryHandleStub("music");
  window.showDirectoryPicker.mockResolvedValueOnce(handle);
  await popup.onBrowseClicked();

  chrome.runtime.sendMessage.mockResolvedValueOnce({
    type: "download.accepted",
    requestId: "r1",
    taskId: "task-1",
    sequence: 0,
    state: "starting",
    phase: "download",
    percent: null,
    format: "mp3",
    url: "https://www.youtube.com/watch?v=abc",
    timestamp: "t",
  });
  await popup.onStartClicked();

  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.not.objectContaining({ outputDir: expect.anything() }),
  );
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "download.start" }),
  );
});

test("57: onStartClickedは既定でaudioQuality:standardをdownload.startへ含めて送信する", async () => {
  const { popup, chrome } = loadPopupModule();
  document.getElementById("url-input").value = "https://www.youtube.com/watch?v=abc";
  chrome.runtime.sendMessage.mockResolvedValueOnce({
    type: "download.accepted",
    requestId: "r1",
    taskId: "task-1",
    sequence: 0,
    state: "starting",
    phase: "download",
    percent: null,
    format: "mp3",
    url: "https://www.youtube.com/watch?v=abc",
    timestamp: "t",
  });

  await popup.onStartClicked();

  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "download.start", audioQuality: "standard" }),
  );
});

test("58: onQualityChangedは選択値をaudioQuality変数へ反映し、以降のdownload.startへ含まれる", async () => {
  const { popup, chrome } = loadPopupModule();
  document.getElementById("url-input").value = "https://www.youtube.com/watch?v=abc";
  document.getElementById("quality-select").value = "best";

  popup.onQualityChanged();

  expect(popup.__getStateForTest().audioQuality).toBe("best");

  chrome.runtime.sendMessage.mockResolvedValueOnce({
    type: "download.accepted",
    requestId: "r1",
    taskId: "task-1",
    sequence: 0,
    state: "starting",
    phase: "download",
    percent: null,
    format: "mp3",
    url: "https://www.youtube.com/watch?v=abc",
    timestamp: "t",
  });

  await popup.onStartClicked();

  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "download.start", audioQuality: "best" }),
  );
});

test("47: onBrowseClickedはピッカーがAbortError以外を投げた場合#result-textにSAVE_FAILEDを表示し、directoryHandleを変更しない", async () => {
  const { popup, chrome } = loadPopupModule();
  window.showDirectoryPicker.mockRejectedValueOnce(new Error("disk error"));

  await popup.onBrowseClicked();

  expect(document.getElementById("result-text").textContent).toBe(
    `[SAVE_FAILED] ${chrome.i18n.getMessage("error_SAVE_FAILED")}`,
  );
  expect(popup.__getStateForTest().directoryHandle).toBeNull();
});

test("48: onClearOutputDirClickedはIndexedDBの保存先を削除し、directoryHandle・保存先欄をリセットする", async () => {
  const { popup } = loadPopupModule();
  const handle = createDirectoryHandleStub("music");
  window.showDirectoryPicker.mockResolvedValueOnce(handle);
  await popup.onBrowseClicked();
  expect(document.getElementById("output-dir-display").value).toBe("music");

  await popup.onClearOutputDirClicked();

  expect(document.getElementById("output-dir-display").value).toBe("");
  expect(popup.__getStateForTest().directoryHandle).toBeNull();
  expect(await popup.loadDirectoryHandle()).toBeNull();
});

test("49: onBrowseClickedは多重クリックを無視し、isBrowsePending中はshowDirectoryPickerを1回しか呼ばない", async () => {
  const { popup } = loadPopupModule();
  let resolvePicker;
  window.showDirectoryPicker.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
  );

  const firstCall = popup.onBrowseClicked();
  expect(popup.__getStateForTest().isBrowsePending).toBe(true);
  expect(document.getElementById("browse-button").disabled).toBe(true);

  const secondCall = popup.onBrowseClicked();
  expect(window.showDirectoryPicker).toHaveBeenCalledTimes(1);

  resolvePicker(createDirectoryHandleStub("music"));
  await Promise.all([firstCall, secondCall]);

  expect(popup.__getStateForTest().isBrowsePending).toBe(false);
  expect(document.getElementById("browse-button").disabled).toBe(false);
});

test("50: onStartClickedはisBrowsePending中は即returnし、download.startを送信しない", async () => {
  const { popup, chrome } = loadPopupModule();
  let resolvePicker;
  window.showDirectoryPicker.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
  );

  const browsePromise = popup.onBrowseClicked();
  expect(popup.__getStateForTest().isBrowsePending).toBe(true);

  await popup.onStartClicked();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "download.start" }),
  );

  resolvePicker(createDirectoryHandleStub("music"));
  await browsePromise;
});

test("51: onStartClickedはdirectoryHandleのqueryPermissionがgrantedならrequestPermissionを呼ばずdownload.startを送信する", async () => {
  const { popup, chrome } = loadPopupModule();
  document.getElementById("url-input").value = "https://www.youtube.com/watch?v=abc";
  const handle = createDirectoryHandleStub("music", { queryPermission: "granted" });
  popup.__setDirectoryHandleForTest(handle);
  chrome.runtime.sendMessage.mockResolvedValueOnce({
    type: "download.accepted",
    requestId: "r1",
    taskId: "task-1",
    sequence: 0,
    state: "starting",
    timestamp: "t",
  });

  await popup.onStartClicked();

  expect(handle.queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  expect(handle.requestPermission).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "download.start" }),
  );
});

test("52: onStartClickedはqueryPermissionが'prompt'ならクリックハンドラ内でrequestPermissionを呼び、許可されればdownload.startを送信する", async () => {
  const { popup, chrome } = loadPopupModule();
  document.getElementById("url-input").value = "https://www.youtube.com/watch?v=abc";
  const handle = createDirectoryHandleStub("music", {
    queryPermission: "prompt",
    requestPermission: "granted",
  });
  popup.__setDirectoryHandleForTest(handle);
  chrome.runtime.sendMessage.mockResolvedValueOnce({
    type: "download.accepted",
    requestId: "r1",
    taskId: "task-1",
    sequence: 0,
    state: "starting",
    timestamp: "t",
  });

  await popup.onStartClicked();

  expect(handle.requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "download.start" }),
  );
});

test("53: onStartClickedはrequestPermissionが拒否された場合SAVE_PERMISSION_DENIEDを表示しdownload.startを送信しない", async () => {
  const { popup, chrome } = loadPopupModule();
  document.getElementById("url-input").value = "https://www.youtube.com/watch?v=abc";
  const handle = createDirectoryHandleStub("music", {
    queryPermission: "prompt",
    requestPermission: "denied",
  });
  popup.__setDirectoryHandleForTest(handle);

  await popup.onStartClicked();

  expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "download.start" }),
  );
  expect(document.getElementById("result-text").textContent).toBe(
    `[SAVE_PERMISSION_DENIED] ${chrome.i18n.getMessage("error_SAVE_PERMISSION_DENIED")}`,
  );
});

test("54: onStartClickedはqueryPermissionが'denied'ならrequestPermissionを呼ばずSAVE_PERMISSION_DENIEDで拒否する", async () => {
  const { popup, chrome } = loadPopupModule();
  document.getElementById("url-input").value = "https://www.youtube.com/watch?v=abc";
  const handle = createDirectoryHandleStub("music", { queryPermission: "denied" });
  popup.__setDirectoryHandleForTest(handle);

  await popup.onStartClicked();

  expect(handle.requestPermission).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "download.start" }),
  );
  expect(document.getElementById("result-text").textContent).toBe(
    `[SAVE_PERMISSION_DENIED] ${chrome.i18n.getMessage("error_SAVE_PERMISSION_DENIED")}`,
  );
});

test("55: initializeはIndexedDBに保存済みのディレクトリハンドルを読み込み、保存先欄へhandle.nameを反映する", async () => {
  const { popup, chrome } = loadPopupModule();
  chrome.runtime.sendMessage.mockImplementation((message) => {
    if (message.type === "progress.snapshot.get") {
      return Promise.resolve({ type: "progress.snapshot", requestId: message.requestId, task: null });
    }
    return Promise.resolve();
  });
  const handle = createDirectoryHandleStub("music");
  await popup.saveDirectoryHandle(handle);

  await popup.initialize();

  expect(document.getElementById("output-dir-display").value).toBe("music");
  expect(popup.__getStateForTest().directoryHandle).toEqual(handle);
});

test("56: initializeはIndexedDBに保存済みハンドルが無ければ保存先欄を変更しない(placeholderのまま)", async () => {
  const { popup, chrome } = loadPopupModule();
  chrome.runtime.sendMessage.mockImplementation((message) => {
    if (message.type === "progress.snapshot.get") {
      return Promise.resolve({ type: "progress.snapshot", requestId: message.requestId, task: null });
    }
    return Promise.resolve();
  });

  await popup.initialize();

  expect(document.getElementById("output-dir-display").value).toBe("");
  expect(popup.__getStateForTest().directoryHandle).toBeNull();
});

test("59: format変更でwav/flac選択時は音質欄が無効化されstandardへリセットされ、ロッシー形式へ戻すと再度有効化される", () => {
  loadPopupModule();
  const formatSelect = document.getElementById("format-select");
  const qualitySelect = document.getElementById("quality-select");

  qualitySelect.value = "best";
  qualitySelect.dispatchEvent(new Event("change"));
  expect(qualitySelect.disabled).toBe(false);

  formatSelect.value = "wav";
  formatSelect.dispatchEvent(new Event("change"));
  expect(qualitySelect.disabled).toBe(true);
  expect(qualitySelect.value).toBe("standard");

  formatSelect.value = "flac";
  formatSelect.dispatchEvent(new Event("change"));
  expect(qualitySelect.disabled).toBe(true);
  expect(qualitySelect.value).toBe("standard");

  formatSelect.value = "mp3";
  formatSelect.dispatchEvent(new Event("change"));
  expect(qualitySelect.disabled).toBe(false);
});

test("60: applyI18nは音質選択欄(label/option)のdata-i18n属性をmessages.jsonの訳文で置換する", () => {
  const { popup, chrome } = loadPopupModule();

  popup.applyI18n();

  const label = document.querySelector('label[for="quality-select"]');
  const standardOption = document.querySelector('option[value="standard"]');
  const highOption = document.querySelector('option[value="high"]');
  const bestOption = document.querySelector('option[value="best"]');

  expect(label.textContent).toBe(chrome.i18n.getMessage("labelQuality"));
  expect(standardOption.textContent).toBe(chrome.i18n.getMessage("qualityStandard"));
  expect(highOption.textContent).toBe(chrome.i18n.getMessage("qualityHigh"));
  expect(bestOption.textContent).toBe(chrome.i18n.getMessage("qualityBest"));
});

test("61: applyI18nは主要コントロールのdata-i18n-title属性をmessages.jsonの訳文でtitle属性へ反映する", () => {
  const { popup, chrome } = loadPopupModule();

  popup.applyI18n();

  const urlInput = document.getElementById("url-input");
  const formatSelect = document.getElementById("format-select");
  const qualitySelect = document.getElementById("quality-select");
  const browseButton = document.getElementById("browse-button");
  const outputDirDisplay = document.getElementById("output-dir-display");
  const startButton = document.getElementById("start-button");

  expect(urlInput.title).toBe(chrome.i18n.getMessage("titleUrlInput"));
  expect(formatSelect.title).toBe(chrome.i18n.getMessage("titleFormatSelect"));
  expect(qualitySelect.title).toBe(chrome.i18n.getMessage("titleQualitySelect"));
  expect(browseButton.title).toBe(chrome.i18n.getMessage("titleBrowseButton"));
  expect(outputDirDisplay.title).toBe(chrome.i18n.getMessage("titleOutputDir"));
  expect(startButton.title).toBe(chrome.i18n.getMessage("titleStartButton"));
});

test("62: applyTask(null)後は#progress-areaと#result-areaが両方hiddenになる", () => {
  const { popup } = loadPopupModule();

  popup.applyTask(null);

  expect(document.getElementById("progress-area").hidden).toBe(true);
  expect(document.getElementById("result-area").hidden).toBe(true);
});

test("63: starting/downloading状態のタスクでは#progress-areaが表示され#result-areaはhiddenのまま", () => {
  const { popup } = loadPopupModule();

  popup.applyTask({ taskId: "t1", sequence: 1, state: "starting" });
  expect(document.getElementById("progress-area").hidden).toBe(false);
  expect(document.getElementById("result-area").hidden).toBe(true);

  popup.applyTask({ taskId: "t1", sequence: 2, state: "downloading", percent: 10 });
  expect(document.getElementById("progress-area").hidden).toBe(false);
  expect(document.getElementById("result-area").hidden).toBe(true);
});

test("64: completed状態のタスクでは#progress-areaがhiddenになり#result-areaが表示される", () => {
  const { popup } = loadPopupModule();

  popup.applyTask({ taskId: "t1", sequence: 1, state: "starting" });
  popup.applyTask({
    taskId: "t1",
    sequence: 2,
    state: "completed",
    fileName: "C:\\out\\file.mp3",
  });

  expect(document.getElementById("progress-area").hidden).toBe(true);
  expect(document.getElementById("result-area").hidden).toBe(false);
});

test("65: requestSnapshotはstate:completedのtaskを復元せず#progress-area/#result-areaとも非表示のままにする", async () => {
  const { popup, chrome } = loadPopupModule();
  chrome.runtime.sendMessage.mockResolvedValueOnce({
    type: "progress.snapshot",
    requestId: "s1",
    task: {
      taskId: "t1",
      sequence: 2,
      state: "completed",
      fileName: "C:\\out\\file.mp3",
    },
  });

  await popup.requestSnapshot();

  expect(document.getElementById("progress-area").hidden).toBe(true);
  expect(document.getElementById("result-area").hidden).toBe(true);
  expect(document.getElementById("result-text").textContent).toBe("");
});

test("66: requestSnapshotはstate:errorのtaskを復元せず#progress-area/#result-areaとも非表示のままにする", async () => {
  const { popup, chrome } = loadPopupModule();
  chrome.runtime.sendMessage.mockResolvedValueOnce({
    type: "progress.snapshot",
    requestId: "s1",
    task: {
      taskId: "t1",
      sequence: 2,
      state: "error",
      code: "E_SOME",
      message: "failed",
    },
  });

  await popup.requestSnapshot();

  expect(document.getElementById("progress-area").hidden).toBe(true);
  expect(document.getElementById("result-area").hidden).toBe(true);
  expect(document.getElementById("result-text").textContent).toBe("");
});

test("67: requestSnapshotはstate:downloadingのtaskはこれまで通り#progress-areaへ復元する(回帰防止)", async () => {
  const { popup, chrome } = loadPopupModule();
  chrome.runtime.sendMessage.mockResolvedValueOnce({
    type: "progress.snapshot",
    requestId: "s1",
    task: {
      taskId: "t1",
      sequence: 1,
      state: "downloading",
      percent: 42,
    },
  });

  await popup.requestSnapshot();

  expect(document.getElementById("progress-area").hidden).toBe(false);
  expect(document.getElementById("result-area").hidden).toBe(true);
});

test("68: onRuntimeMessage経由でdownload.result(completed)を受信した場合はrequestSnapshotと異なりその場で結果を表示する", () => {
  const { popup } = loadPopupModule();

  popup.applyTask({ taskId: "t1", sequence: 1, state: "starting" });
  popup.onRuntimeMessage({
    type: "download.result",
    taskId: "t1",
    sequence: 2,
    state: "completed",
    fileName: "C:\\out\\file.mp3",
  });

  expect(document.getElementById("progress-area").hidden).toBe(true);
  expect(document.getElementById("result-area").hidden).toBe(false);
  expect(document.getElementById("result-text").textContent).toBe("C:\\out\\file.mp3");
});

test("69: window.showDirectoryPickerが未定義のブラウザ(Brave既定等)ではinitializeが参照/クリアボタンを無効化し中立な注意書きを表示する", async () => {
  const { popup, chrome } = loadPopupModule();
  chrome.runtime.sendMessage.mockImplementation((message) => {
    if (message.type === "progress.snapshot.get") {
      return Promise.resolve({ type: "progress.snapshot", requestId: message.requestId, task: null });
    }
    return Promise.resolve();
  });
  delete window.showDirectoryPicker;

  await popup.initialize();

  expect(popup.__getStateForTest().directoryPickerSupported).toBe(false);
  expect(document.getElementById("browse-button").disabled).toBe(true);
  expect(document.getElementById("clear-output-dir-button").disabled).toBe(true);
  expect(document.getElementById("browse-button").title).toBe(
    chrome.i18n.getMessage("titleBrowseButtonUnsupported"),
  );
  const notice = document.getElementById("picker-unsupported-notice");
  expect(notice.hidden).toBe(false);
  expect(notice.textContent).toBe(chrome.i18n.getMessage("noticeDirectoryPickerUnsupported"));
});

test("70: window.showDirectoryPickerが利用可能な通常ブラウザではinitializeしても注意書きは表示されず参照/クリアボタンも有効のままになる(回帰防止)", async () => {
  const { popup, chrome } = loadPopupModule();
  chrome.runtime.sendMessage.mockImplementation((message) => {
    if (message.type === "progress.snapshot.get") {
      return Promise.resolve({ type: "progress.snapshot", requestId: message.requestId, task: null });
    }
    return Promise.resolve();
  });

  await popup.initialize();

  expect(popup.__getStateForTest().directoryPickerSupported).toBe(true);
  expect(document.getElementById("browse-button").disabled).toBe(false);
  expect(document.getElementById("clear-output-dir-button").disabled).toBe(false);
  expect(document.getElementById("picker-unsupported-notice").hidden).toBe(true);
});
