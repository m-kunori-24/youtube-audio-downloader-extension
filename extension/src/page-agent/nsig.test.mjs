/**
 * @jest-environment node
 */
// nsig.test.mjs
// n変換出力のescape hatch妥当性ヒューリスティックのテスト。
// 実プレイヤーJSを使った抽出はネットワークが要るため対象外(合成出力のみで検証する)。

import { isValidNsigOutput } from "./nsig.mjs";

const INPUT = "abcDEF123";

describe("isValidNsigOutput", () => {
  test.each([
    ["正常な変換結果", "xyz789QWE", true],
    ["入力と同一(未変換)", INPUT, false],
    ["enhanced_except_接頭辞", `enhanced_except_Xyz-${INPUT}`, false],
    ["入力文字列で終わる(接頭辞付きエコー)", `prefix_${INPUT}`, false],
    ["空文字", "", false],
    ["undefined", undefined, false],
    ["非文字列", 12345, false],
  ])("%s → %s", (_label, output, expected) => {
    expect(isValidNsigOutput(INPUT, output)).toBe(expected);
  });
});
