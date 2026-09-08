/**
 * @jest-environment node
 */
// convert.test.mjs
// convertAudioの中断(AbortSignal)と失敗時ロールバックを検証する。
// mediabunny / wasm-media-encoders はモジュールモックへ差し替え、
//   - 中断時にConversion.cancel()が呼ばれCONVERT_STALLEDで失敗すること
//   - 変換失敗・finish()失敗のいずれでもOutput.cancel()とdestination.discard()が走ること
//   - vorbisパイプラインがサンプル単位で中断を検出すること
//   - 書き込み1件ごとにonActivity(監視タイマーの張り直し)が呼ばれること
// を確認する。

import { jest } from "@jest/globals";

/** テストから変換の進み方を制御するためのフック。各テストの冒頭でresetHooks()する。 */
const hooks = {
  /** @type {object[]} 生成されたConversionインスタンス */
  conversions: [],
  /** @type {object[]} 生成されたOutputインスタンス */
  outputs: [],
  /** @type {WritableStream|null} StreamTargetへ渡されたストリーム */
  streamWritable: null,
  /** @type {(conversion: object) => Promise<void>} execute()の実装 */
  executeImpl: async () => {},
  /** @type {boolean} Conversion.isValidの値 */
  isValid: true,
  /** @type {object[]} vorbisパイプラインへ流すサンプル */
  samples: [],
  /** @type {object[]} 生成されたInputインスタンス */
  inputs: [],
  /** @type {Promise<void>|null} getPrimaryAudioTrack()を待たせるゲート */
  primaryTrackGate: null,
};

/**
 * フックを初期状態へ戻す。
 * @returns {void}
 */
function resetHooks() {
  hooks.conversions = [];
  hooks.outputs = [];
  hooks.streamWritable = null;
  hooks.executeImpl = async () => {};
  hooks.isValid = true;
  hooks.samples = [];
  hooks.inputs = [];
  hooks.primaryTrackGate = null;
}

jest.unstable_mockModule("mediabunny", () => {
  class FakeInput {
    constructor(options) {
      this.options = options;
      this.dispose = jest.fn();
      hooks.inputs.push(this);
    }
    async getPrimaryAudioTrack() {
      if (hooks.primaryTrackGate !== null) {
        await hooks.primaryTrackGate;
      }
      return {
        async getCodec() {
          return "opus";
        },
        async getNumberOfChannels() {
          return 2;
        },
        async getSampleRate() {
          return 48000;
        },
      };
    }
    async getDurationFromMetadata() {
      return 10;
    }
    async computeDuration() {
      return 10;
    }
  }

  class FakeOutput {
    constructor(options) {
      this.options = options;
      this.cancel = jest.fn(async () => {});
      hooks.outputs.push(this);
    }
  }

  class FakeStreamTarget {
    constructor(writable) {
      hooks.streamWritable = writable;
    }
  }

  class FakeConversion {
    constructor() {
      this.isValid = hooks.isValid;
      this.onProgress = undefined;
      this.canceled = false;
      this.cancel = jest.fn(async () => {
        this.canceled = true;
        if (this.rejectExecute !== null) {
          this.rejectExecute(new Error("Conversion canceled"));
        }
      });
      this.rejectExecute = null;
    }
    static async init() {
      const conversion = new FakeConversion();
      hooks.conversions.push(conversion);
      return conversion;
    }
    execute() {
      return Promise.race([
        hooks.executeImpl(this),
        new Promise((resolve, reject) => {
          this.rejectExecute = reject;
        }),
      ]);
    }
  }

  class FakeAudioSampleSink {
    constructor(track) {
      this.track = track;
    }
    async *samples() {
      for (const sample of hooks.samples) {
        yield sample;
      }
    }
  }

  /**
   * OutputFormat/入力形式の代用となる最小クラス・値。
   * @returns {object} ダミー
   */
  const dummy = () => ({});

  return {
    ADTS: "adts",
    MATROSKA: "matroska",
    MP3: "mp3",
    MP4: "mp4",
    OGG: "ogg",
    WAVE: "wave",
    WEBM: "webm",
    FLAC: "flac",
    AdtsOutputFormat: class {},
    FlacOutputFormat: class {},
    Mp3OutputFormat: class {},
    Mp4OutputFormat: class {},
    OggOutputFormat: class {},
    WavOutputFormat: class {},
    Quality: class {},
    BlobSource: class {},
    Input: FakeInput,
    Output: FakeOutput,
    StreamTarget: FakeStreamTarget,
    Conversion: FakeConversion,
    AudioSampleSink: FakeAudioSampleSink,
    canEncodeAudio: async () => true,
    dummy,
  };
});

