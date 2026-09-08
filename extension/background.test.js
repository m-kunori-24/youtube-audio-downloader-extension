// background.test.js
// 拡張機能単体化(案A)後のService Workerの単体テスト。
// 維持した既存ロジック(TaskSnapshot・進捗の後退防止・claimTask/finishTaskの同期区間)と、
// T9で追加したロジック(タブ取得・注入順序・Offscreen確保・playerJs永続化・
// エラー分類・状態遷移・SW再起動復帰)を検証する。

const { createChromeStub } = require("./test-utils/chromeStub");

const VALID_URL = "https://www.youtube.com/watch?v=abc123";

// page-agentの成功結果(T8のrun()戻り値の形)。
const AGENT_SUCCESS = {
  ok: true,
  byteLength: 1000,
  mimeType: 'audio/webm; codecs="opus"',
  itag: 251,
  title: "テスト動画",
  lengthSeconds: 100,
  acceptedCandidate: {
    url: "https://www.youtube.com/s/player/aaaa1111/player_es6.vflset/en_US/base.js",
    buildHash: "aaaa1111",
    variant: "player_es6",
  },
  rejectedCandidates: [],
};

let uuidCounter = 0;
let currentBackground = null; // 直近にロードしたbackground.js(mockAgentResultの結果配送用)

/**
 * background.jsをテスト用にフレッシュな状態でロードする。
 * @param {object} initialStorage chrome.storage.localの初期値
 * @param {(stub: object) => void} [configure] require前にスタブを調整する関数
 * @returns {object} ロード結果(background本体とスタブ一式)
 */
function loadBackgroundModule(initialStorage = {}, configure) {
  jest.resetModules();
  uuidCounter = 0;
  const stub = createChromeStub();
  Object.assign(stub.storage, initialStorage);
  if (configure) {
    configure(stub);
  }
  global.chrome = stub.chrome;
  global.crypto.randomUUID = () => `uuid-${(uuidCounter += 1)}`;
  const background = require("./background.js");
  currentBackground = background;
  return { background, ...stub };
}

/**
 * マイクロタスク/マクロタスクを1周させ、import時のrecoverOnStartup()等を完了させる。
 * @returns {Promise<void>} 完了を表すPromise
 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * chrome.scripting.executeScriptを模し、page-agentの結果をリレー経由のpage.result相当として届ける。
 * MAIN worldのfunc注入(cfg受け渡し)は{ok:true}を返し、MAIN worldのバンドル注入が解決する前に
 * resultをhandleAgentResult()へ渡す(実環境ではリレーのpage.resultがhandleRuntimeMessage経由で
 * 同じ関数へ届く)。resultがPromiseなら解決を待つため、注入パイプラインの完了は結果到着と同期する。
 * @param {object} chrome スタブのchrome
 * @param {object|Promise<object>} result page-agentのresultフレームの中身
 * @returns {void}
 */
function mockAgentResult(chrome, result) {
  const background = currentBackground;
  let taskId = null;
  chrome.scripting.executeScript.mockImplementation((injection) => {
    if (injection.world === "ISOLATED" && typeof injection.func === "function") {
      taskId = injection.args[0].taskId;
    }
    if (injection.world === "MAIN" && typeof injection.func === "function") {
      return Promise.resolve([{ frameId: 0, result: { ok: true } }]);
    }
    if (injection.world === "MAIN" && Array.isArray(injection.files)) {
      return Promise.resolve(result).then(async (agentResult) => {
        await background.handleAgentResult(taskId, agentResult);
        return [{ frameId: 0, result: undefined }];
      });
    }
    return Promise.resolve([{ frameId: 0, result: undefined }]);
  });
}

/**
 * download.startを投げ、注入パイプラインの完了まで待つ。
 * @param {object} background background.jsのエクスポート
 * @param {object} [overrides] download.startメッセージの上書き
 * @returns {Promise<object>} download.accepted応答
 */
async function startTask(background, overrides = {}) {
  const accepted = await background.handleDownloadStart({
    requestId: "r1",
    url: VALID_URL,
    format: "mp3",
    ...overrides,
  });
  await background.__getStateForTest().activePipeline;
  return accepted;
}

/**
 * 実行中タスクを転送完了→変換成功まで進めて終了させる(次のタスクを開始できる状態へ戻す)。
 * @param {object} background background.jsのエクスポート
 * @param {string} taskId 対象のtaskId
 * @returns {Promise<void>} 完了を表すPromise
 */
async function completeTask(background, taskId) {
  await background.handleTransferComplete({
    type: "audio.transfer.complete",
    taskId,
    epoch: 0,
    byteLength: 1000,
  });
  await background.handleConvertResult({ type: "convert.result", taskId, ok: true });
}

describe("validateStartRequest", () => {
  test("11: allowlist外format→INVALID_FORMAT、format未指定→mp3補完、非YouTube URL→INVALID_URL", () => {
    const { background } = loadBackgroundModule();
    expect(background.validateStartRequest({ url: VALID_URL, format: "wma" })).toEqual({
      ok: false,
      code: "INVALID_FORMAT",
      message: expect.any(String),
    });
    expect(background.validateStartRequest({ url: VALID_URL })).toEqual({
      ok: true,
      url: VALID_URL,
      videoId: "abc123",
      format: "mp3",
      audioQuality: "standard",
    });
    expect(background.validateStartRequest({ url: "https://example.com/", format: "mp3" })).toEqual({
      ok: false,
      code: "INVALID_URL",
      message: expect.any(String),
    });
  });

  test("61: audioQuality未指定→standard補完、既知の3値はそのまま保持される", () => {
    const { background } = loadBackgroundModule();
    expect(background.validateStartRequest({ url: VALID_URL, format: "mp3" }).audioQuality).toBe(
      "standard",
    );
    for (const quality of ["standard", "high", "best"]) {
      expect(
        background.validateStartRequest({ url: VALID_URL, format: "mp3", audioQuality: quality })
          .audioQuality,
      ).toBe(quality);
    }
  });

  test("63: 明示的な不正値のaudioQualityはINVALID_AUDIO_QUALITYで拒否され、注入もstorage.setも行われない", async () => {
    const { background, chrome } = loadBackgroundModule();
    const result = await background.handleDownloadStart({
      requestId: "r1",
      url: VALID_URL,
      format: "mp3",
      audioQuality: "ultra",
    });

    expect(result).toEqual({
      type: "download.result",
      requestId: "r1",
      taskId: null,
      sequence: null,
      state: "error",
      code: "INVALID_AUDIO_QUALITY",
      category: "internal",
      message: expect.any(String),
      timestamp: expect.any(String),
    });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

test("64: extractVideoIdはwatch形式とyoutu.be形式の両方から動画IDを取り出す", () => {
  const { background } = loadBackgroundModule();
  expect(background.extractVideoId("https://www.youtube.com/watch?v=abc123&t=10")).toBe("abc123");
  expect(background.extractVideoId("https://youtu.be/xyz789?si=1")).toBe("xyz789");
  expect(background.extractVideoId("https://example.com/")).toBeNull();
});

test("12: TASK_ALREADY_RUNNINGは注入もstorage.setも行わず応答codeが一致する", async () => {
  const { background, chrome } = loadBackgroundModule();
  mockAgentResult(chrome, AGENT_SUCCESS);
  const first = await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "mp3" });
  expect(first.type).toBe("download.accepted");

  chrome.scripting.executeScript.mockClear();
  chrome.storage.local.set.mockClear();

  const second = await background.handleDownloadStart({ requestId: "r2", url: VALID_URL, format: "opus" });
  expect(second.code).toBe("TASK_ALREADY_RUNNING");
  expect(second.category).toBe("internal");
  expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  expect(chrome.storage.local.set).not.toHaveBeenCalled();

  await background.__getStateForTest().activePipeline;
});

test("15: normalizeProgressの基準ごと最大値比較(R8.3)", () => {
  const { background } = loadBackgroundModule();
  const { normalizeProgress } = background;

  // ①同一basis内後退抑止
  const snap1 = normalizeProgress(
    { phase: "download", totalBytesSource: "sabr", totalBytes: 1000, percent: 80, state: "downloading", timestamp: "t1" },
    null,
  );
  expect(snap1.percent).toBe(80);
  const snap2 = normalizeProgress(
    { phase: "download", totalBytesSource: "sabr", totalBytes: 1000, percent: 50, state: "downloading", timestamp: "t2" },
    snap1,
  );
  expect(snap2.percent).toBe(80);

  // ②basis変化時は抑止されない
  const snap3 = normalizeProgress(
    { phase: "download", totalBytesSource: "sabr", totalBytes: 2000, percent: 10, state: "downloading", timestamp: "t3" },
    snap2,
  );
  expect(snap3.percent).toBe(10);

  // ③H2残存シーケンス回帰テスト B1:80 -> B2:null -> B1:50 で最終80
  const b1snap = normalizeProgress(
    { phase: "download", totalBytesSource: "sabr", totalBytes: 1000, percent: 80, state: "downloading", timestamp: "t4" },
    null,
  );
  const b2snap = normalizeProgress(
    { phase: "download", totalBytesSource: null, totalBytes: null, percent: null, state: "downloading", timestamp: "t5" },
    b1snap,
  );
  expect(b2snap.percent).toBeNull();
  const b1snap2 = normalizeProgress(
    { phase: "download", totalBytesSource: "sabr", totalBytes: 1000, percent: 50, state: "downloading", timestamp: "t6" },
    b2snap,
  );
  expect(b1snap2.percent).toBe(80);

  // ④converting時も他のstateと同様にクランプされる
  const convSnap = normalizeProgress(
    { phase: "convert", totalBytesSource: null, totalBytes: null, percent: 999, state: "converting", timestamp: "t7" },
    b1snap2,
  );
  expect(convSnap.percent).toBe(100);

  // ⑤クランプ
  const clampHigh = normalizeProgress(
    { phase: "download", totalBytesSource: "sabr", totalBytes: 1000, percent: 150, state: "downloading", timestamp: "t8" },
    null,
  );
  expect(clampHigh.percent).toBe(100);
  const clampLow = normalizeProgress(
    { phase: "download", totalBytesSource: "sabr", totalBytes: 1000, percent: -20, state: "downloading", timestamp: "t9" },
    null,
  );
  expect(clampLow.percent).toBe(0);

  // ⑥32件超過時に現在のbasisが削除されないこと
  let previous = null;
  for (let i = 0; i < 40; i += 1) {
    previous = normalizeProgress(
      { phase: "download", totalBytesSource: "sabr", totalBytes: i, percent: 1, state: "downloading", timestamp: `e${i}` },
      previous,
    );
  }
  const currentBasis = "download:sabr:39";
  expect(Object.keys(previous.progressMaxByBasis).length).toBeLessThanOrEqual(32);
  expect(previous.progressMaxByBasis[currentBasis]).toBeDefined();
});

test("35: normalizeProgressは受け取ったtimestampを書き換えず、updatedAtは存在しない", () => {
  const { background } = loadBackgroundModule();
  const normalized = background.normalizeProgress(
    {
      type: "download.progress",
      taskId: "task-z",
      sequence: 1,
      state: "downloading",
      phase: "download",
      percent: 10,
      totalBytesSource: "sabr",
      totalBytes: 100,
      timestamp: "2026-09-05T12:00:01Z",
    },
    null,
  );
  expect(normalized.timestamp).toBe("2026-09-05T12:00:01Z");
  expect(normalized).not.toHaveProperty("updatedAt");
});

test("36: normalizeProgressはconverting時にpercentを保持し、convertedSeconds/totalSecondsもそのまま載る", () => {
  const { background } = loadBackgroundModule();
  const convSnap = background.normalizeProgress(
    {
      phase: "convert",
      totalBytesSource: null,
      totalBytes: null,
      percent: 42.3,
      convertedSeconds: 12.5,
      totalSeconds: 30,
      state: "converting",
      timestamp: "t1",
    },
    null,
  );
  expect(convSnap.percent).toBe(42.3);
  expect(convSnap.convertedSeconds).toBe(12.5);
  expect(convSnap.totalSeconds).toBe(30);
});

test("37: normalizeProgressはconvertAttemptごとにbasisを分け、リトライでpercentが後退できる", () => {
  const { background } = loadBackgroundModule();
  const { normalizeProgress } = background;

  const attempt1 = normalizeProgress(
    { phase: "convert", totalBytesSource: null, totalBytes: null, percent: 60, convertAttempt: 1, state: "converting", timestamp: "t1" },
    null,
  );
  expect(attempt1.percent).toBe(60);

  const attempt2 = normalizeProgress(
    { phase: "convert", totalBytesSource: null, totalBytes: null, percent: 0, convertAttempt: 2, state: "converting", timestamp: "t2" },
    attempt1,
  );

  expect(attempt2.percent).toBe(0);
  expect(attempt2.progressMaxByBasis["convert:none:NA:1"]).toBe(60);
  expect(attempt2.progressMaxByBasis["convert:none:NA:2"]).toBe(0);
});

test("38: convertAttemptを持たないdownloadメッセージのbasisキーは従来形のまま(回帰)", () => {
  const { background } = loadBackgroundModule();
  const snap = background.normalizeProgress(
    { phase: "download", totalBytesSource: "sabr", totalBytes: 1000, percent: 30, state: "downloading", timestamp: "t1" },
    null,
  );
  expect(Object.keys(snap.progressMaxByBasis)).toEqual(["download:sabr:1000"]);
});

test("28: claimTaskはawaitなしの同期処理でIDLE判定とtaskId確定を不可分に行う(H3回帰防止)", () => {
  const { background } = loadBackgroundModule();
  const first = background.claimTask(VALID_URL, "mp3", "abc123", "standard");
  expect(first.ok).toBe(true);
  const second = background.claimTask(VALID_URL, "opus", "abc123", "standard");
  expect(second.ok).toBe(false);
  expect(second.code).toBe("TASK_ALREADY_RUNNING");
});

test("29: finishTaskは同期区間で状態変数をリセットする(H4回帰防止)", () => {
  const { background } = loadBackgroundModule();
  const claim = background.claimTask(VALID_URL, "mp3", "abc123", "standard");
  expect(background.__getStateForTest().activeTaskId).toBe(claim.taskId);

  const resultPromise = background.finishTask({
    type: "download.result",
    taskId: claim.taskId,
    sequence: 1,
    state: "completed",
    phase: "done",
    percent: 100,
    timestamp: "t",
  });

  // await前(同期区間の直後)で既にリセットされていること
  const stateAfter = background.__getStateForTest();
  expect(stateAfter.activeTaskId).toBeNull();
  expect(stateAfter.activeTask).toBeNull();
  expect(stateAfter.lastSequence).toBe(-1);

  return resultPromise;
});

test("30: download.acceptedのフィールド構成と拒否時の非保存(H5)", async () => {
  const { background, chrome } = loadBackgroundModule();
  mockAgentResult(chrome, AGENT_SUCCESS);
  const accepted = await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "opus" });
  expect(accepted).toEqual({
    type: "download.accepted",
    requestId: "r1",
    taskId: accepted.taskId,
    sequence: 0,
    state: "starting",
    phase: "download",
    percent: null,
    format: "opus",
    url: VALID_URL,
    timestamp: accepted.timestamp,
  });

  chrome.storage.local.set.mockClear();
  const rejected = await background.handleDownloadStart({ requestId: "r2", url: VALID_URL, format: "opus" });
  expect(rejected.code).toBe("TASK_ALREADY_RUNNING");
  expect(chrome.storage.local.set).not.toHaveBeenCalled();

  await background.__getStateForTest().activePipeline;
});

