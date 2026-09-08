// nsig.mjs
// プレイヤーJSからn変換(nsig)関数をyoutubei.jsのAST抽出器で切り出し、MAIN worldで評価する。
// youtubei.jsのpackage.json exportsは抽出器単体を公開していないため、Innertube本体を
// 巻き込まないよう dist 内のモジュールを相対パスで直接束ねる(esbuildで解決)。
//
// 「静かな失敗」対策(T6で観測): 変換結果が入力と同一、`enhanced_except_`で始まる、
// 入力文字列で終わる、のいずれかなら抽出失敗として候補を却下する。

import {
  JsAnalyzer,
  JsExtractor,
  JsMatchers,
} from "../../../node_modules/youtubei.js/dist/src/utils/javascript/index.js";

const NSIG_FUNCTION_NAME = "nsigFunction";
const TRUSTED_TYPES_POLICY_NAME = "yta-nsig";

let trustedTypesPolicy = null; // TrustedTypePolicy | null

/**
 * n変換の出力が妥当か判定する(escape hatch検出)。
 * @param {string} input 変換前のn
 * @param {unknown} output 変換関数の戻り値
 * @returns {boolean} 妥当ならtrue
 */
export function isValidNsigOutput(input, output) {
  if (typeof output !== "string" || output.length === 0) {
    return false;
  }
  if (output === input) {
    return false;
  }
  if (output.startsWith("enhanced_except_")) {
    return false;
  }
  if (output.endsWith(input)) {
    return false;
  }
  return true;
}

/**
 * youtubei.jsのUtils.getNsigProcessorFnと同じ手順で、抽出したURLコンストラクタ関数を
 * 「n文字列→変換後n」の関数として呼ぶ処理を生成する。Utils.jsはPlatform/Log等を
 * 巻き込むため、ここで同等の処理を自前で持つ。
 * @returns {string} `process(n)`関数を定義するJS文字列
 */
function buildProcessorSource() {
  return `function process(n) {
  const mockStreamingURL = "https://ytjs.googlevideo.com/videoplayback?expire=1234567890&n=" + encodeURIComponent(n);
  const urlCtorFunction = exportedVars.${NSIG_FUNCTION_NAME};
  if (typeof urlCtorFunction !== "function") {
    throw new Error("No n/sig decipher function extracted");
  }
  const urlCtor = urlCtorFunction(mockStreamingURL, "", "");
  const proto = Object.getPrototypeOf(urlCtor);
  const methodBlacklist = ["constructor", "clone", "set", "get"];
  for (const prop of Object.getOwnPropertyNames(proto)) {
    if (methodBlacklist.includes(prop)) continue;
    if (typeof urlCtor[prop] === "function") urlCtor[prop]();
  }
  const nResult = urlCtor.get("n");
  return typeof nResult === "string" ? decodeURIComponent(nResult) : undefined;
}`;
}

/**
 * 既定の評価器。Trusted Typesが有効なページ(youtube.com)ではポリシー経由の
 * TrustedScriptを間接evalへ渡す。trustedTypesが無い環境では素の間接eval。
 * @param {string} code 評価するJS式
 * @returns {unknown} 評価結果
 */
export function evaluateScript(code) {
  const trustedTypes = globalThis.trustedTypes;
  if (trustedTypes && typeof trustedTypes.createPolicy === "function") {
    if (trustedTypesPolicy === null) {
      trustedTypesPolicy = trustedTypes.createPolicy(TRUSTED_TYPES_POLICY_NAME, {
        createScript: (source) => source,
      });
    }
    return (0, eval)(trustedTypesPolicy.createScript(code));
  }
  return (0, eval)(code);
}

/**
 * プレイヤーJSソースからn変換関数を抽出し、`(n) => transformedN` を返す。
 * 抽出できなかった場合は例外。
 * @param {string} playerJsSource base.jsの全文
 * @param {(code: string) => unknown} [evalFn] 評価器(テスト用差し替え)
 * @returns {(n: string) => string|undefined} n変換関数
 */
export function createNsigTransform(playerJsSource, evalFn = evaluateScript) {
  const analyzer = new JsAnalyzer(playerJsSource, {
    extractions: [{ friendlyName: NSIG_FUNCTION_NAME, match: JsMatchers.nsigMatcher }],
  });
  const extractor = new JsExtractor(analyzer);
  const built = extractor.buildScript({ disallowSideEffectInitializers: true });
  if (!built.exported.includes(NSIG_FUNCTION_NAME)) {
    throw new Error("nsig function not found in player JS");
  }
  const wrapped = `(function () {\n${built.output}\n${buildProcessorSource()}\nreturn process;\n})()`;
  const processFn = evalFn(wrapped);
  if (typeof processFn !== "function") {
    throw new Error("nsig processor evaluation did not yield a function");
  }
  return (n) => processFn(n);
}