jest.unstable_mockModule("@mediabunny/mp3-encoder", () => ({ registerMp3Encoder: jest.fn() }));
jest.unstable_mockModule("@mediabunny/flac-encoder", () => ({ registerFlacEncoder: jest.fn() }));
jest.unstable_mockModule("wasm-media-encoders", () => ({
  createOggEncoder: async () => ({
    configure: jest.fn(),
    encode: () => new Uint8Array([1, 2, 3, 4]),
    finalize: () => new Uint8Array([5, 6]),
  }),
}));

const { convertAudio } = await import("./convert.mjs");
const { CONVERT_FAILED, CONVERT_STALLED, SAVE_FAILED, SAVE_PERMISSION_DENIED } = await import(
  "./errors.mjs"
);

/**
 * 書き出し先スタブを作る。
 * @param {{finishError?: Error, openError?: Error}} [options] 失敗の注入
 * @returns {object} destinationスタブ
 */
function createDestination(options = {}) {
  const calls = { open: 0, finish: 0, discard: 0 };
  /** @type {unknown[]} 書き込まれたチャンク */
  const chunks = [];
  const writable = new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  return {
    skipped: false,
    fileName: "song.mp3",
    dirName: null,
    calls,
    chunks,
    async open() {
      calls.open += 1;
      if (options.openError) {
        throw options.openError;
      }
      return writable;
    },
    async finish() {
      calls.finish += 1;
      if (options.finishError) {
        throw options.finishError;
      }
      return { fileName: "song.mp3", dirName: null };
    },
    async discard() {
      calls.discard += 1;
    },
  };
}

/**
 * convertAudioを起動する。
 * @param {object} destination 書き出し先スタブ
 * @param {{format?: string, signal?: AbortSignal, onActivity?: () => void,
 *   onProgress?: Function, destinationFor?: Function}} [options] 実行条件
 * @returns {Promise<object>} 変換結果
 */
function runConvert(destination, options = {}) {
  return convertAudio(
    { file: { name: "input.webm" }, format: options.format ?? "mp3", audioQuality: "standard" },
    {
      destinationFor: options.destinationFor ?? (async () => destination),
      onProgress: options.onProgress ?? (() => {}),
      signal: options.signal ?? null,
      onActivity: options.onActivity,
    },
  );
}

/**
 * 保留中のマイクロタスクを全て消化する(マクロタスクを1つ挟む)。
 * @returns {Promise<void>}
 */
function flush() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  resetHooks();
});

describe("mediabunnyパイプライン", () => {
  test("成功時はfinish()の結果を返す", async () => {
    const destination = createDestination();
    hooks.executeImpl = async (conversion) => {
      conversion.onProgress(0.5, 5);
    };

    await expect(runConvert(destination)).resolves.toMatchObject({
      skipped: false,
      fileName: "song.mp3",
      dirName: null,
    });
    expect(destination.calls.discard).toBe(0);
  });

  test("中断されるとConversion.cancel()を呼びCONVERT_STALLEDで失敗する", async () => {
    const destination = createDestination();
    const controller = new AbortController();
    hooks.executeImpl = () => new Promise(() => {});

    const promise = runConvert(destination, { signal: controller.signal });
    await flush();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: CONVERT_STALLED });
    await flush();
    expect(hooks.conversions[0].cancel).toHaveBeenCalled();
    expect(hooks.outputs[0].cancel).toHaveBeenCalled();
    expect(destination.calls.discard).toBe(1);
  });

  test("変換失敗時はOutput.cancel()とdiscard()が走りCONVERT_FAILEDになる", async () => {
    const destination = createDestination();
    hooks.executeImpl = async () => {
      throw new Error("encoder exploded");
    };

    await expect(runConvert(destination)).rejects.toMatchObject({
      code: CONVERT_FAILED,
      message: "encoder exploded",
    });
    expect(hooks.outputs[0].cancel).toHaveBeenCalled();
    expect(destination.calls.discard).toBe(1);
  });

  test("finish()の失敗でもdiscard()で書きかけを消す", async () => {
    const destination = createDestination({ finishError: new Error("close failed") });

    await expect(runConvert(destination)).rejects.toMatchObject({
      code: SAVE_FAILED,
      message: "close failed",
    });
    expect(destination.calls.finish).toBe(1);
    expect(destination.calls.discard).toBe(1);
  });

  test("open()の失敗でもdiscard()を呼ぶ", async () => {
    const destination = createDestination({ openError: new Error("locked") });

    await expect(runConvert(destination)).rejects.toMatchObject({ code: SAVE_FAILED, message: "locked" });
    expect(destination.calls.discard).toBe(1);
  });

  test("書き込み1件ごとにonActivityが呼ばれる", async () => {
    const destination = createDestination();
    const onActivity = jest.fn();
    hooks.executeImpl = async () => {
      const writer = hooks.streamWritable.getWriter();
      await writer.write({ type: "write", data: new Uint8Array([1]), position: 0 });
      await writer.write({ type: "write", data: new Uint8Array([2]), position: 1 });
      writer.releaseLock();
    };

    await runConvert(destination, { onActivity });
    expect(onActivity).toHaveBeenCalledTimes(2);
    expect(destination.chunks).toHaveLength(2);
  });
});

