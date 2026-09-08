// abort-reasons.mjs
// abortフレームのreason値。送出側(page-agent)と受信側(Offscreen transfer.mjs)が
// 同じ定数を参照し、文字列リテラルの食い違い(finding 12)を防ぐ。
// RESTART以外の値はすべて終了(terminal)として扱う。

export const ABORT_REASONS = Object.freeze({ RESTART: "restart", ERROR: "error" });
