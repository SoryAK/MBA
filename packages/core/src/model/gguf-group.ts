/**
 * Group local GGUFs that share a stem and differ only by quant.
 * Used by mba migrate so the picker is groups, not six filenames.
 */

import { quantFromFilename } from "./gguf-profile.js";
import { deriveModelId } from "./model-id.js";
import type { FoundGguf } from "./gguf-scan.js";

export interface GgufGroup {
  /** Store-safe stem (letters/digits/hyphen). Picker value. */
  readonly key: string;
  readonly stem: string;
  readonly files: readonly FoundGguf[];
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Filename minus trailing quant label (`Qwen3.8-27B-Q6_K.gguf` → `Qwen3.8-27B`). */
export function ggufStem(fileName: string): string {
  const quant = quantFromFilename(fileName);
  const base = fileName.replace(/\.gguf$/i, "");
  if (!quant) return base;
  const stripped = base.replace(new RegExp(`[-_.]${escapeRe(quant)}$`, "i"), "");
  return stripped.length > 0 ? stripped : base;
}

/** Stem + quant, slugged. Two Q4 files in one group stay distinct. */
export function defaultAdoptId(file: FoundGguf): string {
  const stem = ggufStem(file.fileName);
  const raw = file.quant ? `${stem}-${file.quant}` : stem;
  return deriveModelId(raw);
}

export function assignAdoptIds(files: readonly FoundGguf[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const file of files) {
    let id = defaultAdoptId(file);
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);
    out.set(file.path, id);
  }
  return out;
}

/**
 * Keep first-seen order (find rank / folder walk). Files in a group
 * keep that order.
 */
export function groupGgufs(files: readonly FoundGguf[]): GgufGroup[] {
  const buckets = new Map<string, FoundGguf[]>();
  const order: string[] = [];
  for (const file of files) {
    const stem = ggufStem(file.fileName);
    const key = deriveModelId(stem);
    const list = buckets.get(key);
    if (!list) {
      buckets.set(key, [file]);
      order.push(key);
    } else {
      list.push(file);
    }
  }
  return order.map((key) => ({
    key,
    stem: key,
    files: buckets.get(key)!,
  }));
}
