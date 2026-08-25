/**
 * One-command model onboarding (ADR-0098).
 *
 * `pullModel` downloads a GGUF weights file (with resume + sha256 verify),
 * parses its header, and scaffolds the two-tier binding structure in the
 * model store:
 *
 *   <store>/<family>/family.yaml            (only if absent)
 *   <store>/<family>/bcb.jsonl|tcb.jsonl|structural.json|server_setup.json
 *   <store>/<family>/<id>/<id>.yaml         (draft adapter, TODO-marked)
 *   <store>/<family>/<id>/<file>.gguf
 *   <store>/<family>/<id>/bcb.jsonl|tcb.jsonl|server_setup.json
 *
 * The download is the only network step; everything after the sha256 check
 * is local filesystem work. A failed verify deletes the partial and leaves
 * no scaffold behind.
 */

import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { defaultModelStoreRoot } from "../service/paths.js";
import { draftAdapterYaml, draftFamilyYaml } from "./draft-adapter.js";
import { parseGgufMetadata } from "./gguf-metadata.js";
import { deriveGgufProfile } from "./gguf-profile.js";

export interface PullModelOptions {
  /** Download URL for the GGUF weights file. */
  url: string;
  /** Model id — becomes the model folder name and adapter id. Required. */
  id: string;
  /** Expected content sha256 (64 hex chars). Required — no verify, no pull. */
  sha256: string;
  /** Family slug. Defaults to the id. */
  family?: string;
  /** Store root override (default: $MBA_ADAPTER_DIR ?? OS-aware store). */
  storeRoot?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface PullModelResult {
  id: string;
  family: string;
  sha256: string;
  /** True when an existing .partial file was resumed via HTTP Range. */
  resumed: boolean;
  /** Absolute path of the model folder. */
  modelDir: string;
  /** Absolute path of the generated draft adapter YAML. */
  adapterPath: string;
  /** True when this pull created the family tier (family.yaml + bindings). */
  familyCreated: boolean;
}

const EMPTY_JSON = "{}";

/** Bad input (missing/invalid id, sha256, or url) → HTTP 400. */
export class PullValidationError extends Error {}
/** The model folder already exists → HTTP 409. */
export class PullConflictError extends Error {}
/** Downloaded content does not match the expected digest → HTTP 422. */
export class PullVerifyError extends Error {}

function resolveStoreRoot(storeRoot?: string): string {
  if (storeRoot && storeRoot.length > 0) return storeRoot;
  const env = process.env.MBA_ADAPTER_DIR;
  if (env && env.length > 0) return env;
  return defaultModelStoreRoot();
}

/**
 * Download `url` to `dest`, resuming from an existing `<dest>.partial` when
 * present. Returns true when a resume happened.
 */
async function downloadWithResume(
  url: string,
  dest: string,
  doFetch: typeof fetch,
): Promise<boolean> {
  const partial = `${dest}.partial`;
  let start = 0;
  if (existsSync(partial)) {
    start = statSync(partial).size;
  }

  const headers: Record<string, string> = {};
  if (start > 0) headers.Range = `bytes=${start}-`;

  const res = await doFetch(url, { headers });

  if (start > 0 && res.status === 416) {
    // The partial already covers the whole file.
    return true;
  }
  if (res.status === 206) {
    // Resume: append to the existing partial.
  } else if (res.status === 200) {
    // Server ignored the Range header — start over from byte 0.
    start = 0;
  } else {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }
  if (!res.body) throw new Error(`download failed: empty response body for ${url}`);

  const mode = start > 0 ? "a" : "w";
  await pipeline(
    res.body as unknown as NodeJS.ReadableStream,
    createWriteStream(partial, { flags: mode }),
  );
  return start > 0;
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Pull a model: download → verify → parse → scaffold.
 *
 * Throws (and cleans up) on: missing/invalid id or sha256, an existing model
 * folder, a failed download, or a sha256 mismatch.
 */
export async function pullModel(opts: PullModelOptions): Promise<PullModelResult> {
  const { url, id, sha256 } = opts;
  if (!id || id.length === 0) throw new PullValidationError("pull requires --id");
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new PullValidationError("pull requires --sha256 (64 hex chars) — no digest, no pull");
  }
  if (!url || url.length === 0) throw new PullValidationError("pull requires a download url");

  const family = opts.family && opts.family.length > 0 ? opts.family : id;
  const storeRoot = resolveStoreRoot(opts.storeRoot);
  const familyDir = join(storeRoot, family);
  const modelDir = join(familyDir, id);

  const fileName = basename(new URL(url).pathname) || "model.gguf";
  const dest = join(modelDir, fileName);

  if (existsSync(modelDir)) {
    // A folder holding ONLY our own .partial is a resume-in-progress, not a
    // conflict — everything else means the model was already pulled.
    const entries = readdirSync(modelDir);
    const onlyPartial = entries.length === 1 && entries[0] === `${fileName}.partial`;
    if (!onlyPartial) {
      throw new PullConflictError(
        `model folder already exists: ${modelDir} — remove it first to re-pull`,
      );
    }
  }
  const doFetch = opts.fetch ?? fetch;

  mkdirSync(modelDir, { recursive: true });
  const partial = `${dest}.partial`;
  const cleanup = (): void => {
    rmSync(partial, { force: true });
  };

  try {
    const resumed = await downloadWithResume(url, dest, doFetch);

    const actual = sha256OfFile(partial);
    if (actual !== sha256.toLowerCase()) {
      cleanup();
      throw new PullVerifyError(
        `sha256 mismatch: expected ${sha256.toLowerCase()}, got ${actual} — partial deleted`,
      );
    }
    renameSync(partial, dest);

    // Header parse + profile derivation (local, no network).
    const meta = parseGgufMetadata(dest);
    const profile = deriveGgufProfile(meta, fileName, sha256.toLowerCase());

    // Model tier: draft adapter + empty bindings.
    const adapterPath = join(modelDir, `${id}.yaml`);
    writeFileSync(adapterPath, draftAdapterYaml({ id, family, fileName, sha256, profile }));
    writeFileSync(join(modelDir, "bcb.jsonl"), EMPTY_JSON);
    writeFileSync(join(modelDir, "tcb.jsonl"), EMPTY_JSON);
    writeFileSync(join(modelDir, "server_setup.json"), EMPTY_JSON);

    // Family tier: only when the family has no family.yaml yet.
    let familyCreated = false;
    const familyYaml = join(familyDir, "family.yaml");
    if (!existsSync(familyYaml)) {
      writeFileSync(familyYaml, draftFamilyYaml({ family }));
      writeFileSync(join(familyDir, "bcb.jsonl"), EMPTY_JSON);
      writeFileSync(join(familyDir, "tcb.jsonl"), EMPTY_JSON);
      writeFileSync(join(familyDir, "structural.json"), EMPTY_JSON);
      writeFileSync(join(familyDir, "server_setup.json"), EMPTY_JSON);
      familyCreated = true;
    }

    return {
      id,
      family,
      sha256: sha256.toLowerCase(),
      resumed,
      modelDir,
      adapterPath,
      familyCreated,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}