test("20: progress.snapshot.getは保存なしでnull、保存ありで保存内容そのまま", async () => {
  const { background, chrome } = loadBackgroundModule();
  mockAgentResult(chrome, AGENT_SUCCESS);
  const empty = await background.handleSnapshotGet({ requestId: "s1" });
  expect(empty).toEqual({ type: "progress.snapshot", requestId: "s1", task: null });

  const accepted = await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "mp3" });
  const response = await background.handleSnapshotGet({ requestId: "s2" });
  expect(response.task.taskId).toBe(accepted.taskId);
  expect(response.task.state).toBe("starting");

  await background.__getStateForTest().activePipeline;
});

describe("categorizeError", () => {
  test("65: 詳細設計2.2のcode→カテゴリ対応(明示マップ)", () => {
    const { background } = loadBackgroundModule();
    const expected = {
      AUTH_NOT_LOGGED_IN: "auth",
      AUTH_REJECTED: "auth",
      VIDEO_LOGIN_REQUIRED: "auth",
      VIDEO_AGE_RESTRICTED: "auth",
      VIDEO_UNPLAYABLE: "video",
      VIDEO_UNAVAILABLE: "video",
      VIDEO_LIVE: "video",
      VIDEO_DRM: "video",
      VIDEO_NO_AUDIO_FORMAT: "video",
      NETWORK_UNREACHABLE: "network",
      SABR_SERVER_ERROR: "network",
      FETCH_STALLED: "network",
      FETCH_TIMEOUT: "network",
      PLAYER_JS_UNAVAILABLE: "breakage",
      NSIG_REJECTED_BY_SERVER: "breakage",
      SAVE_PERMISSION_DENIED: "save",
      SAVE_NO_DIRECTORY: "save",
      SAVE_FAILED: "save",
      TAB_UNAVAILABLE: "internal",
      TRANSFER_INCOMPLETE: "internal",
      CONVERT_FAILED: "internal",
    };
    for (const [code, category] of Object.entries(expected)) {
      expect([code, background.categorizeError(code)]).toEqual([code, category]);
    }
  });

  test("66: 未知codeはinternal、接頭辞規則はOffscreenの新規codeにも効く", () => {
    const { background } = loadBackgroundModule();
    expect(background.categorizeError("SOMETHING_NEW")).toBe("internal");
    expect(background.categorizeError(undefined)).toBe("internal");
    expect(background.categorizeError("SAVE_QUOTA_EXCEEDED")).toBe("save");
    expect(background.categorizeError("VIDEO_SOMETHING_ELSE")).toBe("video");
  });
});

describe("タブ取得(Q4)", () => {
  test("67: アクティブタブがyoutube.comならそのタブへ注入する", async () => {
    const { background, tabs } = loadBackgroundModule();
    tabs.length = 0;
    tabs.push(
      { id: 7, active: true, url: "https://www.youtube.com/feed/subscriptions" },
      { id: 9, active: false, url: "https://www.youtube.com/watch?v=zzz" },
    );
    await expect(background.acquireYoutubeTab()).resolves.toBe(7);
  });

  test("68: アクティブタブが非YouTubeなら開いている任意のyoutube.comタブを使う", async () => {
    const { background, tabs } = loadBackgroundModule();
    tabs.length = 0;
    tabs.push(
      { id: 3, active: true, url: "https://example.com/" },
      { id: 5, active: false, url: "https://www.youtube.com/watch?v=zzz" },
    );
    await expect(background.acquireYoutubeTab()).resolves.toBe(5);
  });

  test("69: YouTubeタブが1つも無ければTAB_UNAVAILABLEで失敗し、新規タブは開かない", async () => {
    const { background, chrome, tabs } = loadBackgroundModule();
    tabs.length = 0;
    tabs.push({ id: 3, active: true, url: "https://example.com/" });

    await expect(background.acquireYoutubeTab()).rejects.toMatchObject({ code: "TAB_UNAVAILABLE" });
    expect(chrome.tabs.create).toBeUndefined();
  });

  test("70: TAB_UNAVAILABLEはタスクをinternalカテゴリのerrorで終了させる", async () => {
    const { background, chrome, tabs } = loadBackgroundModule();
    tabs.length = 0;
    tabs.push({ id: 3, active: true, url: "https://example.com/" });

    await startTask(background);

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("TAB_UNAVAILABLE");
    expect(snapshot.category).toBe("internal");
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
  });
});

describe("オンデマンド注入(Gap2 §1)", () => {
  test("71: page-relay(ISOLATED)→start(taskId+secret)→cfg受け渡し(MAIN func)→page-agent(MAIN files) の順で4回executeScriptする", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);

    const accepted = await startTask(background);
    const calls = chrome.scripting.executeScript.mock.calls.map(([injection]) => injection);

    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({ target: { tabId: 1 }, world: "ISOLATED", files: ["dist/page-relay.js"] });
    expect(calls[1]).toMatchObject({ target: { tabId: 1 }, world: "ISOLATED", args: [{ taskId: accepted.taskId }] });
    expect(typeof calls[1].func).toBe("function");
    const relaySecret = calls[1].args[0].secret;
    expect(relaySecret).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[2]).toMatchObject({ target: { tabId: 1 }, world: "MAIN" });
    expect(typeof calls[2].func).toBe("function");
    expect(calls[2].args[0]).toMatchObject({
      taskId: accepted.taskId,
      secret: relaySecret,
      videoId: "abc123",
      qualityTier: "standard",
      playerJs: { knownGoodUrl: null, excluded: [] },
    });
    expect(calls[3]).toEqual({ target: { tabId: 1 }, world: "MAIN", files: ["dist/page-agent.js"] });
  });

  test("71b: secretはタスクごとに新規生成され、chrome.storageへは保存されない", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);

    const first = await startTask(background);
    await completeTask(background, first.taskId);
    const firstSecret = chrome.scripting.executeScript.mock.calls[1][0].args[0].secret;
    chrome.scripting.executeScript.mockClear();
    mockAgentResult(chrome, AGENT_SUCCESS);
    await startTask(background, { requestId: "r2" });
    const secondSecret = chrome.scripting.executeScript.mock.calls[1][0].args[0].secret;

    expect(secondSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(secondSecret).not.toBe(firstSecret);
    const persisted = [...chrome.storage.local.set.mock.calls, ...chrome.storage.session.set.mock.calls]
      .map(([obj]) => JSON.stringify(obj))
      .join("\n");
    expect(persisted).not.toContain(firstSecret);
    expect(persisted).not.toContain(secondSecret);
  });

  test("71c: cfg受け渡し(MAIN func)が{ok:true}を返さなければINJECTION_FAILEDで終了し、バンドルは注入しない", async () => {
    const { background, chrome } = loadBackgroundModule();
    chrome.scripting.executeScript.mockImplementation((injection) => {
      if (injection.world === "MAIN" && typeof injection.func === "function") {
        return Promise.resolve([{ frameId: 0, result: { ok: false } }]);
      }
      return Promise.resolve([{ frameId: 0, result: undefined }]);
    });

    await startTask(background);

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("INJECTION_FAILED");
    const calls = chrome.scripting.executeScript.mock.calls.map(([injection]) => injection);
    expect(calls).toHaveLength(3);
    expect(calls.some((injection) => Array.isArray(injection.files) && injection.files.includes("dist/page-agent.js"))).toBe(false);
  });

  /**
   * 注入されたcfg受け渡し関数を、globalThisの代わりに任意のオブジェクトへ束縛して評価できる形にする。
   * 関数ソース中の自由識別子globalThisを引数で差し替える(テストのグローバルを汚さないため)。
   * @param {object} chrome スタブのchrome(startTask後)
   * @returns {(target: object, cfg: object) => {ok: boolean}} 束縛済みの受け渡し関数
   */
  function boundHandoff(chrome) {
    const injection = chrome.scripting.executeScript.mock.calls.find(
      ([call]) => call.world === "MAIN" && typeof call.func === "function",
    )[0];
    const evaluate = new Function("globalThis", "cfg", `return (${injection.func.toString()})(cfg);`);
    return (target, cfg) => evaluate(target, cfg);
  }

  test("71d: cfg受け渡し関数は既存のnon-configurableな__ytaCfgを拒否し、既存値を書き換えない", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);
    await startTask(background);
    const handoff = boundHandoff(chrome);

    const hostile = {};
    const planted = { fake: true };
    Object.defineProperty(hostile, "__ytaCfg", { value: planted, configurable: false, writable: true });

    expect(handoff(hostile, { taskId: "t", secret: "s" })).toEqual({ ok: false });
    expect(hostile.__ytaCfg).toBe(planted);
  });

  test("71e: cfg受け渡し関数は既存のconfigurableな__ytaCfgを削除して差し替え、writable:false/enumerable:falseで定義する", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);
    await startTask(background);
    const handoff = boundHandoff(chrome);
    const cfg = { taskId: "t", secret: "s" };

    const target = {};
    Object.defineProperty(target, "__ytaCfg", { value: { fake: true }, configurable: true, enumerable: true, writable: true });
    expect(handoff(target, cfg)).toEqual({ ok: true });
    const descriptor = Object.getOwnPropertyDescriptor(target, "__ytaCfg");
    expect(descriptor.value).toBe(cfg);
    expect(descriptor.writable).toBe(false);
    expect(descriptor.configurable).toBe(true);
    expect(descriptor.enumerable).toBe(false);

    const empty = {};
    expect(handoff(empty, cfg)).toEqual({ ok: true });
    expect(empty.__ytaCfg).toBe(cfg);
  });

  test("72: 注入前にOffscreen Documentが無ければ作成する", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);

    await startTask(background);

    expect(chrome.runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    expect(chrome.offscreen.createDocument).toHaveBeenCalledWith({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "audio transfer + encoding",
    });
    // 作成はいずれの注入よりも先に行われる。
    expect(chrome.offscreen.createDocument.mock.invocationCallOrder[0]).toBeLessThan(
      chrome.scripting.executeScript.mock.invocationCallOrder[0],
    );
  });

  test("73: Offscreen Documentが既にあればcreateDocumentを呼ばない", async () => {
    const { background, chrome } = loadBackgroundModule(
      {},
      (stub) => stub.contexts.push({ contextType: "OFFSCREEN_DOCUMENT" }),
    );
    mockAgentResult(chrome, AGENT_SUCCESS);

    await startTask(background);

    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  test("74: createDocumentの失敗はOFFSCREEN_UNAVAILABLEになり、次回再試行できる", async () => {
    const { background, chrome } = loadBackgroundModule();
    chrome.offscreen.createDocument.mockRejectedValueOnce(new Error("boom"));

    await startTask(background);

    const snapshot = await background.loadSnapshot();
    expect(snapshot.code).toBe("OFFSCREEN_UNAVAILABLE");
    expect(snapshot.category).toBe("internal");
    // キャッシュを破棄しているため、次のタスクで再度作成が試みられる。
    mockAgentResult(chrome, AGENT_SUCCESS);
    chrome.offscreen.createDocument.mockClear();
    await startTask(background);
    expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });
});

