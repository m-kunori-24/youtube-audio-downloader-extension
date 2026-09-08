// package.mjs
// extension/ ディレクトリをZIP圧縮し、リポジトリルートに
// youtube-audio-downloader-extension-vX.Y.Z.zip (Xはmanifest.jsonのversion) を生成する。
// installer/build-release.ps1 の役割を引き継ぐが、外部アーティファクトのダウンロードや
// GnuPG署名・チェックサム検証は行わない(フォルダをZIPするだけの単純な手動サイドロード用)。
//
// ZIP生成にはNode組み込みの node:zlib (deflateRawSync / crc32) のみを使用し、
// 追加の依存ライブラリは導入しない。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(__dirname, "extension");

/** zip対象から除外するディレクトリ名(直下・再帰問わず一致したら丸ごとスキップ)。 */
const EXCLUDED_DIR_NAMES = new Set(["test-utils", "spike", "node_modules", "src"]);

/** zip対象から除外するファイル名パターン。 */
function isExcludedFile(fileName) {
  return fileName.endsWith(".test.js") || fileName.endsWith(".test.mjs");
}

/**
 * ディレクトリを再帰的に走査し、zipに含めるファイルの絶対パス一覧を返す。
 * @param {string} dir 走査対象ディレクトリの絶対パス
 * @returns {string[]} 対象ファイルの絶対パス一覧
 */
function collectFiles(dir) {
  /** @type {string[]} */
  const result = [];
  for (const entry of readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry)) {
        continue;
      }
      result.push(...collectFiles(entryPath));
    } else if (stat.isFile()) {
      if (isExcludedFile(entry)) {
        continue;
      }
      result.push(entryPath);
    }
  }
  return result;
}

/**
 * DOS形式の日時(ZIPローカルヘッダ用)を現在時刻から生成する。
 * @returns {{ time: number, date: number }} DOS時刻・日付
 */
function dosDateTime() {
  const now = new Date();
  const time =
    (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date =
    ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}

/**
 * ファイル一覧からZIPアーカイブ(Buffer)を組み立てる。
 * @param {Array<{ relPath: string, data: Buffer }>} files zip内相対パスとファイル内容の一覧
 * @returns {Buffer} ZIPアーカイブ全体のバイト列
 */
function buildZip(files) {
  const { time, date } = dosDateTime();
  /** @type {Buffer[]} */
  const localParts = [];
  /** @type {Buffer[]} */
  const centralParts = [];
  let offset = 0;

  for (const { relPath, data } of files) {
    const nameBuf = Buffer.from(relPath.replace(/\\/g, "/"), "utf8");
    const crc = zlib.crc32(data);
    const compressed = zlib.deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(0, 38); // external attributes
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirStart = offset;
  const centralDir = Buffer.concat(centralParts);
  const centralDirSize = centralDir.length;

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4); // disk number
  endRecord.writeUInt16LE(0, 6); // disk with central dir
  endRecord.writeUInt16LE(files.length, 8); // entries on this disk
  endRecord.writeUInt16LE(files.length, 10); // total entries
  endRecord.writeUInt32LE(centralDirSize, 12);
  endRecord.writeUInt32LE(centralDirStart, 16);
  endRecord.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, endRecord]);
}

async function main() {
  const manifest = JSON.parse(
    readFileSync(path.join(extensionDir, "manifest.json"), "utf8"),
  );
  const version = manifest.version;
  if (!version) {
    throw new Error("extension/manifest.json に version フィールドがありません");
  }

  const absoluteFiles = collectFiles(extensionDir);
  const files = absoluteFiles.map((absPath) => ({
    relPath: path.relative(extensionDir, absPath),
    data: readFileSync(absPath),
  }));

  const zipBuffer = buildZip(files);
  const outName = `youtube-audio-downloader-extension-v${version}.zip`;
  const outPath = path.join(__dirname, outName);
  await writeFile(outPath, zipBuffer);

  console.log(`packaged ${files.length} files -> ${outName}`);
  for (const { relPath } of files) {
    console.log(`  ${relPath}`);
  }
}

await main();
