// convert.mjs
// Mediabunny(Input/Conversion)による音声変換パイプライン。
// mp3/aac/m4a/opus/wav/flac は Conversion.init() + execute() で処理し、
// vorbisのみ Mediabunny側にエンコーダが無いため AudioSampleSink で復号し
// wasm-media-encoders の Ogg Vorbis エンコーダへ流す。
//
// 使用しているMediabunnyのAPI:
//   Input / BlobSource / StreamTarget / Output / Conversion.init / Conversion.execute /
//   Conversion.onProgress(progress:0-1, processedTime:秒) / Conversion.cancel /
//   Output.cancel / Quality / AudioSampleSink.samples()

import {
  ADTS,
  AdtsOutputFormat,
  AudioSampleSink,
  Conversion,
  FLAC,
  FlacOutputFormat,
  Input,
  BlobSource,
  MATROSKA,
  MP3,
  MP4,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OGG,
  OggOutputFormat,
  Output,
  Quality,
  StreamTarget,
  WAVE,
  WEBM,
  WavOutputFormat,
  canEncodeAudio,
} from "mediabunny";
import { registerMp3Encoder } from "@mediabunny/mp3-encoder";
import { registerFlacEncoder } from "@mediabunny/flac-encoder";
import { createOggEncoder } from "wasm-media-encoders";

import { CONVERT_FAILED, CONVERT_STALLED, CONVERT_UNSUPPORTED, SAVE_FAILED, codedError } from "./errors.mjs";
import { resolveEncoderSettings } from "./quality.mjs";

/** 入力として受け付けるコンテナ形式。YouTubeの音声itagはmp4/webmだが、周辺形式も許容する。 */
const INPUT_FORMATS = [MP4, WEBM, MATROSKA, OGG, MP3, WAVE, ADTS, FLAC];

/** vorbisパイプラインが扱える最大チャンネル数(wasm-media-encodersの制約)。 */
const MAX_VORBIS_CHANNELS = 2;

let mp3EncoderReady = false; // boolean。LAMEエンコーダ登録済みか
let flacEncoderReady = false; // boolean。libFLACエンコーダ登録済みか

/**
 * 変換打ち切り(監視タイマーによる中断)を表す例外を作る。
 * @returns {Error & {code: string}} コード付きError
 */
function stalledError() {
  return codedError(CONVERT_STALLED, "変換・保存が一定時間進捗しなかったため中断しました");
}

/**
 * 中断シグナルが立っていればCONVERT_STALLEDで打ち切る。
 * @param {AbortSignal|null} signal 中断シグナル
 * @returns {void}
 */
function throwIfAborted(signal) {
  if (signal !== null && signal.aborted) {
    throw stalledError();
  }
}

/**
 * 中断シグナルと競合させてpromiseを待つ。中断が先に立った場合はCONVERT_STALLEDで失敗する。
 * 呼び出し先(encoderのロード・FSAのclose等)が中断に応答しない場合でも、
 * 監視タイマーがタスクを終了させられるようにするためのラッパー。
 * @template T
 * @param {AbortSignal|null} signal 中断シグナル
 * @param {Promise<T>} promise 待つ対象
 * @returns {Promise<T>} 結果
 */