describe("playerJsフォールバック状態の永続化(Gap1 §2)", () => {
  test("75: 成功時のacceptedCandidateがlocalのknownGoodへ書かれる", async () => {
    const { background, chrome, storage } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);

    await startTask(background);

    expect(storage.playerJs.knownGood).toEqual({
      url: AGENT_SUCCESS.acceptedCandidate.url,
      buildHash: "aaaa1111",
      variant: "player_es6",
      acceptedAt: expect.any(String),
      acceptCount: 1,
    });
  });

  test("76: 同一URLの再採用はacceptCountを加算し、別URLなら1へ戻す", async () => {
    const { background, chrome, storage } = loadBackgroundModule({
      playerJs: {
        knownGood: {
          url: AGENT_SUCCESS.acceptedCandidate.url,
          buildHash: "aaaa1111",
          variant: "player_es6",
          acceptedAt: "t0",
          acceptCount: 4,
        },
      },
    });
    mockAgentResult(chrome, AGENT_SUCCESS);

    const first = await startTask(background);
    expect(storage.playerJs.knownGood.acceptCount).toBe(5);
    await completeTask(background, first.taskId);

    mockAgentResult(chrome, {
      ...AGENT_SUCCESS,
      acceptedCandidate: { url: "https://www.youtube.com/s/player/bbbb2222/player_es6.vflset/en_US/base.js", buildHash: "bbbb2222", variant: "player_es6" },
    });
    await startTask(background);
    expect(storage.playerJs.knownGood.acceptCount).toBe(1);
    expect(storage.playerJs.knownGood.buildHash).toBe("bbbb2222");
  });

  test("77: rejectedCandidatesは成功結果・失敗結果のいずれからもsessionへ書かれる", async () => {
    const { background, chrome, sessionStorage } = loadBackgroundModule();
    mockAgentResult(chrome, {
      ...AGENT_SUCCESS,
      rejectedCandidates: [{ url: "u1", buildHash: "cccc3333", variant: "player_es6" }],
    });

    const first = await startTask(background);
    expect(sessionStorage.playerJsRejected["cccc3333:player_es6"]).toEqual({
      reason: "NSIG_REJECTED_BY_SERVER",
      at: expect.any(Number),
    });
    await completeTask(background, first.taskId);

    mockAgentResult(chrome, {
      ok: false,
      code: "NSIG_REJECTED_BY_SERVER",
      detail: { tried: [] },
      rejectedCandidates: [{ url: "u2", buildHash: "dddd4444", variant: "player_es6" }],
    });
    await startTask(background);
    expect(sessionStorage.playerJsRejected["dddd4444:player_es6"].reason).toBe("NSIG_REJECTED_BY_SERVER");
    // 既存エントリは保持される。
    expect(sessionStorage.playerJsRejected["cccc3333:player_es6"]).toBeDefined();
  });

  test("78: 次回タスクのcfg.playerJsへknownGoodUrlと有効期限内のexcludedが渡る", async () => {
    const { background, chrome } = loadBackgroundModule(
      { playerJs: { knownGood: { url: "https://known.good/base.js", buildHash: "aaaa1111", variant: "player_es6", acceptedAt: "t", acceptCount: 2 } } },
      (stub) => {
        stub.sessionStorage.playerJsRejected = {
          "cccc3333:player_es6": { reason: "NSIG_REJECTED_BY_SERVER", at: Date.now() },
          "eeee5555:player_es6": { reason: "NSIG_REJECTED_BY_SERVER", at: Date.now() - 7 * 60 * 60 * 1000 },
        };
      },
    );
    mockAgentResult(chrome, AGENT_SUCCESS);

    const playerJs = await background.loadPlayerJsConfig();

    expect(playerJs.knownGoodUrl).toBe("https://known.good/base.js");
    // 期限切れ(6時間超)のeeee5555は除外される。
    expect(playerJs.excluded).toEqual([{ buildHash: "cccc3333", variant: "player_es6" }]);
  });
});

describe("状態遷移", () => {
  test("79: page.status phase download でdownloading状態と進捗が反映される", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, new Promise(() => {}));
    const accepted = await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "mp3" });
    await flush();

    await background.handlePageStatus({
      type: "page.status",
      taskId: accepted.taskId,
      phase: "download",
      bytes: 500,
      totalBytes: 1000,
    });

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("downloading");
    expect(snapshot.phase).toBe("download");
    expect(snapshot.percent).toBe(50);
    expect(snapshot.downloadedBytes).toBe(500);
    expect(snapshot.totalBytes).toBe(1000);
  });

  test("80: 準備フェーズ(player/player-js)のstatusはstartingのままagentPhaseだけ載せる", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, new Promise(() => {}));
    const accepted = await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "mp3" });
    await flush();

    await background.handlePageStatus({ type: "page.status", taskId: accepted.taskId, phase: "player-js" });

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("starting");
    expect(snapshot.agentPhase).toBe("player-js");
    expect(snapshot.percent).toBeNull();
  });

  test("81: taskId不一致のpage.statusは無視される", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, new Promise(() => {}));
    await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "mp3" });
    await flush();

    chrome.storage.local.set.mockClear();
    chrome.runtime.sendMessage.mockClear();

    await background.handlePageStatus({ type: "page.status", taskId: "task-other", phase: "download", bytes: 1, totalBytes: 2 });

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test("82: 進捗受信時はstorage.setの解決後にsendMessageが呼ばれる", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, new Promise(() => {}));
    const accepted = await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "mp3" });
    await flush();

    const callOrder = [];
    chrome.storage.local.set.mockImplementation(() => {
      callOrder.push("set");
      return Promise.resolve();
    });
    chrome.runtime.sendMessage.mockImplementation(() => {
      callOrder.push("sendMessage");
      return Promise.resolve();
    });

    await background.handlePageStatus({ type: "page.status", taskId: accepted.taskId, phase: "download", bytes: 1, totalBytes: 10 });

    expect(callOrder).toEqual(["set", "sendMessage"]);
  });

  test("17: Popup不在時のsendMessage rejectionはタスク失敗にしない", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, new Promise(() => {}));
    chrome.runtime.sendMessage.mockImplementation(() =>
      Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")),
    );
    const accepted = await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "mp3" });
    await flush();

    await expect(
      background.handlePageStatus({ type: "page.status", taskId: accepted.taskId, phase: "download", bytes: 1, totalBytes: 10 }),
    ).resolves.toBeUndefined();

    const stored = await background.loadSnapshot();
    expect(stored.state).not.toBe("error");
  });

  test("83: agent成功+audio.transfer.completeが揃った時点でconvert.startを送りconvertingへ遷移する", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);
    const accepted = await startTask(background);

    // agent結果だけではまだ変換を始めない。
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "convert.start" }),
    );
    expect((await background.loadSnapshot()).state).not.toBe("converting");

    await background.handleTransferComplete({
      type: "audio.transfer.complete",
      taskId: accepted.taskId,
      epoch: 0,
      byteLength: 1000,
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "convert.start",
      taskId: accepted.taskId,
      format: "mp3",
      audioQuality: "standard",
      fileName: "テスト動画",
    });
    expect((await background.loadSnapshot()).state).toBe("converting");
  });

  test("84: audio.transfer.completeがagent結果より先に届いても変換は1回だけ開始される", async () => {
    const { background, chrome } = loadBackgroundModule();
    let resolveAgent;
    mockAgentResult(chrome, new Promise((resolve) => { resolveAgent = resolve; }));
    const accepted = await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "mp3" });
    await flush();

    await background.handleTransferComplete({ type: "audio.transfer.complete", taskId: accepted.taskId, epoch: 0, byteLength: 1000 });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "convert.start" }));

    resolveAgent(AGENT_SUCCESS);
    await background.__getStateForTest().activePipeline;

    const convertStarts = chrome.runtime.sendMessage.mock.calls.filter(([m]) => m.type === "convert.start");
    expect(convertStarts).toHaveLength(1);
  });

  test("85: convert.progressはconverting状態の進捗として反映される", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);
    const accepted = await startTask(background);
    await background.handleTransferComplete({ type: "audio.transfer.complete", taskId: accepted.taskId, epoch: 0, byteLength: 1000 });

    await background.handleConvertProgress({
      type: "convert.progress",
      taskId: accepted.taskId,
      percent: 40,
      convertedSeconds: 4,
      totalSeconds: 10,
    });

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("converting");
    expect(snapshot.phase).toBe("convert");
    expect(snapshot.percent).toBe(40);
    expect(snapshot.convertedSeconds).toBe(4);
  });

  test("86: convert.result成功でcompletedになり、保存・転送・通知が各1回", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);
    const accepted = await startTask(background);
    await background.handleTransferComplete({ type: "audio.transfer.complete", taskId: accepted.taskId, epoch: 0, byteLength: 1000 });

    chrome.storage.local.set.mockClear();
    chrome.runtime.sendMessage.mockClear();
    chrome.notifications.create.mockClear();

    await background.handleConvertResult({ type: "convert.result", taskId: accepted.taskId, ok: true, fileName: "テスト動画.mp3" });

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("completed");
    expect(snapshot.percent).toBe(100);
    expect(snapshot.fileName).toBe("テスト動画.mp3");
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });

  test("87: convert.result失敗はcodeとカテゴリを載せてerrorへ遷移する", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);
    const accepted = await startTask(background);
    await background.handleTransferComplete({ type: "audio.transfer.complete", taskId: accepted.taskId, epoch: 0, byteLength: 1000 });

    await background.handleConvertResult({ type: "convert.result", taskId: accepted.taskId, ok: false, code: "SAVE_PERMISSION_DENIED" });

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SAVE_PERMISSION_DENIED");
    expect(snapshot.category).toBe("save");
  });

  test("88: audio.transfer.failedはerrorへ遷移する", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);
    const accepted = await startTask(background);

    await background.handleTransferFailed({ type: "audio.transfer.failed", taskId: accepted.taskId, code: "TRANSFER_SEQ_GAP" });

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("TRANSFER_SEQ_GAP");
  });

  test("89: page.relay.failedはerrorへ遷移する", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, new Promise(() => {}));
    const accepted = await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "mp3" });
    await flush();

    await background.handleRelayFailed({ type: "page.relay.failed", taskId: accepted.taskId, code: "RELAY_PORT_DISCONNECTED" });

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("RELAY_PORT_DISCONNECTED");
    expect(snapshot.category).toBe("internal");
  });

  test("162: page.relay.failed(RELAY_IDLE)はconvert.releaseも送りOffscreen資源を解放する", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, new Promise(() => {}));
    const accepted = await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "mp3" });
    await flush();
    chrome.runtime.sendMessage.mockClear();

    await background.handleRelayFailed({ type: "page.relay.failed", taskId: accepted.taskId, code: "RELAY_IDLE" });

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("RELAY_IDLE");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId: accepted.taskId });
  });

  test("90: agentの失敗結果はcodeをそのまま引き継ぎカテゴリを付与する", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, { ok: false, code: "AUTH_NOT_LOGGED_IN", detail: { tried: [] }, rejectedCandidates: [] });

    await startTask(background);

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("AUTH_NOT_LOGGED_IN");
    expect(snapshot.category).toBe("auth");
    expect(snapshot.message).toBe(chrome.i18n.getMessage("error_AUTH_NOT_LOGGED_IN"));
  });

  test("91: executeScriptの戻り値とpage.resultの二重送達は先着の1回だけ処理される", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);
    const accepted = await startTask(background);

    chrome.storage.local.set.mockClear();
    // リレー経由で同じ結果がもう一度届いても、状態は変化しない。
    await background.handleAgentResult(accepted.taskId, AGENT_SUCCESS);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  test("92: SW再起動でexecuteScriptのPromiseを失っても、page.result経由で結果を処理できる", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, new Promise(() => {}));
    const accepted = await background.handleDownloadStart({ requestId: "r1", url: VALID_URL, format: "mp3" });
    await flush();

    background.handleRuntimeMessage(
      { type: "page.result", taskId: accepted.taskId, result: { ok: false, code: "VIDEO_LIVE", detail: {}, rejectedCandidates: [] } },
      {},
      () => {},
    );
    await flush();

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("VIDEO_LIVE");
    expect(snapshot.category).toBe("video");
  });
});

