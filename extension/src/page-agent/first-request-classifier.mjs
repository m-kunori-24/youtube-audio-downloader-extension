// first-request-classifier.mjs
// Gap1「Layer B」: 各候補の最初のSABR POSTを検証役として使い、失敗を
// SIGNATURE_REJECTED / NETWORK_UNREACHABLE / SABR_SERVER_ERROR に分類する。
//   - 可読なHTTP 403                      → SIGNATURE_REJECTED
//   - その他の可読な非2xx                  → SABR_SERVER_ERROR(候補却下ではなく通常エラー)
//   - 不透明な失敗(TypeError)             → no-corsプローブGET: 解決→SIGNATURE_REJECTED、拒否→NETWORK_UNREACHABLE

export const FIRST_REQUEST_OUTCOME = Object.freeze({
  SIGNATURE_REJECTED: "SIGNATURE_REJECTED",
  NETWORK_UNREACHABLE: "NETWORK_UNREACHABLE",
  SABR_SERVER_ERROR: "SABR_SERVER_ERROR",
});

/**
 * 可読なHTTP応答(非2xx)を分類する。
 * @param {number} status HTTPステータス
 * @returns {{outcome: string, status: number}} 分類結果
 */
export function classifyHttpFailure(status) {
  if (status === 403) {
    return { outcome: FIRST_REQUEST_OUTCOME.SIGNATURE_REJECTED, status };
  }
  return { outcome: FIRST_REQUEST_OUTCOME.SABR_SERVER_ERROR, status };
}

/**
 * fetchが例外で失敗した場合を分類する。TypeError(CORS不透明失敗)なら同一URLへ
 * no-corsプローブを打ち、到達可否で切り分ける。それ以外の例外はSABR_SERVER_ERROR扱い。
 * @param {unknown} error fetchが投げた例外
 * @param {string} url 失敗したリクエストのURL
 * @param {typeof fetch} fetchFn プローブに使うfetch
 * @returns {Promise<{outcome: string, status: number|null}>} 分類結果
 */
export async function classifyFetchException(error, url, fetchFn) {
  if (!(error instanceof TypeError)) {
    return { outcome: FIRST_REQUEST_OUTCOME.SABR_SERVER_ERROR, status: null };
  }
  try {
    await fetchFn(url, { method: "GET", mode: "no-cors", cache: "no-store", credentials: "omit" });
    return { outcome: FIRST_REQUEST_OUTCOME.SIGNATURE_REJECTED, status: null };
  } catch (probeError) {
    return { outcome: FIRST_REQUEST_OUTCOME.NETWORK_UNREACHABLE, status: null };
  }
}
