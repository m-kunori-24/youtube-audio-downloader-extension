module.exports = {
  testEnvironment: "jsdom",
  testMatch: ["<rootDir>/extension/**/*.test.js", "<rootDir>/extension/**/*.test.mjs"],
  // .mjsはJestにより既定でネイティブESM(import/export)として扱われる。.jsは従来通りCommonJS(require)。
  // T8-T11で追加されるmediabunny等のESM依存を使うテストは.test.mjsとして作成し、
  // `npm test`(--experimental-vm-modules付き)で実行する。
};