describe("ファイル名", () => {
  test("93: titleをサニタイズし、使えなければvideoIdへフォールバックする", () => {
    const { background } = loadBackgroundModule();
    expect(background.buildFileName('a/b:c*d?e"f<g>h|i', "vid1")).toBe("a_b_c_d_e_f_g_h_i");
    expect(background.buildFileName("  ...  ", "vid1")).toBe("vid1");
    expect(background.buildFileName(null, "vid1")).toBe("vid1");
    expect(background.sanitizeFileName("a".repeat(300))).toHaveLength(120);
  });
});

describe("SW再起動復帰(Gap2 §3.4)", () => {
  const runningSnapshot = {
    taskId: "task-x",
    sequence: 3,
    state: "converting",
    phase: "convert",
    percent: 40,
    format: "mp3",
    url: VALID_URL,
    progressMaxByBasis: {},
    timestamp: "t0",
  };

  test("94: Offscreenが無ければSW_RESTARTEDのerrorへ書き換える", async () => {
    const { background } = loadBackgroundModule({ "youtubeAudioDownloader.snapshot": runningSnapshot });
    await flush();

    const rewritten = await background.loadSnapshot();
    expect(rewritten.state).toBe("error");
    expect(rewritten.code).toBe("SW_RESTARTED");
    expect(rewritten.category).toBe("internal");
  });

  test("95: Offscreenが変換中と答えればタスクを引き継ぎ、errorにしない", async () => {
    const { background, chrome } = loadBackgroundModule({ "youtubeAudioDownloader.snapshot": runningSnapshot }, (stub) => {
      stub.contexts.push({ contextType: "OFFSCREEN_DOCUMENT" });
      stub.chrome.runtime.sendMessage.mockImplementation((message) => {
        if (message.type === "convert.status") {
          return Promise.resolve({
            type: "convert.status.result",
            taskId: message.taskId,
            running: true,
            offscreenState: "converting",
          });
        }
        return Promise.resolve();
      });
    });
    await flush();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.status", taskId: "task-x" });
    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("converting");
    expect(background.__getStateForTest().activeTaskId).toBe("task-x");
  });

  test("96: offscreenStateを持たない応答(推測不能)はSW_RESTARTEDへ落とす", async () => {
    const { background } = loadBackgroundModule({ "youtubeAudioDownloader.snapshot": runningSnapshot }, (stub) => {
      stub.contexts.push({ contextType: "OFFSCREEN_DOCUMENT" });
      stub.chrome.runtime.sendMessage.mockImplementation((message) => {
        if (message.type === "convert.status") {
          return Promise.resolve({ type: "convert.status.result", taskId: message.taskId, running: false });
        }
        return Promise.resolve();
      });
    });
    await flush();

    expect((await background.loadSnapshot()).code).toBe("SW_RESTARTED");
  });

  test("97: Offscreenが応答しない場合はタイムアウトしてSW_RESTARTEDへ落とす", async () => {
    jest.useFakeTimers();
    try {
      const { background } = loadBackgroundModule({ "youtubeAudioDownloader.snapshot": runningSnapshot }, (stub) => {
        stub.contexts.push({ contextType: "OFFSCREEN_DOCUMENT" });
        stub.chrome.runtime.sendMessage.mockImplementation((message) =>
          message.type === "convert.status" ? new Promise(() => {}) : Promise.resolve(),
        );
      });

      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(0);

      expect((await background.loadSnapshot()).code).toBe("SW_RESTARTED");
    } finally {
      jest.useRealTimers();
    }
  });

  test("19: completedスナップショットは書き換えない", async () => {
    const completedSnapshot = {
      taskId: "task-y",
      sequence: 9,
      state: "completed",
      phase: "done",
      percent: 100,
      format: "mp3",
      url: VALID_URL,
      progressMaxByBasis: {},
      timestamp: "t0",
    };
    const { background } = loadBackgroundModule({ "youtubeAudioDownloader.snapshot": completedSnapshot });
    await flush();

    expect(await background.loadSnapshot()).toEqual(completedSnapshot);
  });
});

describe("通知", () => {
  test("53: 完了通知は保存先を断定しない文言(Low1)", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);
    const accepted = await startTask(background);
    await background.handleTransferComplete({ type: "audio.transfer.complete", taskId: accepted.taskId, epoch: 0, byteLength: 1000 });

    await background.handleConvertResult({ type: "convert.result", taskId: accepted.taskId, ok: true });

    expect(chrome.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "音声ダウンロード完了", message: "ダウンロードが完了しました。" }),
    );
  });

  test("59: 既知codeの失敗通知本文はi18nメッセージに変換される", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, { ok: false, code: "VIDEO_DRM", detail: {}, rejectedCandidates: [] });

    await startTask(background);

    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    expect(chrome.notifications.create.mock.calls[0][0].message).toBe(
      chrome.i18n.getMessage("error_VIDEO_DRM"),
    );
  });

  test("60: 未知codeはフォールバックのmessageがそのまま失敗通知に使われる", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);
    const accepted = await startTask(background);
    await background.handleTransferComplete({ type: "audio.transfer.complete", taskId: accepted.taskId, epoch: 0, byteLength: 1000 });

    chrome.notifications.create.mockClear();
    await background.handleConvertResult({
      type: "convert.result",
      taskId: accepted.taskId,
      ok: false,
      code: "SOMETHING_UNKNOWN",
      message: "エンコーダーが落ちました",
    });

    expect(chrome.notifications.create.mock.calls[0][0].message).toBe("エンコーダーが落ちました");
  });
});

describe("handleRuntimeMessage", () => {
  test("98: 応答が必要な要求のみtrueを返し、片方向通知はfalseを返す", () => {
    const { background } = loadBackgroundModule();
    const sendResponse = jest.fn();

    expect(background.handleRuntimeMessage({ type: "download.start", requestId: "r", url: "" }, {}, sendResponse)).toBe(true);
    expect(background.handleRuntimeMessage({ type: "progress.snapshot.get", requestId: "s" }, {}, sendResponse)).toBe(true);
    for (const type of [
      "page.status",
      "page.result",
      "page.relay.failed",
      "audio.transfer.complete",
      "audio.transfer.failed",
      "convert.progress",
      "convert.result",
    ]) {
      expect(background.handleRuntimeMessage({ type, taskId: "task-none" }, {}, sendResponse)).toBe(false);
    }
    expect(background.handleRuntimeMessage({ type: "unknown" }, {}, sendResponse)).toBe(false);
    expect(background.handleRuntimeMessage(null, {}, sendResponse)).toBe(false);
  });

  test("99: 廃止したNative Messaging系メッセージは受け付けない", () => {
    const { background } = loadBackgroundModule();
    const sendResponse = jest.fn();
    expect(background.handleRuntimeMessage({ type: "browse.directory", requestId: "b" }, {}, sendResponse)).toBe(false);
    expect(background.handleRuntimeMessage({ type: "default_output_dir.get", requestId: "d" }, {}, sendResponse)).toBe(false);
    expect(global.chrome.runtime.connectNative).toBeUndefined();
  });

  test("100: convert.resultにdownloadUrlがあればchrome.downloads.downloadで保存先未選択分を保存し、完了はonChangedまで待つ", async () => {
    const { background, chrome, fireDownloadsChanged, downloadItems } = loadBackgroundModule();
    downloadItems.push({ id: 1, state: "in_progress" });
    mockAgentResult(chrome, AGENT_SUCCESS);
    const accepted = await startTask(background);
    await background.handleTransferComplete({ type: "audio.transfer.complete", taskId: accepted.taskId, epoch: 0, byteLength: 1000 });

    await background.handleConvertResult({
      type: "convert.result",
      taskId: accepted.taskId,
      ok: true,
      fileName: "テスト動画.mp3",
      dirName: null,
      downloadUrl: "blob:chrome-extension://abc/def",
    });

    expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
    expect(chrome.downloads.download).toHaveBeenCalledWith({
      url: "blob:chrome-extension://abc/def",
      filename: "テスト動画.mp3",
    });
    // ダウンロード項目が終端に達するまで完了扱いにしない(finding 9)。
    expect((await background.loadSnapshot()).state).toBe("converting");
    expect((await background.loadSnapshot()).downloadId).toBe(1);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "convert.release" }),
    );

    await fireDownloadsChanged({ id: 1, state: { previous: "in_progress", current: "complete" } });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "convert.release",
      taskId: accepted.taskId,
    });
    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("completed");
    expect(snapshot.fileName).toBe("テスト動画.mp3");
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });

  test("101: convert.resultにdownloadUrlが無ければ(保存先ディレクトリ選択済み)chrome.downloads.downloadを呼ばない", async () => {
    const { background, chrome } = loadBackgroundModule();
    mockAgentResult(chrome, AGENT_SUCCESS);
    const accepted = await startTask(background);
    await background.handleTransferComplete({ type: "audio.transfer.complete", taskId: accepted.taskId, epoch: 0, byteLength: 1000 });

    await background.handleConvertResult({
      type: "convert.result",
      taskId: accepted.taskId,
      ok: true,
      fileName: "テスト動画.mp3",
      dirName: "MyMusic",
    });

    expect(chrome.downloads.download).not.toHaveBeenCalled();
    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("completed");
  });

  test("102: ERROR_MESSAGE_KEY_BY_CODEの全キーがen/ja両方のmessages.jsonに存在する", () => {
    const { background } = loadBackgroundModule();
    const messagesEn = require("./_locales/en/messages.json");
    const messagesJa = require("./_locales/ja/messages.json");
    for (const [code, key] of Object.entries(background.ERROR_MESSAGE_KEY_BY_CODE)) {
      expect(messagesEn[key]).toBeDefined();
      expect(messagesJa[key]).toBeDefined();
      // 念のためcode自身にも触れておく(未定義キー追加時に片方だけ直す事故を防ぐ)。
      expect(typeof code).toBe("string");
    }
  });

  test("103: T1/T2が追加したRELAY_IDLE/CONVERT_STALLEDがマップ・訳文の両方に載っている", () => {
    const { background, chrome } = loadBackgroundModule();
    expect(background.ERROR_MESSAGE_KEY_BY_CODE.RELAY_IDLE).toBe("error_RELAY_IDLE");
    expect(background.ERROR_MESSAGE_KEY_BY_CODE.CONVERT_STALLED).toBe("error_CONVERT_STALLED");
    // CONVERT_STALLEDは変換パイプライン内部の障害としてinternalへ分類する。
    expect(background.categorizeError("CONVERT_STALLED")).toBe("internal");
    // RELAY_IDLEはRELAY_PORT_DISCONNECTEDと同じく既定のinternalへ落ちる。
    expect(background.categorizeError("RELAY_IDLE")).toBe("internal");
    expect(background.errorMessageFor("CONVERT_STALLED", "fallback")).toBe(
      chrome.i18n.getMessage("error_CONVERT_STALLED"),
    );
    expect(background.errorMessageFor("RELAY_IDLE", "fallback")).toBe(
      chrome.i18n.getMessage("error_RELAY_IDLE"),
    );
  });

  test("104: popup.jsの表示用マップにもCONVERT_STALLEDが載っている", () => {
    const popupSource = require("fs").readFileSync(require("path").join(__dirname, "popup.js"), "utf8");
    expect(popupSource).toContain('CONVERT_STALLED: "error_CONVERT_STALLED"');
  });
});

