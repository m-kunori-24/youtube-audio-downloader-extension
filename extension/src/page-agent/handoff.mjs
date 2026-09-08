// handoff.mjs
// SW→page-agentのcfg受け渡し(finding 2)のMAIN world側。SWはバンドル注入の直前に
// func注入で globalThis.__ytaCfg をconfigurable:true/writable:falseで定義する。
// バンドルは読込時に本モジュールでそれを読み取り、即座にグローバルから削除する。
// 有効なオブジェクトが無ければnullを返し、呼び出し側は何もしない(fail-closed)。
// 旧来の globalThis.__ytaAgent.run(cfg) 入口は廃止した(ページスクリプトによる事前定義を防ぐため)。

export const HANDOFF_PROPERTY = "__ytaCfg";

/**
 * グローバルからcfgを取り出して削除する。
 * @param {object} globalObject 対象のグローバル(実環境ではglobalThis)
 * @returns {object|null} cfg。有効な受け渡しが無ければnull
 */
export function takeHandoffConfig(globalObject) {
  const descriptor = Object.getOwnPropertyDescriptor(globalObject, HANDOFF_PROPERTY);
  if (!descriptor || typeof descriptor.value !== "object" || descriptor.value === null) {
    return null;
  }
  const cfg = descriptor.value;
  try {
    delete globalObject[HANDOFF_PROPERTY];
  } catch (error) {
    // 削除できなくても処理は続ける(cfgは既に取得済み)
  }
  return cfg;
}
