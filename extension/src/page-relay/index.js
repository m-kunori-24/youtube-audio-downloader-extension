// page-relay (ISOLATED world) エントリポイント。
// SWがchrome.scripting.executeScript(world:"ISOLATED")で本バンドルを注入した後、
// globalThis.__ytaRelay.start({taskId, secret}) を呼び出す。二重注入時は既存の定義を保持する。
// secretはフレーム署名鍵(hex)で、ISOLATED worldのみを経由しページには見えない。
// 同一タブで別タスクのstartが呼ばれた場合は前のリレーを停止してから開始する。

import { startRelay } from "./relay.mjs";

if (!globalThis.__ytaRelay) {
  let active = null; // {stop} | null

  globalThis.__ytaRelay = {
    start: (cfg) => {
      if (active !== null) {
        active.stop();
      }
      active = startRelay(cfg, {
        chrome: globalThis.chrome,
        window: globalThis.window,
        origin: globalThis.location.origin,
        subtle: globalThis.crypto.subtle,
        setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
        clearTimeout: (handle) => globalThis.clearTimeout(handle),
      });
    },
  };
}