describe("Downloadsフォルダ保存の終端待ち(finding 6/9)", () => {
  /**
   * convert.result(downloadUrl付き)まで進めた実行中タスクを作る。
   * downloadItems未指定時は「進行中の項目が実在する」既定を置く。項目が全く見つからない
   * 場合はreconcileDownloadStateが再試行の末にSAVE_FAILEDへ落とす仕様のため。
   * @param {object} [options] downloadItemsの初期値などの調整
   * @returns {Promise<object>} ロード結果とtaskId
   */
  async function startDownloadsFolderSave(options = {}) {
    const loaded = loadBackgroundModule();
    loaded.downloadItems.push(
      ...(Array.isArray(options.downloadItems) ? options.downloadItems : [{ id: 1, state: "in_progress" }]),
    );
    if (options.configureDownload) {
      options.configureDownload(loaded.chrome);
    }
    mockAgentResult(loaded.chrome, AGENT_SUCCESS);
    const accepted = await startTask(loaded.background);
    await loaded.background.handleTransferComplete({
      type: "audio.transfer.complete",
      taskId: accepted.taskId,
      epoch: 0,
      byteLength: 1000,
    });
    await loaded.background.handleConvertResult({
      type: "convert.result",
      taskId: accepted.taskId,
      ok: true,
      fileName: "テスト動画.mp3",
      dirName: null,
      downloadUrl: "blob:chrome-extension://abc/def",
    });
    return { ...loaded, taskId: accepted.taskId };
  }

  test("105: interruptedになるとconvert.releaseを送りSAVE_FAILEDで終了する", async () => {
    const { background, chrome, fireDownloadsChanged, taskId } = await startDownloadsFolderSave();

    await fireDownloadsChanged({
      id: 1,
      state: { previous: "in_progress", current: "interrupted" },
      error: { previous: null, current: "FILE_NO_SPACE" },
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId });
    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SAVE_FAILED");
    expect(snapshot.category).toBe("save");
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });

  test("106: downloadId不一致のonChangedと終端でないonChangedは無視する", async () => {
    const { background, chrome, fireDownloadsChanged } = await startDownloadsFolderSave();
    chrome.runtime.sendMessage.mockClear();

    await fireDownloadsChanged({ id: 999, state: { previous: "in_progress", current: "complete" } });
    await fireDownloadsChanged({ id: 1, state: { previous: "in_progress", current: "in_progress" } });
    await fireDownloadsChanged({ id: 1, bytesReceived: { previous: 0, current: 10 } });

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "convert.release" }),
    );
    expect((await background.loadSnapshot()).state).toBe("converting");
  });

  test("107: download()の直後に既に終端へ達していればsearchで検知して完了させる", async () => {
    const { background, chrome, taskId } = await startDownloadsFolderSave({
      downloadItems: [{ id: 1, state: "complete" }],
    });

    expect(chrome.downloads.search).toHaveBeenCalledWith({ id: 1 });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId });
    expect((await background.loadSnapshot()).state).toBe("completed");
  });

  test("108: searchが既にinterruptedを返せばSAVE_FAILEDで終了する", async () => {
    const { background } = await startDownloadsFolderSave({
      downloadItems: [{ id: 1, state: "interrupted", error: "USER_CANCELED" }],
    });

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SAVE_FAILED");
  });

  test("109: chrome.downloads.downloadのrejectはSAVE_FAILEDで終了しconvert.releaseも送る", async () => {
    const { background, chrome, taskId } = await startDownloadsFolderSave({
      configureDownload: (stub) => {
        stub.downloads.download.mockRejectedValueOnce(new Error("download denied"));
      },
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId });
    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SAVE_FAILED");
    expect(snapshot.downloadId).toBeUndefined();
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });
});

describe("起動時復元のゲート(finding 16)", () => {
  test("110: 復元完了前に届いたdownload.startは復元完了まで待たされる", async () => {
    let releaseRecovery = null; // () => void
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    const { background, chrome } = loadBackgroundModule({}, (stub) => {
      const passthrough = stub.chrome.storage.local.get.getMockImplementation();
      let firstCall = true; // recoverOnStartup()のloadSnapshot()のみ遅延させる
      stub.chrome.storage.local.get.mockImplementation((key) => {
        if (firstCall) {
          firstCall = false;
          return recoveryGate.then(() => passthrough(key));
        }
        return passthrough(key);
      });
    });
    mockAgentResult(chrome, AGENT_SUCCESS);

    const sendResponse = jest.fn();
    const keepChannelOpen = background.handleRuntimeMessage(
      { type: "download.start", requestId: "r1", url: VALID_URL, format: "mp3" },
      {},
      sendResponse,
    );

    // 応答チャネルは同期的に開いたまま(trueを返す)にしつつ、実処理は待たせる。
    expect(keepChannelOpen).toBe(true);
    await flush();
    expect(sendResponse).not.toHaveBeenCalled();
    expect(background.__getStateForTest().activeTaskId).toBeNull();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();

    releaseRecovery();
    await flush();

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0][0].type).toBe("download.accepted");
    await background.__getStateForTest().activePipeline;
  });
});

describe("SW再起動復帰の状態別分岐(finding 10)", () => {
  /**
   * convert.statusへ固定の応答を返すOffscreenを用意する。
   * @param {object} response 応答本体(taskIdは自動で補う)
   * @returns {(stub: object) => void} loadBackgroundModuleのconfigure関数
   */
  function withOffscreenStatus(response) {
    return (stub) => {
      stub.contexts.push({ contextType: "OFFSCREEN_DOCUMENT" });
      stub.chrome.runtime.sendMessage.mockImplementation((message) => {
        if (message.type === "convert.status") {
          return Promise.resolve({ taskId: message.taskId, ...response });
        }
        return Promise.resolve();
      });
    };
  }

  /**
   * 実行中スナップショットを作る。
   * @param {object} [extra] 上書きするフィールド
   * @returns {object} TaskSnapshot
   */
  function runningSnapshot(extra = {}) {
    return {
      taskId: "task-x",
      sequence: 3,
      state: "downloading",
      phase: "download",
      percent: 10,
      format: "mp3",
      url: VALID_URL,
      progressMaxByBasis: {},
      timestamp: "t0",
      ...extra,
    };
  }

  test("111: transferring かつ fileName未保存ならagentSettledを立てず、後から届くpage.resultを処理できる", async () => {
    // timestampは直近(=まだ停滞していない)。停滞判定については別テストで検証する。
    const { background, chrome } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ timestamp: new Date().toISOString() }) },
      withOffscreenStatus({ running: true, offscreenState: "transferring", percent: 0, byteLength: 500, format: null, fileName: null }),
    );
    await flush();

    const state = background.__getStateForTest();
    expect(state.activeTaskId).toBe("task-x");
    expect(state.activeTask.agentSettled).toBe(false);
    expect(state.activeTask.conversionStarted).toBe(false);
    expect(state.activeTask.transfer).toBeNull();

    // 復元が「決着済み」と誤認していないので、遅れて届いたpage.resultが処理される。
    await background.handleAgentResult("task-x", AGENT_SUCCESS);
    expect(background.__getStateForTest().activeTask.agentResult).toBe(AGENT_SUCCESS);
    expect((await background.loadSnapshot()).fileName).toBe("テスト動画");

    // 転送完了が届けば変換が開始できる。
    await background.handleTransferComplete({ type: "audio.transfer.complete", taskId: "task-x", epoch: 0, byteLength: 500 });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "convert.start", taskId: "task-x", fileName: "テスト動画" }),
    );
  });

  test("112: transferring かつ fileName保存済みならagentSettledのみ復元し、転送完了で変換を開始する", async () => {
    const { background, chrome } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ fileName: "保存済み名", audioQuality: "high" }) },
      withOffscreenStatus({ running: true, offscreenState: "transferring", percent: 0, byteLength: 500, format: null, fileName: null }),
    );
    await flush();

    const state = background.__getStateForTest();
    expect(state.activeTask.agentSettled).toBe(true);
    expect(state.activeTask.conversionStarted).toBe(false);
    expect(state.activeTask.transfer).toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "convert.start" }),
    );

    await background.handleTransferComplete({ type: "audio.transfer.complete", taskId: "task-x", epoch: 0, byteLength: 500 });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "convert.start",
      taskId: "task-x",
      format: "mp3",
      audioQuality: "high",
      fileName: "保存済み名",
    });
  });

  test("113: ready(転送完了・変換未開始)なら復元時にそのまま変換を開始する", async () => {
    const { background, chrome } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ state: "converting", fileName: "保存済み名", audioQuality: "best" }) },
      withOffscreenStatus({ running: true, offscreenState: "ready", percent: 0, byteLength: 1000, format: null, fileName: null }),
    );
    await flush();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "convert.start",
      taskId: "task-x",
      format: "mp3",
      audioQuality: "best",
      fileName: "保存済み名",
    });
    expect(background.__getStateForTest().activeTask.conversionStarted).toBe(true);
  });

  test("114: converting(変換中)なら状態だけ復元しconvert.startを再送しない", async () => {
    const { background, chrome } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ state: "converting", fileName: "保存済み名" }) },
      withOffscreenStatus({ running: true, offscreenState: "converting", percent: 40, byteLength: 1000, format: "mp3", fileName: "保存済み名" }),
    );
    await flush();

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "convert.start" }),
    );
    const state = background.__getStateForTest();
    expect(state.activeTaskId).toBe("task-x");
    expect(state.activeTask.conversionStarted).toBe(true);
    expect((await background.loadSnapshot()).state).toBe("converting");
  });

  test("115: done(保存先ディレクトリへ保存済み)ならoutputFileNameでcompletedとして終了させる", async () => {
    const { background, chrome } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ state: "converting", fileName: "保存済み名" }) },
      withOffscreenStatus({
        running: false,
        offscreenState: "done",
        saveMode: "directory",
        percent: 100,
        byteLength: 1000,
        format: "mp3",
        fileName: "保存済み名",
        outputFileName: "保存済み名.mp3",
        pendingDownloadUrl: null,
      }),
    );
    await flush();

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("completed");
    expect(snapshot.fileName).toBe("保存済み名.mp3");
    expect(chrome.downloads.download).not.toHaveBeenCalled();
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });

  test("116: failed(変換失敗済み)ならCONVERT_FAILEDで終了させる", async () => {
    const { background } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ state: "converting", fileName: "保存済み名" }) },
      withOffscreenStatus({ running: false, offscreenState: "failed", percent: 50, byteLength: 1000, format: "mp3", fileName: "保存済み名" }),
    );
    await flush();

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("CONVERT_FAILED");
  });

  test("117: offscreenStateが無い/未知の応答は判別不能としてSW_RESTARTEDへ落とす", async () => {
    const { background } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ state: "converting" }) },
      withOffscreenStatus({ running: false, state: "error", percent: 0, offscreenState: null }),
    );
    await flush();

    expect(background.classifyOffscreenState({ running: true, state: "converting" })).toBeNull();
    expect(background.classifyOffscreenState({ offscreenState: "unknown-state" })).toBeNull();
    expect(background.classifyOffscreenState({ offscreenState: "awaiting-download" })).toBe(
      "awaiting-download",
    );
    expect((await background.loadSnapshot()).code).toBe("SW_RESTARTED");
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });

  test("118: awaiting-download かつ downloadId保存済みなら復元時にsearchで突き合わせて完了させる", async () => {
    const { background, chrome } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ state: "converting", fileName: "保存済み名", downloadId: 5 }) },
      (stub) => {
        withOffscreenStatus(awaitingDownloadStatus())(stub);
        stub.downloadItems.push({ id: 5, state: "complete" });
      },
    );
    await flush();

    expect(chrome.downloads.search).toHaveBeenCalledWith({ id: 5 });
    expect(chrome.downloads.download).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId: "task-x" });
    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("completed");
    expect(snapshot.fileName).toBe("保存済み名.mp3");
  });

  test("119: 復元後もdownloadIdはスナップショット経由で解決でき、onChangedを拾える", async () => {
    const { background, chrome, fireDownloadsChanged } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ state: "converting", fileName: "保存済み名.mp3", downloadId: 5 }) },
      withOffscreenStatus({ running: true, offscreenState: "converting", percent: 90, byteLength: 1000, format: "mp3", fileName: "保存済み名" }),
    );
    await flush();

    await fireDownloadsChanged({ id: 5, state: { previous: "in_progress", current: "complete" } });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId: "task-x" });
    expect((await background.loadSnapshot()).state).toBe("completed");
  });

  /**
   * Downloadsフォルダ保存待ち(awaiting-download)のconvert.status応答を作る。
   * @param {object} [extra] 上書きするフィールド
   * @returns {object} convert.statusの応答本体
   */
  function awaitingDownloadStatus(extra = {}) {
    return {
      running: false,
      offscreenState: "awaiting-download",
      saveMode: "downloads",
      percent: 100,
      byteLength: 1000,
      format: "mp3",
      fileName: "保存済み名",
      outputFileName: "保存済み名.mp3",
      pendingDownloadUrl: "blob:chrome-extension://abc/def",
      ...extra,
    };
  }

  test("124: awaiting-download かつ downloadIdが進行中ならタスクを実行中のまま残し、後のonChangedで完了させる", async () => {
    const { background, chrome, fireDownloadsChanged } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ state: "converting", fileName: "保存済み名", downloadId: 7 }) },
      (stub) => {
        withOffscreenStatus(awaitingDownloadStatus())(stub);
        stub.downloadItems.push({ id: 7, state: "in_progress" });
      },
    );
    await flush();

    expect(chrome.downloads.search).toHaveBeenCalledWith({ id: 7 });
    expect(chrome.downloads.download).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "convert.release" }),
    );
    expect(background.__getStateForTest().activeTaskId).toBe("task-x");
    expect((await background.loadSnapshot()).state).toBe("converting");

    await fireDownloadsChanged({ id: 7, state: { previous: "in_progress", current: "complete" } });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId: "task-x" });
    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("completed");
    expect(snapshot.fileName).toBe("保存済み名.mp3");
  });

  test("125: awaiting-download かつ downloadIdが後からinterruptedになればSAVE_FAILEDで終了する", async () => {
    const { background, chrome, fireDownloadsChanged } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ state: "converting", fileName: "保存済み名", downloadId: 7 }) },
      (stub) => {
        withOffscreenStatus(awaitingDownloadStatus())(stub);
        stub.downloadItems.push({ id: 7, state: "in_progress" });
      },
    );
    await flush();

    await fireDownloadsChanged({
      id: 7,
      state: { previous: "in_progress", current: "interrupted" },
      error: { previous: null, current: "FILE_NO_SPACE" },
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId: "task-x" });
    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SAVE_FAILED");
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });

  test("126: awaiting-download かつ downloadId未保存ならダウンロードをやり直しdownloadIdを永続化する", async () => {
    const { background, chrome } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ state: "converting", fileName: "保存済み名" }) },
      (stub) => {
        withOffscreenStatus(awaitingDownloadStatus())(stub);
        stub.chrome.downloads.download.mockResolvedValue(42);
        stub.downloadItems.push({ id: 42, state: "in_progress" });
      },
    );
    await flush();

    expect(chrome.downloads.download).toHaveBeenCalledWith({
      url: "blob:chrome-extension://abc/def",
      filename: "保存済み名.mp3",
    });
    expect((await background.loadSnapshot()).downloadId).toBe(42);
    expect(background.__getStateForTest().activeTaskId).toBe("task-x");
  });

  test("127: awaiting-download でもpendingDownloadUrlが無ければ即SAVE_FAILEDで終了し、download()も呼ばない", async () => {
    const { background, chrome } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": runningSnapshot({ state: "converting", fileName: "保存済み名" }) },
      withOffscreenStatus(awaitingDownloadStatus({ pendingDownloadUrl: null })),
    );
    await flush();

    expect(chrome.downloads.download).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId: "task-x" });
    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SAVE_FAILED");
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });
});