describe("変換前の段取り(prelude)の中断", () => {
  test("openAudioInputが固まったまま中断されるとCONVERT_STALLEDで失敗する", async () => {
    /** @type {() => void} ゲートの解放関数 */
    let release = () => {};
    hooks.primaryTrackGate = new Promise((resolve) => {
      release = resolve;
    });
    const destination = createDestination();
    const controller = new AbortController();

    const promise = runConvert(destination, { signal: controller.signal });
    await flush();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: CONVERT_STALLED });
    expect(destination.calls.open).toBe(0);

    // 遅れて解決した入力の資源が取り残されないこと。
    release();
    await flush();
    expect(hooks.inputs[0].dispose).toHaveBeenCalled();
  });

  test("destinationForが固まったまま中断されるとCONVERT_STALLEDで失敗し、開いた入力を破棄する", async () => {
    const controller = new AbortController();

    const promise = runConvert(createDestination(), {
      signal: controller.signal,
      destinationFor: () => new Promise(() => {}),
    });
    await flush();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: CONVERT_STALLED });
    expect(hooks.inputs[0].dispose).toHaveBeenCalled();
  });

  test("destinationForが自前のcodeで失敗した場合はそのcodeをそのまま返す", async () => {
    const denied = new Error("保存先フォルダへの書き込み許可がありません");
    denied.code = SAVE_PERMISSION_DENIED;

    await expect(
      runConvert(createDestination(), {
        destinationFor: async () => {
          throw denied;
        },
      }),
    ).rejects.toMatchObject({ code: SAVE_PERMISSION_DENIED });
    expect(hooks.inputs[0].dispose).toHaveBeenCalled();
  });
});

describe("vorbisパイプライン", () => {
  /**
   * AudioSampleSinkが返すサンプルのスタブを作る。
   * @param {number} index サンプル番号
   * @returns {object} サンプル
   */
  function createSample(index) {
    return {
      numberOfFrames: 2,
      timestamp: index,
      duration: 1,
      copyTo: jest.fn(),
      close: jest.fn(),
    };
  }

  test("サンプル単位で中断を検出しCONVERT_STALLEDで失敗する", async () => {
    const destination = createDestination();
    const controller = new AbortController();
    hooks.samples = [createSample(0), createSample(1)];

    const promise = runConvert(destination, {
      format: "vorbis",
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    await expect(promise).rejects.toMatchObject({ code: CONVERT_STALLED });
    expect(hooks.samples[1].close).toHaveBeenCalled();
    expect(destination.calls.discard).toBe(1);
  });

  test("中断が無ければ最後まで書き出してfinish()する", async () => {
    const destination = createDestination();
    hooks.samples = [createSample(0)];

    await expect(runConvert(destination, { format: "vorbis" })).resolves.toMatchObject({ skipped: false });
    expect(destination.calls.discard).toBe(0);
    expect(destination.chunks.length).toBeGreaterThan(0);
  });
});