export function withAbort(signal, promise) {
  if (signal === null) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(stalledError());
  }
  /** @type {() => void} abortイベントのリスナ */
  let onAbort = () => {};
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(stalledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

/**
 * 書き込みが1回完了するたびにonActivityを呼ぶ、透過的なWritableStreamを被せる。
 * 変換の進捗通知が途切れても、実際の書き込みが続いている間は
 * 監視タイマーを張り直せるようにするため。
 * @param {WritableStream} writable 実際の書き出し先
 * @param {(() => void)|undefined} onActivity 書き込み完了時に呼ぶ関数
 * @returns {WritableStream} ラップしたストリーム。ラップ不要ならwritableそのもの
 */
function watchWritable(writable, onActivity) {
  if (onActivity === undefined || typeof WritableStream !== "function") {
    return writable;
  }
  const writer = writable.getWriter();
  return new WritableStream({
    async write(chunk) {
      await writer.write(chunk);
      onActivity();
    },
    async close() {
      await writer.close();
      onActivity();
    },
    async abort(reason) {
      await writer.abort(reason);
    },
  });
}

/**
 * WASMエンコーダ拡張を必要に応じて登録する。ネイティブに対応済みなら上書きしない。
 * @param {string} codec 出力コーデック
 * @returns {Promise<void>}
 */
async function ensureEncoder(codec) {
  if (codec === "mp3" && !mp3EncoderReady) {
    if (!(await canEncodeAudio("mp3"))) {
      registerMp3Encoder();
    }
    mp3EncoderReady = true;
  }
  if (codec === "flac" && !flacEncoderReady) {
    if (!(await canEncodeAudio("flac"))) {
      registerFlacEncoder();
    }
    flacEncoderReady = true;
  }
}

/**
 * コンテナ名からmediabunnyのOutputFormatインスタンスを作る。
 * @param {string} container コンテナ名
 * @returns {object} OutputFormatインスタンス
 */
function createOutputFormat(container) {
  switch (container) {
    case "mp3":
      return new Mp3OutputFormat();
    case "adts":
      return new AdtsOutputFormat();
    case "mp4":
      return new Mp4OutputFormat();
    case "ogg":
      return new OggOutputFormat();
    case "wav":
      // 12時間級の音声で4GiBを超え得るためRF64で書く。
      return new WavOutputFormat({ large: true });
    case "flac":
      return new FlacOutputFormat();
    default:
      throw codedError(CONVERT_UNSUPPORTED, `未対応のコンテナです: ${container}`);
  }
}

/**
 * 入力ファイルを開き、主音声トラックとその属性を取得する。
 * @param {File} file 変換元ファイル
 * @returns {Promise<{input: object, track: object, codec: string|null,
 *   numberOfChannels: number, sampleRate: number, totalSeconds: number}>} 入力情報
 */
export async function openAudioInput(file) {
  const input = new Input({ formats: INPUT_FORMATS, source: new BlobSource(file) });
  const track = await input.getPrimaryAudioTrack();
  if (track === null) {
    input.dispose();
    throw codedError(CONVERT_UNSUPPORTED, "音声トラックが見つかりません");
  }
  const [codec, numberOfChannels, sampleRate] = await Promise.all([
    track.getCodec(),
    track.getNumberOfChannels(),
    track.getSampleRate(),
  ]);
  const fromMetadata = await input.getDurationFromMetadata([track]);
  const totalSeconds = fromMetadata !== null ? fromMetadata : await input.computeDuration([track]);
  return { input, track, codec, numberOfChannels, sampleRate, totalSeconds };
}

/**
 * Mediabunnyの Conversion を使って変換し、writableへ書き出す。
 * @param {{input: object, settings: object, totalSeconds: number}} params 変換対象
 * @param {{writable: WritableStream, onProgress: (percent: number, convertedSeconds: number) => void,
 *   signal?: AbortSignal|null}} deps 依存
 * @returns {Promise<void>}
 */
async function runMediabunnyConversion(params, deps) {
  const signal = deps.signal ?? null;
  await ensureEncoder(params.settings.codec);

  const output = new Output({
    format: createOutputFormat(params.settings.container),
    target: new StreamTarget(deps.writable),
  });

  /** @type {object} 音声トラックへ適用する変換オプション */
  const audioOptions = { codec: params.settings.codec };
  if (!params.settings.copy && params.settings.bitrate !== undefined) {
    audioOptions.quality = new Quality({
      bitrate: params.settings.bitrate,
      bitrateMode: params.settings.bitrateMode,
    });
    audioOptions.forceTranscode = true;
  }

  let conversion = null; // Conversion|null。init完了後に入る
  /**
   * 中断時にConversionを取り消す。execute()はConversionCanceledErrorでrejectする。
   * @returns {void}
   */
  const onAbort = () => {
    if (conversion !== null) {
      conversion.cancel().catch(() => {});
    }
  };
  if (signal !== null) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    conversion = await Conversion.init({
      input: params.input,
      output,
      audio: audioOptions,
      video: { discard: true },
      showWarnings: false,
    });

    if (!conversion.isValid) {
      throw codedError(CONVERT_UNSUPPORTED, "指定された形式へは変換できません");
    }

    conversion.onProgress = (progress, processedTime) => {
      deps.onProgress(Math.round(Math.min(1, Math.max(0, progress)) * 100), processedTime);
    };

    // init中に中断された場合はonAbortがconversionを掴めていないため、ここで拾う。
    throwIfAborted(signal);

    await conversion.execute();
  } catch (error) {
    // 書き出し中の資源(エンコーダ・出力先ストリーム)を解放してから呼び出し元へ返す。
    await output.cancel().catch(() => {});
    throw error;
  } finally {
    if (signal !== null) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * vorbis用パイプライン。Mediabunnyで復号したPCMをwasm-media-encodersのOgg Vorbisへ流す。
 * @param {{track: object, settings: object, numberOfChannels: number,
 *   sampleRate: number, totalSeconds: number}} params 変換対象
 * @param {{writable: WritableStream, onProgress: (percent: number, convertedSeconds: number) => void,
 *   signal?: AbortSignal|null}} deps 依存
 * @returns {Promise<void>}
 */
async function runVorbisConversion(params, deps) {
  const signal = deps.signal ?? null;
  if (params.numberOfChannels < 1 || params.numberOfChannels > MAX_VORBIS_CHANNELS) {
    throw codedError(CONVERT_UNSUPPORTED, "vorbisは1〜2チャンネルの音声のみ対応します");
  }

  const encoder = await createOggEncoder();
  encoder.configure({
    channels: params.numberOfChannels,
    sampleRate: params.sampleRate,
    vbrQuality: params.settings.vbrQuality,
  });

  const writer = deps.writable.getWriter();
  let position = 0; // number。出力ファイル内の書込み位置

  /**
   * エンコーダ出力をStreamTargetのチャンク形式で書き出す。
   * @param {Uint8Array} bytes 出力バイト列
   * @returns {Promise<void>}
   */
  async function writeOut(bytes) {
    if (bytes.length === 0) {
      return;
    }
    // encode()の戻り値はエンコーダ内部バッファのビューなので、必ずコピーしてから渡す。
    const copy = new Uint8Array(bytes);
    await writer.write({ type: "write", data: copy, position });
    position += copy.length;
  }

  try {
    const sink = new AudioSampleSink(params.track);
    for await (const sample of sink.samples()) {
      // Conversionを介さない手動ループのため、1サンプルごとに中断を確認する。
      if (signal !== null && signal.aborted) {
        sample.close();
        throw stalledError();
      }
      /** @type {Float32Array[]} チャンネルごとのPCM */
      const channels = [];
      for (let channel = 0; channel < params.numberOfChannels; channel += 1) {
        const plane = new Float32Array(sample.numberOfFrames);
        sample.copyTo(plane, { format: "f32-planar", planeIndex: channel });
        channels.push(plane);
      }
      const processedTime = sample.timestamp + sample.duration;
      sample.close();
      await writeOut(encoder.encode(channels));
      const progress = params.totalSeconds > 0 ? processedTime / params.totalSeconds : 0;
      deps.onProgress(Math.round(Math.min(1, Math.max(0, progress)) * 100), processedTime);
    }
    await writeOut(encoder.finalize());
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => {});
    throw error;
  }
}

/**
 * 変換を実行し、destinationが指す先へ書き出す。
 * @param {{file: File, format: string, audioQuality: string}} request 変換要求
 * @param {{destinationFor: (settings: object) => Promise<object>,
 *   onProgress: (percent: number, convertedSeconds: number, totalSeconds: number) => void,
 *   signal?: AbortSignal|null, onActivity?: () => void}} deps 依存。
 *   signalが中断されると変換をCONVERT_STALLEDで打ち切り、書きかけの出力を破棄する
 * @returns {Promise<object>} destination.finish()の戻り値、またはskip時の情報
 */
export async function convertAudio(request, deps) {
  const signal = deps.signal ?? null;

  // 入力オープン(demux・尺の算出)自体が固まった場合も監視タイマーで打ち切れるようにする。
  // 中断が先に立ったときは、遅れて解決したInputが取り残されないよう後始末を予約しておく。
  const openPromise = openAudioInput(request.file);
  let opened;
  try {
    opened = await withAbort(signal, openPromise);
  } catch (error) {
    openPromise.then(
      (late) => late.input.dispose(),
      () => {},
    );
    throw error;
  }

  const settings = resolveEncoderSettings(request.format, request.audioQuality, opened.codec);
  if (settings === null) {
    opened.input.dispose();
    throw codedError(CONVERT_UNSUPPORTED, `未対応の出力形式です: ${request.format}`);
  }

  // 保存先の解決(権限確認・同名判定・OPFSの用意)も同様に監視タイマーの対象にする。
  // destinationFor自身がcode付きで失敗した場合は、そのcodeをそのまま呼び出し元へ返す。
  let destination;
  try {
    destination = await withAbort(signal, Promise.resolve(deps.destinationFor(settings)));
  } catch (error) {
    opened.input.dispose();
    throw error;
  }

  if (destination.skipped) {
    opened.input.dispose();
    return { skipped: true, fileName: destination.fileName, dirName: destination.dirName };
  }

  /**
   * 進捗をSWへ中継する。
   * @param {number} percent 0-100の進捗
   * @param {number} convertedSeconds 変換済み秒数
   * @returns {void}
   */
  const onProgress = (percent, convertedSeconds) => {
    deps.onProgress(percent, convertedSeconds, opened.totalSeconds);
  };

  /**
   * 書きかけの出力を破棄する(destinationがdiscardを持つ場合のみ)。
   * @returns {Promise<void>}
   */
  const discard = async () => {
    if (destination.discard) {
      await destination.discard().catch(() => {});
    }
  };

  let writable;
  try {
    writable = watchWritable(await withAbort(signal, destination.open()), deps.onActivity);
  } catch (error) {
    // open()の途中で失敗した場合、既に空のファイルエントリだけが作られていることがある。
    await discard();
    opened.input.dispose();
    if (error && typeof error.code === "string") {
      throw error;
    }
    throw codedError(SAVE_FAILED, error && error.message ? error.message : String(error));
  }

  try {
    if (settings.pipeline === "wasm-vorbis") {
      await withAbort(
        signal,
        runVorbisConversion(
          {
            track: opened.track,
            settings,
            numberOfChannels: opened.numberOfChannels,
            sampleRate: opened.sampleRate,
            totalSeconds: opened.totalSeconds,
          },
          { writable, onProgress, signal },
        ),
      );
    } else {
      await withAbort(
        signal,
        runMediabunnyConversion(
          { input: opened.input, settings, totalSeconds: opened.totalSeconds },
          { writable, onProgress, signal },
        ),
      );
    }
  } catch (error) {
    await discard();
    if (error && typeof error.code === "string") {
      throw error;
    }
    if (signal !== null && signal.aborted) {
      // Conversion.cancel()由来のConversionCanceledError等、コードを持たない中断。
      throw stalledError();
    }
    throw codedError(CONVERT_FAILED, error && error.message ? error.message : String(error));
  } finally {
    opened.input.dispose();
  }

  try {
    const result = await withAbort(signal, destination.finish());
    return { skipped: false, ...result };
  } catch (error) {
    // 全バイト書き終えたあとのclose/整合性検査での失敗も、書きかけの出力を残さない。
    await discard();
    if (error && typeof error.code === "string") {
      throw error;
    }
    throw codedError(SAVE_FAILED, error && error.message ? error.message : String(error));
  }
}