describe("downloads.checkExists (finding 14: ダウンロードフォルダ同名衝突チェック)", () => {
  test("120: 完了済みの同名ダウンロード履歴があればexists:trueを返す", async () => {
    const { background, chrome } = loadBackgroundModule(undefined, (stub) => {
      stub.downloadItems.push({ id: 1, state: "complete", exists: true, filename: "C:\\Users\\u\\Downloads\\song.mp3" });
    });
    const sendResponse = jest.fn();

    expect(
      background.handleRuntimeMessage({ type: "downloads.checkExists", fileName: "song.mp3" }, {}, sendResponse),
    ).toBe(true);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({ exists: true });
    expect(chrome.downloads.search).toHaveBeenCalledWith({
      filenameRegex: "(^|[\\\\/])song\\.mp3$",
      exists: true,
      state: "complete",
    });
  });

  test("121: 一致する履歴が無ければexists:falseを返す", async () => {
    const { background } = loadBackgroundModule();
    const sendResponse = jest.fn();

    background.handleRuntimeMessage({ type: "downloads.checkExists", fileName: "song.mp3" }, {}, sendResponse);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({ exists: false });
  });

  test("122: ファイル名の正規表現特殊文字はエスケープされ、他ファイルへ誤マッチしない", async () => {
    const { background, chrome } = loadBackgroundModule(undefined, (stub) => {
      // "a.mp3"のような、"a[x]mp3"のドットを1文字ワイルドカードとして誤読すればマッチしてしまう名前。
      stub.downloadItems.push({ id: 1, state: "complete", exists: true, filename: "/home/u/Downloads/aXmp3" });
    });
    const sendResponse = jest.fn();

    background.handleRuntimeMessage({ type: "downloads.checkExists", fileName: "a.mp3" }, {}, sendResponse);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({ exists: false });
    expect(chrome.downloads.search).toHaveBeenCalledWith({
      filenameRegex: "(^|[\\\\/])a\\.mp3$",
      exists: true,
      state: "complete",
    });
  });

  test("123: chrome.downloads.searchが失敗してもexists:falseを返す(通常フローを止めない)", async () => {
    const { background, chrome } = loadBackgroundModule();
    chrome.downloads.search.mockRejectedValueOnce(new Error("boom"));
    const sendResponse = jest.fn();

    background.handleRuntimeMessage({ type: "downloads.checkExists", fileName: "song.mp3" }, {}, sendResponse);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({ exists: false });
  });
});

/**
 * failTask()による失敗の永続化(state:"error"のスナップショット書き込み)と
 * convert.releaseの送信について、jestの呼び出し順序番号を取り出す。
 * @param {object} chrome スタブのchrome
 * @returns {{failPersistOrder: number|undefined, releaseOrder: number|undefined}} 各1回目の順序番号
 */
function failureAndReleaseOrder(chrome) {
  const orderOf = (mock, predicate) => {
    const index = mock.mock.calls.findIndex((call) => predicate(call));
    return index === -1 ? undefined : mock.mock.invocationCallOrder[index];
  };
  return {
    failPersistOrder: orderOf(
      chrome.storage.local.set,
      (call) => call[0]["youtubeAudioDownloader.snapshot"]?.state === "error",
    ),
    releaseOrder: orderOf(chrome.runtime.sendMessage, (call) => call[0]?.type === "convert.release"),
  };
}

/**
 * 失敗の永続化がconvert.releaseより先に行われたことを検査する。
 * @param {object} chrome スタブのchrome
 * @returns {void}
 */
function expectFailurePersistedBeforeRelease(chrome) {
  const { failPersistOrder, releaseOrder } = failureAndReleaseOrder(chrome);
  expect(failPersistOrder).toBeDefined();
  expect(releaseOrder).toBeDefined();
  expect(failPersistOrder).toBeLessThan(releaseOrder);
}

describe("失敗の永続化はconvert.releaseより先(SW再起動時の誤成功リカバリ防止)", () => {
  /**
   * convert.result(downloadUrl付き)まで進めた実行中タスクを作る。
   * @param {object} [options] downloadItemsの初期値やdownloadスタブの調整
   * @returns {Promise<object>} ロード結果とtaskId
   */
  async function startDownloadsFolderSave(options = {}) {
    const loaded = loadBackgroundModule();
    loaded.downloadItems.push(
      ...(Array.isArray(options.downloadItems) ? options.downloadItems : [{ id: 1, state: "in_progress" }]),
    );
    if (options.configureDownload) {
      options.configureDownload(loaded.chrome);
    }
    mockAgentResult(loaded.chrome, AGENT_SUCCESS);
    const accepted = await startTask(loaded.background);
    await loaded.background.handleTransferComplete({
      type: "audio.transfer.complete",
      taskId: accepted.taskId,
      epoch: 0,
      byteLength: 1000,
    });
    await loaded.background.handleConvertResult({
      type: "convert.result",
      taskId: accepted.taskId,
      ok: true,
      fileName: "テスト動画.mp3",
      dirName: null,
      downloadUrl: "blob:chrome-extension://abc/def",
    });
    return { ...loaded, taskId: accepted.taskId };
  }

  test("128: chrome.downloads.downloadのrejectでは失敗を保存してからreleaseする", async () => {
    const { chrome } = await startDownloadsFolderSave({
      configureDownload: (stub) => {
        stub.downloads.download.mockRejectedValueOnce(new Error("download denied"));
      },
    });

    expectFailurePersistedBeforeRelease(chrome);
  });

  test("129: onChangedのinterruptedでは失敗を保存してからreleaseする", async () => {
    const { chrome, fireDownloadsChanged } = await startDownloadsFolderSave();

    await fireDownloadsChanged({
      id: 1,
      state: { previous: "in_progress", current: "interrupted" },
      error: { previous: null, current: "FILE_NO_SPACE" },
    });

    expectFailurePersistedBeforeRelease(chrome);
  });

  test("130: searchで見つけたinterruptedでは失敗を保存してからreleaseする", async () => {
    const { chrome } = await startDownloadsFolderSave({
      downloadItems: [{ id: 1, state: "interrupted", error: "USER_CANCELED" }],
    });

    expectFailurePersistedBeforeRelease(chrome);
  });

  test("131: 復元時にpendingDownloadUrlが無い場合も失敗を保存してからreleaseする", async () => {
    const snapshot = {
      taskId: "task-x",
      sequence: 3,
      state: "converting",
      phase: "convert",
      percent: 100,
      format: "mp3",
      url: VALID_URL,
      fileName: "保存済み名",
      progressMaxByBasis: {},
      timestamp: "t0",
    };
    const { background, chrome } = loadBackgroundModule({ "youtubeAudioDownloader.snapshot": snapshot }, (stub) => {
      stub.contexts.push({ contextType: "OFFSCREEN_DOCUMENT" });
      stub.chrome.runtime.sendMessage.mockImplementation((message) =>
        message.type === "convert.status"
          ? Promise.resolve({
              taskId: message.taskId,
              running: false,
              offscreenState: "awaiting-download",
              outputFileName: "保存済み名.mp3",
              pendingDownloadUrl: null,
            })
          : Promise.resolve(),
      );
    });
    await flush();

    expect((await background.loadSnapshot()).code).toBe("SAVE_FAILED");
    expectFailurePersistedBeforeRelease(chrome);
  });
});

