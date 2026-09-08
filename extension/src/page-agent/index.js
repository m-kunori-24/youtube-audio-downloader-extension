// page-agent (MAIN world) エントリポイント。
// SWは注入前にfunc注入で globalThis.__ytaCfg へcfgを書き込み(configurable:true / writable:false)、
// その後で本バンドルをchrome.scripting.executeScript(world:"MAIN", files)で注入する。
// 本バンドルはモジュール読込時にhandoff.mjsで __ytaCfg を読み取って即座に削除し、runAgentを起動する
// (fail-closed: 有効な受け渡しが無ければ何もしない。finding 2)。
// すべての報告は署名付きフレームとしてリレーへ送るため、戻り値は誰にも読まれない。
// 実処理はagent.mjsにあり、ここではページのグローバル(fetch/document/ytcfg/crypto等)を
// 依存として束ねるだけにする。

import { runAgent } from "./agent.mjs";
import { takeHandoffConfig } from "./handoff.mjs";
import { evaluateScript } from "./nsig.mjs";

/**
 * ページのグローバルからagent.mjsの依存オブジェクトを組み立てる。
 * @returns {object} runAgentへ渡す依存
 */
function createPageDeps() {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    document: globalThis.document,
    window: globalThis.window,
    origin: globalThis.location.origin,
    ytcfgGet: (key) => {
      const ytcfg = globalThis.ytcfg;
      return ytcfg && typeof ytcfg.get === "function" ? ytcfg.get(key) : undefined;
    },
    subtle: globalThis.crypto.subtle,
    postMessage: (message) => globalThis.window.postMessage(message, globalThis.location.origin),
    now: () => Date.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    evalScript: evaluateScript,
  };
}

(function bootstrap() {
  const cfg = takeHandoffConfig(globalThis);
  if (cfg === null) {
    return;
  }
  runAgent(cfg, createPageDeps()).catch(() => {});
})();
