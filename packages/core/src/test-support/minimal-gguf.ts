/**
 * Sparse dummy GGUF files for tests.
 *
 * The estimator uses `statSync(path).size` as the weight-file size, so tests
 * need a file that *looks* large. Writing that many real bytes fills /tmp
 * (and RAM) when a suite forgets to `rmSync`. `ftruncate` sets the size
 * without allocating the hole.
 */

import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";

export interface MinimalGgufOptions {
  readonly blockCount: number;
  readonly hiddenSize: number;
  readonly headCount: number;
  readonly headCountKv: number;
  readonly vocabSize?: number;
  readonly ffnDim?: number;
  /** Apparent size from `stat`. Defaults to the header length (no padding). */
  readonly fileSizeBytes?: number;
}

function writeString(buf: Buffer, offset: number, value: string): number {
  const bytes = Buffer.from(value, "utf8");
  buf.writeBigUInt64LE(BigInt(bytes.length), offset);
  bytes.copy(buf, offset + 8);
  return 8 + bytes.length;
}

function writeUint32(buf: Buffer, offset: number, value: number): number {
  buf.writeUInt32LE(value, offset);
  return 4;
}

function writeUint64(buf: Buffer, offset: number, value: bigint): number {
  buf.writeBigUInt64LE(value, offset);
  return 8;
}

function writeKvUint32(buf: Buffer, offset: number, key: string, value: number): number {
  let written = 0;
  written += writeString(buf, offset + written, key);
  buf.writeUInt32LE(4, offset + written);
  written += 4;
  written += writeUint32(buf, offset + written, value);
  return written;
}

function writeKvString(buf: Buffer, offset: number, key: string, value: string): number {
  let written = 0;
  written += writeString(buf, offset + written, key);
  buf.writeUInt32LE(8, offset + written);
  written += 4;
  written += writeString(buf, offset + written, value);
  return written;
}

function encodeHeader(opts: MinimalGgufOptions): Buffer {
  const metadata: { key: string; type: "uint32" | "string"; value: string | number }[] = [
    { key: "general.architecture", type: "string", value: "llama" },
    { key: "llama.block_count", type: "uint32", value: opts.blockCount },
    { key: "llama.embedding_length", type: "uint32", value: opts.hiddenSize },
    { key: "llama.attention.head_count", type: "uint32", value: opts.headCount },
    { key: "llama.attention.head_count_kv", type: "uint32", value: opts.headCountKv },
    ...(opts.vocabSize !== undefined
      ? [{ key: "llama.vocab_size", type: "uint32" as const, value: opts.vocabSize }]
      : []),
    ...(opts.ffnDim !== undefined
      ? [{ key: "llama.feed_forward_length", type: "uint32" as const, value: opts.ffnDim }]
      : []),
  ];
  const buf = Buffer.alloc(4096);
  let offset = 0;
  buf.write("GGUF", offset, 4, "ascii");
  offset += 4;
  offset += writeUint32(buf, offset, 3);
  offset += writeUint64(buf, offset, 0n);
  offset += writeUint64(buf, offset, BigInt(metadata.length));
  for (const entry of metadata) {
    if (entry.type === "uint32") {
      offset += writeKvUint32(buf, offset, entry.key, entry.value as number);
    } else {
      offset += writeKvString(buf, offset, entry.key, entry.value as string);
    }
  }
  return buf.subarray(0, offset);
}

/** Write a parseable GGUF whose `stat.size` is `fileSizeBytes`, without filling disk. */
export function writeMinimalGguf(path: string, opts: MinimalGgufOptions): void {
  const header = encodeHeader(opts);
  const fileSize = opts.fileSizeBytes ?? header.length;
  if (fileSize < header.length) {
    throw new Error(`fileSizeBytes ${fileSize} is smaller than the GGUF header (${header.length})`);
  }
  const fd = openSync(path, "w");
  try {
    writeSync(fd, header);
    ftruncateSync(fd, fileSize);
  } finally {
    closeSync(fd);
  }
}