describe("reconcileDownloadStateの有限リトライ(ダウンロード履歴消失対策)", () => {
  const DOWNLOAD_URL = "blob:chrome-extension://abc/def";
  // DOWNLOAD_RECONCILE_DELAYS_MS = [0, 500, 1500, 3000] の合計待ち時間。
  const TOTAL_DELAY_MS = 5000;

  /**
   * convert.result(downloadUrl付き)を投げ、reconcileの完了を待たずに返す。
   * 呼び出し側がフェイクタイマーを進めて再試行を制御する。
   * @param {(stub: object) => void} configure searchスタブ等の調整
   * @returns {Promise<object>} ロード結果・taskId・未解決のconvert.result処理
   */
  async function startReconcile(configure) {
    const loaded = loadBackgroundModule();
    mockAgentResult(loaded.chrome, AGENT_SUCCESS);
    const accepted = await startTask(loaded.background);
    await loaded.background.handleTransferComplete({
      type: "audio.transfer.complete",
      taskId: accepted.taskId,
      epoch: 0,
      byteLength: 1000,
    });
    configure(loaded);
    const pending = loaded.background.handleConvertResult({
      type: "convert.result",
      taskId: accepted.taskId,
      ok: true,
      fileName: "テスト動画.mp3",
      dirName: null,
      downloadUrl: DOWNLOAD_URL,
    });
    return { ...loaded, taskId: accepted.taskId, pending };
  }

  test("132: searchが常に失敗する場合は4回試行してSAVE_FAILED→releaseの順で終了する", async () => {
    jest.useFakeTimers();
    try {
      const { background, chrome, pending } = await startReconcile((loaded) => {
        loaded.chrome.downloads.search.mockRejectedValue(new Error("boom"));
      });

      await jest.advanceTimersByTimeAsync(TOTAL_DELAY_MS);
      await pending;

      expect(chrome.downloads.search).toHaveBeenCalledTimes(4);
      const snapshot = await background.loadSnapshot();
      expect(snapshot.state).toBe("error");
      expect(snapshot.code).toBe("SAVE_FAILED");
      expect(background.__getStateForTest().activeTaskId).toBeNull();
      expectFailurePersistedBeforeRelease(chrome);
    } finally {
      jest.useRealTimers();
    }
  });

  test("133: searchが常に空を返す場合も4回試行してSAVE_FAILED→releaseの順で終了する", async () => {
    jest.useFakeTimers();
    try {
      // downloadItemsは空のまま(=履歴から消えた項目)。
      const { background, chrome, pending } = await startReconcile(() => {});

      await jest.advanceTimersByTimeAsync(TOTAL_DELAY_MS);
      await pending;

      expect(chrome.downloads.search).toHaveBeenCalledTimes(4);
      const snapshot = await background.loadSnapshot();
      expect(snapshot.code).toBe("SAVE_FAILED");
      expectFailurePersistedBeforeRelease(chrome);
    } finally {
      jest.useRealTimers();
    }
  });

  test("134: in_progressを確認できたら再試行せず実行中のまま残す", async () => {
    jest.useFakeTimers();
    try {
      const { background, chrome, pending, taskId } = await startReconcile((loaded) => {
        loaded.downloadItems.push({ id: 1, state: "in_progress" });
      });
      await pending;

      // 1回目(待ち0ms)で確認できるため、タイマーを進めるまでもなく決着している。
      expect(chrome.downloads.search).toHaveBeenCalledTimes(1);
      expect(background.__getStateForTest().activeTaskId).toBe(taskId);
      expect((await background.loadSnapshot()).state).toBe("converting");

      await jest.advanceTimersByTimeAsync(TOTAL_DELAY_MS);

      expect(chrome.downloads.search).toHaveBeenCalledTimes(1);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "convert.release" }),
      );
      expect((await background.loadSnapshot()).state).toBe("converting");
    } finally {
      jest.useRealTimers();
    }
  });

  test("135: 3回目の試行でcompleteを確認できたらそこで完了させる", async () => {
    jest.useFakeTimers();
    try {
      const { background, chrome, pending } = await startReconcile((loaded) => {
        let attempts = 0;
        loaded.chrome.downloads.search.mockImplementation(() => {
          attempts += 1;
          return Promise.resolve(attempts < 3 ? [] : [{ id: 1, state: "complete" }]);
        });
      });

      await jest.advanceTimersByTimeAsync(TOTAL_DELAY_MS);
      await pending;

      expect(chrome.downloads.search).toHaveBeenCalledTimes(3);
      const snapshot = await background.loadSnapshot();
      expect(snapshot.state).toBe("completed");
      expect(background.__getStateForTest().activeTaskId).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("136: 2回目の試行でinterruptedを確認できたらSAVE_FAILED→releaseの順で終了する", async () => {
    jest.useFakeTimers();
    try {
      const { background, chrome, pending } = await startReconcile((loaded) => {
        let attempts = 0;
        loaded.chrome.downloads.search.mockImplementation(() => {
          attempts += 1;
          return Promise.resolve(attempts < 2 ? [] : [{ id: 1, state: "interrupted", error: "FILE_FAILED" }]);
        });
      });

      await jest.advanceTimersByTimeAsync(TOTAL_DELAY_MS);
      await pending;

      expect(chrome.downloads.search).toHaveBeenCalledTimes(2);
      const snapshot = await background.loadSnapshot();
      expect(snapshot.code).toBe("SAVE_FAILED");
      expectFailurePersistedBeforeRelease(chrome);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("page.resultの決着は永続化完了後(agentSettled/agentHandlingの分離)", () => {
  /**
   * page-agentの結果が届かないまま実行中になっているタスクを作る。
   * 結果はテスト側がhandleAgentResult()を直接呼んで届ける。
   * @returns {Promise<object>} ロード結果とtaskId
   */
  async function startWithoutAgentResult() {
    const loaded = loadBackgroundModule();
    loaded.chrome.scripting.executeScript.mockImplementation((injection) =>
      Promise.resolve([
        {
          frameId: 0,
          result:
            injection.world === "MAIN" && typeof injection.func === "function" ? { ok: true } : undefined,
        },
      ]),
    );
    const accepted = await startTask(loaded.background);
    return { ...loaded, taskId: accepted.taskId };
  }

  /**
   * fileNameを書き込むスナップショット保存だけを手動で解放できるようにする。
   * @param {object} chrome スタブのchrome
   * @returns {{release: () => void, count: () => number}} 解放関数と保留した書き込み回数
   */
  function gateFileNameWrite(chrome) {
    let release = null; // () => void
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let count = 0;
    const passthrough = chrome.storage.local.set.getMockImplementation();
    chrome.storage.local.set.mockImplementation((obj) => {
      if (typeof obj["youtubeAudioDownloader.snapshot"]?.fileName === "string") {
        count += 1;
        return gate.then(() => passthrough(obj));
      }
      return passthrough(obj);
    });
    return { release: () => release(), count: () => count };
  }

  test("137: 永続化が完了するまでagentSettledを立てず、変換も開始しない", async () => {
    const { background, chrome, taskId } = await startWithoutAgentResult();
    const gate = gateFileNameWrite(chrome);

    const pending = background.handleAgentResult(taskId, AGENT_SUCCESS);
    await flush();

    const midway = background.__getStateForTest().activeTask;
    expect(midway.agentHandling).toBe(true);
    expect(midway.agentSettled).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "convert.start" }),
    );

    gate.release();
    await pending;

    const settled = background.__getStateForTest().activeTask;
    expect(settled.agentSettled).toBe(true);
    expect(settled.fileName).toBe("テスト動画");
    expect((await background.loadSnapshot()).fileName).toBe("テスト動画");
  });

  test("138: 永続化の最中に届いた2通目のpage.resultはagentHandlingで無視される", async () => {
    const { background, chrome, taskId } = await startWithoutAgentResult();
    const gate = gateFileNameWrite(chrome);

    const first = background.handleAgentResult(taskId, AGENT_SUCCESS);
    await flush();
    await background.handleAgentResult(taskId, AGENT_SUCCESS);

    expect(gate.count()).toBe(1);

    gate.release();
    await first;
    await background.handleTransferComplete({
      type: "audio.transfer.complete",
      taskId,
      epoch: 0,
      byteLength: 1000,
    });

    expect(gate.count()).toBe(1);
    expect(
      chrome.runtime.sendMessage.mock.calls.filter((call) => call[0]?.type === "convert.start"),
    ).toHaveLength(1);
  });

  test("139: persistSnapshotFieldsは書き込めたかどうかをbooleanで返す", async () => {
    const { background, taskId } = await startWithoutAgentResult();

    expect(await background.persistSnapshotFields(taskId, { fileName: "名前" })).toBe(true);
    expect(await background.persistSnapshotFields("task-other", { fileName: "別名" })).toBe(false);
    expect((await background.loadSnapshot()).fileName).toBe("名前");
  });
});

describe("古いタスクの継続処理が現在のタスクを巻き添えにしない", () => {
  /**
   * 実行中の「新しい」タスクを1つ持つ状態を作る。
   * @param {(stub: object) => void} [configure] require前にスタブを調整する関数
   * @returns {Promise<object>} ロード結果と実行中タスクのtaskId
   */
  async function startFreshTask(configure) {
    const loaded = loadBackgroundModule({}, configure);
    loaded.chrome.scripting.executeScript.mockImplementation((injection) =>
      Promise.resolve([
        {
          frameId: 0,
          result:
            injection.world === "MAIN" && typeof injection.func === "function" ? { ok: true } : undefined,
        },
      ]),
    );
    const accepted = await startTask(loaded.background);
    return { ...loaded, taskId: accepted.taskId };
  }

  test("140: download()のrejectが古いタスクのものなら、releaseだけ送り現在のタスクは失敗させない", async () => {
    const { background, chrome, taskId } = await startFreshTask((stub) => {
      stub.chrome.downloads.download.mockRejectedValue(new Error("download denied"));
    });
    chrome.runtime.sendMessage.mockClear();

    await background.downloadToDownloadsFolder("task-stale", "blob:chrome-extension://abc/def", "旧.mp3");

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "convert.release",
      taskId: "task-stale",
    });
    expect(background.__getStateForTest().activeTaskId).toBe(taskId);
    expect((await background.loadSnapshot()).state).not.toBe("error");
  });

  test("141: download()が数値以外を返した場合も、古いタスクならreleaseだけ送る", async () => {
    const { background, chrome, taskId } = await startFreshTask((stub) => {
      stub.chrome.downloads.download.mockResolvedValue(undefined);
    });
    chrome.runtime.sendMessage.mockClear();

    await background.downloadToDownloadsFolder("task-stale", "blob:chrome-extension://abc/def", "旧.mp3");

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "convert.release",
      taskId: "task-stale",
    });
    expect(background.__getStateForTest().activeTaskId).toBe(taskId);
    expect((await background.loadSnapshot()).state).not.toBe("error");
  });

  test("142: 現在のタスク自身のdownload()が数値以外を返した場合はSAVE_FAILEDで終了する", async () => {
    const { background, chrome, taskId } = await startFreshTask((stub) => {
      stub.chrome.downloads.download.mockResolvedValue(undefined);
    });

    await background.downloadToDownloadsFolder(taskId, "blob:chrome-extension://abc/def", "現行.mp3");

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId });
    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SAVE_FAILED");
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });

  test("143: resumePendingDownloadは実行中タスクと一致しないtaskIdでは何もしない", async () => {
    const { background, chrome, taskId } = await startFreshTask();
    chrome.runtime.sendMessage.mockClear();

    await background.resumePendingDownload("task-stale", { pendingDownloadUrl: null });
    await background.resumePendingDownload("task-stale", {
      pendingDownloadUrl: "blob:chrome-extension://abc/def",
      outputFileName: "旧.mp3",
    });

    expect(chrome.downloads.download).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "convert.release" }),
    );
    expect(background.__getStateForTest().activeTaskId).toBe(taskId);
    expect((await background.loadSnapshot()).state).not.toBe("error");
  });
});

describe("handleAgentResultが決着できない場合は明示的に失敗させる", () => {
  /**
   * page-agentの結果が届かないまま実行中になっているタスクを作る。
   * @returns {Promise<object>} ロード結果とtaskId
   */
  async function startWithoutAgentResult() {
    const loaded = loadBackgroundModule();
    loaded.chrome.scripting.executeScript.mockImplementation((injection) =>
      Promise.resolve([
        {
          frameId: 0,
          result:
            injection.world === "MAIN" && typeof injection.func === "function" ? { ok: true } : undefined,
        },
      ]),
    );
    const accepted = await startTask(loaded.background);
    return { ...loaded, taskId: accepted.taskId };
  }

  test("144: 永続化できなかった場合はSW_RESTARTEDで終了させる", async () => {
    const { background, chrome, storage, taskId } = await startWithoutAgentResult();
    // スナップショットが読めない状態にし、persistSnapshotFieldsをfalseへ落とす。
    chrome.storage.local.get.mockImplementation(() => Promise.resolve({}));

    await background.handleAgentResult(taskId, AGENT_SUCCESS);

    const snapshot = storage["youtubeAudioDownloader.snapshot"];
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SW_RESTARTED");
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });

  test("145: 処理中に例外が出た場合もSW_RESTARTEDで終了させる", async () => {
    const { background, chrome, storage, taskId } = await startWithoutAgentResult();
    const passthrough = chrome.storage.local.set.getMockImplementation();
    chrome.storage.local.set.mockImplementation((obj) => {
      if (typeof obj["youtubeAudioDownloader.snapshot"]?.fileName === "string") {
        return Promise.reject(new Error("storage write failed"));
      }
      return passthrough(obj);
    });

    await background.handleAgentResult(taskId, AGENT_SUCCESS);

    const snapshot = storage["youtubeAudioDownloader.snapshot"];
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SW_RESTARTED");
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });

  test("146: 例外時に既に別タスクへ切り替わっていれば、新しいタスクは失敗させない", async () => {
    const { background, chrome, taskId } = await startWithoutAgentResult();
    let releaseWrite = null; // () => void
    const writeGate = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const passthrough = chrome.storage.local.set.getMockImplementation();
    chrome.storage.local.set.mockImplementation((obj) => {
      if (typeof obj["youtubeAudioDownloader.snapshot"]?.fileName === "string") {
        return writeGate.then(() => {
          throw new Error("storage write failed");
        });
      }
      return passthrough(obj);
    });

    const stale = background.handleAgentResult(taskId, AGENT_SUCCESS);
    await flush();

    // 保留中のまま旧タスクを終わらせ、新しいタスクを開始する。
    await background.failTask("CONVERT_FAILED", "打ち切り");
    const accepted = await startTask(background, { requestId: "r2" });

    releaseWrite();
    await stale;

    expect(background.__getStateForTest().activeTaskId).toBe(accepted.taskId);
    expect((await background.loadSnapshot()).state).not.toBe("error");
  });

  test("147: 正常に永続化できた場合は従来どおり決着し、失敗させない", async () => {
    const { background, taskId } = await startWithoutAgentResult();

    await background.handleAgentResult(taskId, AGENT_SUCCESS);

    const state = background.__getStateForTest();
    expect(state.activeTaskId).toBe(taskId);
    expect(state.activeTask.agentSettled).toBe(true);
    expect((await background.loadSnapshot()).state).not.toBe("error");
  });
});

