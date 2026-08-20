/**
 * Disk cache for GGUF metadata.
 *
 * Caches parsed GGUF metadata on disk so subsequent server startups do not
 * need to re-parse the header. Cache entries are keyed by model file hash.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseGgufMetadata, type GgufMetadata } from "./gguf-metadata.js";

export interface GgufMetadataCacheOptions {
  readonly cacheDir: string;
}

function fileHash(filePath: string): string {
  // Hash only the file's path + size + mtime, not the contents. The GGUF
  // header is small enough that re-parsing on mtime change is cheap, and
  // hashing the full 18GB file would blow the 2GB readFileSync limit.
  const stat = statSync(filePath, { throwIfNoEntry: false });
  const payload = stat
    ? `${filePath}\n${stat.size}\n${stat.mtimeMs}`
    : filePath;
  return createHash("sha256").update(payload).digest("hex");
}

export function createGgufMetadataCache(options: GgufMetadataCacheOptions) {
  const cacheDir = resolve(options.cacheDir);
  mkdirSync(cacheDir, { recursive: true });

  return function load(modelFilePath: string): GgufMetadata {
    const absolutePath = resolve(modelFilePath);
    const hash = fileHash(absolutePath);
    const cachePath = resolve(cacheDir, `${hash}.json`);

    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as GgufMetadata;
      const modelStat = statSync(absolutePath, { throwIfNoEntry: false });
      const cacheStat = statSync(cachePath, { throwIfNoEntry: false });
      if (modelStat && cacheStat && modelStat.mtimeMs <= cacheStat.mtimeMs) {
        return cached;
      }
    } catch {
      // Cache miss or corrupt cache — fall through to parse.
    }

    const metadata = parseGgufMetadata(absolutePath);
    writeFileSync(
      cachePath,
      JSON.stringify(metadata, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2),
    );
    return metadata;
  };
}
