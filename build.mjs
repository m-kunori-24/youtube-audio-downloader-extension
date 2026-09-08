// build.mjs
// esbuildによる拡張機能バンドルビルドスクリプト。
// extension/dist/ に page-agent.js / page-relay.js / converter.js の3バンドルを生成する。
//
// 使い方:
//   node build.mjs        本番ビルド(minify・source map無し)
//   node build.mjs --dev  開発ビルド(minify無し・inline source map)

import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes("--dev") || process.env.NODE_ENV === "development";

/** @type {Array<{ name: string, entry: string, outfile: string }>} */
const bundles = [
  {
    name: "page-agent",
    entry: path.join(__dirname, "extension/src/page-agent/index.js"),
    outfile: path.join(__dirname, "extension/dist/page-agent.js"),
  },
  {
    name: "page-relay",
    entry: path.join(__dirname, "extension/src/page-relay/index.js"),
    outfile: path.join(__dirname, "extension/dist/page-relay.js"),
  },
  {
    name: "converter",
    entry: path.join(__dirname, "extension/src/converter/index.js"),
    outfile: path.join(__dirname, "extension/dist/converter.js"),
  },
];

for (const bundle of bundles) {
  await esbuild.build({
    entryPoints: [bundle.entry],
    outfile: bundle.outfile,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: !isDev,
    sourcemap: isDev ? "inline" : false,
  });
  console.log(`built ${bundle.name} -> ${path.relative(__dirname, bundle.outfile)}`);
}
