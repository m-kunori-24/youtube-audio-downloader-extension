// status-reporter.mjs
// {type:"status", phase, ...} 進捗メッセージを1秒に1回以下へ間引く。
// phaseが直前の送信と異なる場合は即時送信する(フェーズ遷移を取りこぼさないため)。

export const DEFAULT_MIN_INTERVAL_MS = 1000;

/**
 * 進捗送信器を作る。
 * @param {{post: (message: object) => void, now: () => number, minIntervalMs?: number}} params
 *   post: {type,...}を送る関数、now: 現在時刻(ms)
 * @returns {{report: (fields: {phase: string, [key: string]: unknown}) => boolean}} 送信器。reportは送信したらtrue
 */
export function createStatusReporter({ post, now, minIntervalMs = DEFAULT_MIN_INTERVAL_MS }) {
  let lastSentAt = Number.NEGATIVE_INFINITY; // number
  let lastPhase = null; // string | null

  return {
    report(fields) {
      const current = now();
      if (fields.phase === lastPhase && current - lastSentAt < minIntervalMs) {
        return false;
      }
      lastSentAt = current;
      lastPhase = fields.phase;
      post({ type: "status", ...fields });
      return true;
    },
  };
}
