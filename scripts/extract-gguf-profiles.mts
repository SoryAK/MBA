/**
 * One-off: extract GGUF header metadata for the weight-only models so their
 * adapter `profile` blocks can be transcribed from real facts (ADR-0091).
 *
 * Usage: npx tsx scripts/extract-gguf-profiles.mts <file.gguf> [...]
 */
import { createHash } from "node:crypto";
import { parseGgufMetadata } from "../packages/mcp-server/src/model/gguf-metadata.js";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: extract-gguf-profiles.mts <file.gguf> [...]");
  process.exit(1);
}

for (const file of files) {
  const meta = parseGgufMetadata(file);
  // Drop the bulky token list; keep everything else.
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta.fields)) {
    // Skip bulky arrays (tokens, merges, token_type, pre) — not part of the profile.
    if (Array.isArray(v)) continue;
    if (k === "tokenizer.chat_template") {
      // keep only a digest, like the profile schema
      fields[k + ".digest"] = createHash("sha256").update(String(v)).digest("hex").slice(0, 16);
      continue;
    }
    fields[k] = v;
  }
  console.log(`\n===== ${file} =====`);
  console.log(JSON.stringify({ version: meta.version, tensorCount: meta.tensorCount.toString(), kvCount: meta.kvCount.toString(), fields }, null, 2));
}