describe("転送中のまま停滞したタスクの有限時間での失敗(SW再起動復帰)", () => {
  /**
   * convert.statusへ固定の応答を返すOffscreenを用意する。
   * @param {object} response 応答本体(taskIdは自動で補う)
   * @returns {(stub: object) => void} loadBackgroundModuleのconfigure関数
   */
  function withOffscreenStatus(response) {
    return (stub) => {
      stub.contexts.push({ contextType: "OFFSCREEN_DOCUMENT" });
      stub.chrome.runtime.sendMessage.mockImplementation((message) => {
        if (message.type === "convert.status") {
          return Promise.resolve({ taskId: message.taskId, ...response });
        }
        return Promise.resolve();
      });
    };
  }

  const TRANSFERRING_STATUS = {
    running: true,
    offscreenState: "transferring",
    percent: 0,
    byteLength: 500,
    format: null,
    fileName: null,
  };

  /**
   * 転送中で決着していない(fileName未保存の)実行中スナップショットを作る。
   * @param {string|undefined} timestamp スナップショットの更新時刻
   * @returns {object} TaskSnapshot
   */
  function transferringSnapshot(timestamp) {
    return {
      taskId: "task-x",
      sequence: 3,
      state: "downloading",
      phase: "download",
      percent: 10,
      format: "mp3",
      url: VALID_URL,
      progressMaxByBasis: {},
      timestamp,
    };
  }

  test("148: 停滞閾値を超えたtransferringはSW_RESTARTEDで終了しreleaseも送る", async () => {
    const stale = new Date(Date.now() - 121 * 1000).toISOString();
    const { background, chrome } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": transferringSnapshot(stale) },
      withOffscreenStatus(TRANSFERRING_STATUS),
    );
    await flush();

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SW_RESTARTED");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId: "task-x" });
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });

  test("149: timestampが無い/解釈できない場合も停滞として扱う", async () => {
    for (const timestamp of [undefined, "t0"]) {
      const { background } = loadBackgroundModule(
        { "youtubeAudioDownloader.snapshot": transferringSnapshot(timestamp) },
        withOffscreenStatus(TRANSFERRING_STATUS),
      );
      await flush();

      expect((await background.loadSnapshot()).code).toBe("SW_RESTARTED");
    }
  });

  test("150: 直近まで進捗があったtransferringは従来どおりpage.resultを待つ", async () => {
    const { background, chrome } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": transferringSnapshot(new Date().toISOString()) },
      withOffscreenStatus(TRANSFERRING_STATUS),
    );
    await flush();

    expect(background.__getStateForTest().activeTaskId).toBe("task-x");
    expect((await background.loadSnapshot()).state).toBe("downloading");
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "convert.release" }),
    );
  });

  test("151: fileName保存済み(決着済み)なら停滞判定の対象にしない", async () => {
    const { background } = loadBackgroundModule(
      { "youtubeAudioDownloader.snapshot": { ...transferringSnapshot("t0"), fileName: "保存済み名" } },
      withOffscreenStatus(TRANSFERRING_STATUS),
    );
    await flush();

    expect(background.__getStateForTest().activeTaskId).toBe("task-x");
    expect((await background.loadSnapshot()).state).toBe("downloading");
  });

  test("152: 既に終端のスナップショットでも復元時にreleaseを送って残留リソースを解放する", async () => {
    const completedSnapshot = {
      taskId: "task-y",
      sequence: 9,
      state: "completed",
      phase: "done",
      percent: 100,
      format: "mp3",
      url: VALID_URL,
      progressMaxByBasis: {},
      timestamp: "t0",
    };
    const { background, chrome } = loadBackgroundModule({ "youtubeAudioDownloader.snapshot": completedSnapshot });
    await flush();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId: "task-y" });
    expect(await background.loadSnapshot()).toEqual(completedSnapshot);
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });
});

describe("reconcileDownloadStateは未知のstateを進行中とみなさない", () => {
  const DOWNLOAD_URL = "blob:chrome-extension://abc/def";
  // DOWNLOAD_RECONCILE_DELAYS_MS = [0, 500, 1500, 3000] の合計待ち時間。
  const TOTAL_DELAY_MS = 5000;

  /**
   * convert.result(downloadUrl付き)を投げ、reconcileの完了を待たずに返す。
   * @param {(loaded: object) => void} configure downloadItems等の調整
   * @returns {Promise<object>} ロード結果・taskId・未解決のconvert.result処理
   */
  async function startReconcile(configure) {
    const loaded = loadBackgroundModule();
    mockAgentResult(loaded.chrome, AGENT_SUCCESS);
    const accepted = await startTask(loaded.background);
    await loaded.background.handleTransferComplete({
      type: "audio.transfer.complete",
      taskId: accepted.taskId,
      epoch: 0,
      byteLength: 1000,
    });
    configure(loaded);
    const pending = loaded.background.handleConvertResult({
      type: "convert.result",
      taskId: accepted.taskId,
      ok: true,
      fileName: "テスト動画.mp3",
      dirName: null,
      downloadUrl: DOWNLOAD_URL,
    });
    return { ...loaded, taskId: accepted.taskId, pending };
  }

  test("153: 未知のstateのままなら再試行し尽くしてSAVE_FAILED→releaseで終了する", async () => {
    jest.useFakeTimers();
    try {
      const { background, chrome, pending } = await startReconcile((loaded) => {
        loaded.downloadItems.push({ id: 1, state: "unknown_state" });
      });

      await jest.advanceTimersByTimeAsync(TOTAL_DELAY_MS);
      await pending;

      expect(chrome.downloads.search).toHaveBeenCalledTimes(4);
      const snapshot = await background.loadSnapshot();
      expect(snapshot.state).toBe("error");
      expect(snapshot.code).toBe("SAVE_FAILED");
      expect(background.__getStateForTest().activeTaskId).toBeNull();
      expectFailurePersistedBeforeRelease(chrome);
    } finally {
      jest.useRealTimers();
    }
  });

  test("154: stateが欠落した項目も再試行対象とし、途中でcompleteになれば完了させる", async () => {
    jest.useFakeTimers();
    try {
      const { background, chrome, pending } = await startReconcile((loaded) => {
        let attempts = 0;
        loaded.chrome.downloads.search.mockImplementation(() => {
          attempts += 1;
          return Promise.resolve(attempts < 3 ? [{ id: 1 }] : [{ id: 1, state: "complete" }]);
        });
      });

      await jest.advanceTimersByTimeAsync(TOTAL_DELAY_MS);
      await pending;

      expect(chrome.downloads.search).toHaveBeenCalledTimes(3);
      expect((await background.loadSnapshot()).state).toBe("completed");
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * page-agentの結果がまだ届いていない実行中タスクを1つ持つ状態を作る。
 * executeScriptは注入に成功するだけで、page.result相当は一切配送しない。
 * @returns {Promise<object>} ロード結果とtaskId
 */
async function startPendingAgentTask() {
  const loaded = loadBackgroundModule();
  loaded.chrome.scripting.executeScript.mockImplementation((injection) =>
    Promise.resolve([
      {
        frameId: 0,
        result:
          injection.world === "MAIN" && typeof injection.func === "function" ? { ok: true } : undefined,
      },
    ]),
  );
  const accepted = await startTask(loaded.background);
  return { ...loaded, taskId: accepted.taskId };
}

describe("failTask自体が失敗してもタスクは実行中のまま残らない", () => {
  test("155: failTaskが投げてもストレージ読み出し無しのフォールバックで終端させる", async () => {
    const { background, chrome, storage, taskId } = await startPendingAgentTask();
    const passthroughGet = chrome.storage.local.get.getMockImplementation();
    chrome.storage.local.get.mockRejectedValue(new Error("storage read failed"));
    chrome.runtime.sendMessage.mockClear();

    await background.handleAgentResult(taskId, AGENT_SUCCESS);

    const snapshot = storage["youtubeAudioDownloader.snapshot"];
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SW_RESTARTED");
    expect(snapshot.taskId).toBe(taskId);
    // 結果はPopupへも転送される。
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining(snapshot));
    expect(background.__getStateForTest().activeTaskId).toBeNull();

    // 以後のdownload.startがTASK_ALREADY_RUNNINGで弾かれないこと。
    chrome.storage.local.get.mockImplementation(passthroughGet);
    const accepted = await startTask(background, { requestId: "r2" });
    expect(accepted.type).toBe("download.accepted");
  });

  test("156: 読み書きとも失敗する場合でもメモリ上の実行中状態は解除される", async () => {
    const { background, chrome, taskId } = await startPendingAgentTask();
    const passthroughGet = chrome.storage.local.get.getMockImplementation();
    const passthroughSet = chrome.storage.local.set.getMockImplementation();
    chrome.storage.local.get.mockRejectedValue(new Error("storage read failed"));
    chrome.storage.local.set.mockRejectedValue(new Error("storage write failed"));

    await background.handleAgentResult(taskId, AGENT_SUCCESS);

    expect(background.__getStateForTest().activeTaskId).toBeNull();
    expect(background.__getStateForTest().activeTask).toBeNull();

    chrome.storage.local.get.mockImplementation(passthroughGet);
    chrome.storage.local.set.mockImplementation(passthroughSet);
    const accepted = await startTask(background, { requestId: "r2" });
    expect(accepted.type).toBe("download.accepted");
    expect(accepted.taskId).not.toBe(taskId);
  });

  test("157: フォールバックの結果組み立て自体が投げてもfinally節が実行中状態を解除する", async () => {
    const { background, chrome, taskId } = await startPendingAgentTask();
    const passthroughGet = chrome.storage.local.get.getMockImplementation();
    const passthroughMessage = chrome.i18n.getMessage.getMockImplementation();
    chrome.storage.local.get.mockRejectedValue(new Error("storage read failed"));
    // buildErrorResult()内のメッセージ解決で投げさせ、finishTaskへ到達させない。
    chrome.i18n.getMessage.mockImplementation(() => {
      throw new Error("i18n unavailable");
    });

    await background.handleAgentResult(taskId, AGENT_SUCCESS);

    expect(background.__getStateForTest().activeTaskId).toBeNull();
    expect(background.__getStateForTest().activeTask).toBeNull();
    expect(background.__getStateForTest().lastSequence).toBe(-1);

    chrome.storage.local.get.mockImplementation(passthroughGet);
    chrome.i18n.getMessage.mockImplementation(passthroughMessage);
    const accepted = await startTask(background, { requestId: "r2" });
    expect(accepted.type).toBe("download.accepted");
  });
});

describe("転送完了後に結果が届かないままの猶予切れを検知する", () => {
  // AGENT_RESULT_GRACE_MS と同値。
  const GRACE_MS = 30 * 1000;

  test("158: 猶予時間を過ぎても決着しなければSW_RESTARTEDで終了しreleaseも送る", async () => {
    jest.useFakeTimers();
    try {
      const { background, chrome, taskId } = await startPendingAgentTask();
      await background.handleTransferComplete({
        type: "audio.transfer.complete",
        taskId,
        epoch: 0,
        byteLength: 1000,
      });
      chrome.runtime.sendMessage.mockClear();

      expect(background.__getStateForTest().activeTaskId).toBe(taskId);
      await jest.advanceTimersByTimeAsync(GRACE_MS);

      const snapshot = await background.loadSnapshot();
      expect(snapshot.state).toBe("error");
      expect(snapshot.code).toBe("SW_RESTARTED");
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId });
      expect(background.__getStateForTest().activeTaskId).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("159: 猶予内に結果が届けば通常どおり変換へ進み、後から発火するタイマーは無害", async () => {
    jest.useFakeTimers();
    try {
      const { background, chrome, taskId } = await startPendingAgentTask();
      await background.handleTransferComplete({
        type: "audio.transfer.complete",
        taskId,
        epoch: 0,
        byteLength: 1000,
      });

      await jest.advanceTimersByTimeAsync(GRACE_MS / 2);
      await background.handleAgentResult(taskId, AGENT_SUCCESS);
      expect(background.__getStateForTest().activeTask.conversionStarted).toBe(true);
      chrome.runtime.sendMessage.mockClear();

      await jest.advanceTimersByTimeAsync(GRACE_MS);

      expect(background.__getStateForTest().activeTaskId).toBe(taskId);
      expect((await background.loadSnapshot()).state).toBe("converting");
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "convert.release" }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test("161: 猶予切れ処理自体のfailTaskが失敗してもreleaseは送られ実行中状態も解除される", async () => {
    jest.useFakeTimers();
    try {
      const { background, chrome, taskId } = await startPendingAgentTask();
      await background.handleTransferComplete({
        type: "audio.transfer.complete",
        taskId,
        epoch: 0,
        byteLength: 1000,
      });
      chrome.runtime.sendMessage.mockClear();
      const passthroughGet = chrome.storage.local.get.getMockImplementation();
      chrome.storage.local.get.mockRejectedValue(new Error("storage read failed"));

      await jest.advanceTimersByTimeAsync(GRACE_MS);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId });
      expect(background.__getStateForTest().activeTaskId).toBeNull();
      expect(background.__getStateForTest().activeTask).toBeNull();

      chrome.storage.local.get.mockImplementation(passthroughGet);
      const accepted = await startTask(background, { requestId: "r2" });
      expect(accepted.type).toBe("download.accepted");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("未来日時のtimestampも停滞として扱う(時刻巻き戻し対策)", () => {
  test("160: TRANSFER_STALL_RECOVERY_MSより未来のtimestampはSW_RESTARTEDで終了させる", async () => {
    const future = new Date(Date.now() + 121 * 1000).toISOString();
    const { background, chrome } = loadBackgroundModule(
      {
        "youtubeAudioDownloader.snapshot": {
          taskId: "task-x",
          sequence: 3,
          state: "downloading",
          phase: "download",
          percent: 10,
          format: "mp3",
          url: VALID_URL,
          progressMaxByBasis: {},
          timestamp: future,
        },
      },
      (stub) => {
        stub.contexts.push({ contextType: "OFFSCREEN_DOCUMENT" });
        stub.chrome.runtime.sendMessage.mockImplementation((message) => {
          if (message.type === "convert.status") {
            return Promise.resolve({
              taskId: message.taskId,
              running: true,
              offscreenState: "transferring",
              percent: 0,
              byteLength: 500,
              format: null,
              fileName: null,
            });
          }
          return Promise.resolve();
        });
      },
    );
    await flush();

    const snapshot = await background.loadSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.code).toBe("SW_RESTARTED");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "convert.release", taskId: "task-x" });
    expect(background.__getStateForTest().activeTaskId).toBeNull();
  });
});
