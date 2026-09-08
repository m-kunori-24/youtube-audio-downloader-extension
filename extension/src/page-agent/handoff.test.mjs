/**
 * @jest-environment node
 */
// handoff.test.mjs
// page-agentのfail-closedなcfg受け渡し: __ytaCfgが有効なオブジェクトのときだけ返して削除し、
// 不在・null・非オブジェクト・削除不能の各ケースを検証する。

import { HANDOFF_PROPERTY, takeHandoffConfig } from "./handoff.mjs";

test("SWが定義した形(writable:false/configurable:true/enumerable:false)のcfgを返し、グローバルから削除する", () => {
  const target = {};
  const cfg = { taskId: "t", secret: "ab".repeat(32) };
  Object.defineProperty(target, HANDOFF_PROPERTY, { value: cfg, writable: false, configurable: true, enumerable: false });

  expect(takeHandoffConfig(target)).toBe(cfg);
  expect(Object.getOwnPropertyDescriptor(target, HANDOFF_PROPERTY)).toBeUndefined();
});

test("プロパティが無ければnull", () => {
  expect(takeHandoffConfig({})).toBeNull();
});

test("値がnull・文字列・数値・関数ならnull", () => {
  for (const value of [null, "cfg", 1, () => ({})]) {
    const target = {};
    Object.defineProperty(target, HANDOFF_PROPERTY, { value, configurable: true });
    expect(takeHandoffConfig(target)).toBeNull();
  }
});

test("プロパティが削除できなくてもcfgは返す", () => {
  const target = {};
  const cfg = { taskId: "t" };
  Object.defineProperty(target, HANDOFF_PROPERTY, { value: cfg, configurable: false });
  expect(takeHandoffConfig(target)).toBe(cfg);
  expect(target[HANDOFF_PROPERTY]).toBe(cfg);
});

test("HANDOFF_PROPERTYはSW側のfunc注入が書き込む名前__ytaCfgと一致する", () => {
  expect(HANDOFF_PROPERTY).toBe("__ytaCfg");
});
