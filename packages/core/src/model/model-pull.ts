/**
 * One-command model onboarding (ADR-0098, digest auto-resolution ADR-0099).
 *
 * `pullModel` downloads a GGUF weights file (with resume + sha256 verify),
 * parses its header, and scaffolds the two-tier binding structure in the
 * model store:
 *
 * The digest is normally passed explicitly (`--sha256`). When omitted, it is
 * resolved from the source's published LFS metadata — HuggingFace repo
 * shorthand (`owner/repo[:file-or-quant]`) or a huggingface.co resolve URL
 * (ADR-0099). Any other host still requires an explicit digest.
 *
 *   <store>/<family>/family.yaml            (only if absent)
 *   <store>/<family>/bcb.jsonl|tcb.jsonl|structural.json|server_setup.json
 *   <store>/<family>/<id>/<id>.yaml         (draft adapter, TODO-marked)
 *   <store>/<family>/<id>/<file>.gguf
 *   <store>/<family>/<id>/bcb.jsonl|tcb.jsonl|server_setup.json
 *   <store>/<family>/<id>/kv/<fork>/slots   (G3 slot-save dirs, both forks)
 *
 * The download is the only network step; everything after the sha256 check
 * is local filesystem work. A failed verify deletes the partial and leaves
 * no scaffold behind.
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream";
import { slotSavePath } from "../mba/server-lifecycle.js";
import { defaultModelStoreRoot } from "../service/paths.js";
import { draftAdapterYaml, draftFamilyYaml } from "./draft-adapter.js";
import { parseGgufMetadata } from "./gguf-metadata.js";
import { deriveGgufProfile } from "./gguf-profile.js";
import { parseHfRef, parseHfUrl, resolveHfSource } from "./hf-resolve.js";

export interface PullModelOptions {
  /**
   * Download URL for the GGUF weights file, or a HuggingFace repo shorthand
   * (`owner/repo[:file-or-quant]`, ADR-0099) when `sha256` is omitted.
   */
  url: string;
  /** Model id — becomes the model folder name and adapter id. Required. */
  id: string;
  /**
   * Expected content sha256 (64 hex chars). When omitted, the digest is
   * resolved from the source's published LFS metadata (HuggingFace only,
   * ADR-0099); any other host still requires an explicit digest.
   */
  sha256?: string;
  /** Family slug. Defaults to the id. */
  family?: string;
  /** Store root override (default: $MBA_ADAPTER_DIR ?? OS-aware store). */
  storeRoot?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Download progress callback. Invoked per received chunk with the running
   * byte count (including any resumed prefix) and the total size when the
   * server advertised one (null otherwise). The caller decides where the
   * progress goes — the daemon route forwards it over SSE to the CLI.
   */
  onProgress?: (downloaded: number, total: number | null) => void;
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
  onProgress?: (downloaded: number, total: number | null) => void,
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

  // Total size from the server when advertised (null for chunked/unknown).
  // On a 206 resume the content-length is only the REMAINING bytes, so add
  // the resumed offset to recover the full file size for the percentage.
  const contentLength = res.headers.get("content-length");
  const totalSize = contentLength ? parseInt(contentLength, 10) + start : null;

  let downloadedBytes = start;
  const reader = res.body.getReader();
  const fileStream = createWriteStream(partial, { flags: mode });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      downloadedBytes += value.length;
      onProgress?.(downloadedBytes, totalSize);

      // Respect backpressure: when the write buffer is full, wait for drain
      // before pulling the next chunk (multi-GB downloads must not buffer
      // the whole file in memory). The drain/error listeners remove each
      // other so a long download does not accumulate stale listeners
      // (MaxListenersExceededWarning).
      if (!fileStream.write(value)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            fileStream.removeListener("error", onError);
            resolve();
          };
          const onError = (err: Error) => {
            fileStream.removeListener("drain", onDrain);
            reject(err);
          };
          fileStream.once("drain", onDrain);
          fileStream.once("error", onError);
        });
      }
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        fileStream.removeListener("finish", onFinish);
        reject(err);
      };
      const onFinish = () => {
        fileStream.removeListener("error", onError);
        resolve();
      };
      fileStream.once("error", onError);
      fileStream.once("finish", onFinish);
      fileStream.end();
    });
    return start > 0;
  } catch (error) {
    fileStream.destroy();
    throw error;
  }
}

/**
 * Stream a file's sha256 in constant memory. Multi-GB GGUFs must never be
 * read whole into a Buffer just to hash them.
 */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  // pipeline requires a trailing callback (a bare Transform as the final
  // stream throws ERR_INVALID_ARG_TYPE); wrap it so we can await completion.
  await new Promise<void>((resolve, reject) => {
    pipeline(createReadStream(path), hash, (err) => (err ? reject(err) : resolve()));
  });
  return hash.digest("hex");
}

/**
 * Pull a model: download → verify → parse → scaffold.
 *
 * Throws (and cleans up) on: missing/invalid id, an unresolvable digest, an
 * existing model folder, a failed download, or a sha256 mismatch.
 */
export async function pullModel(opts: PullModelOptions): Promise<PullModelResult> {
  const { id } = opts;
  if (!id || id.length === 0) throw new PullValidationError("pull requires --id");

  // Resolve the download URL + digest (ADR-0099).
  // - A repo shorthand (owner/repo[:file-or-quant]) is always resolved via
  //   the HF API to a download URL; the digest comes from the repo's LFS
  //   metadata unless an explicit --sha256 was given (explicit wins).
  // - A full HF resolve URL with an explicit digest needs no API lookup.
  // - A full HF resolve URL without a digest is resolved for its digest.
  // - Any other source requires an explicit --sha256 (ADR-0098).
  let url = opts.url;
  let sha256 = opts.sha256;
  const hasDigest = sha256 !== undefined && sha256.length > 0;
  const doFetch = opts.fetch ?? fetch;
  const ref = url && url.length > 0 ? parseHfRef(url) : undefined;
  const urlRef = url && url.length > 0 ? parseHfUrl(url) : undefined;
  if (ref || (urlRef && !hasDigest)) {
    const resolved = await resolveHfSource(url, doFetch);
    url = resolved.url;
    if (!hasDigest) sha256 = resolved.sha256;
  }
  if (sha256 === undefined || sha256.length === 0) {
    // Not a resolvable source and no digest: say exactly what to do.
    throw new PullValidationError(
      `pull requires --sha256 (64 hex chars) — no digest, no pull. ` +
        `Supported auto-resolving sources: HuggingFace repo shorthand (owner/repo[:file-or-quant]) or a huggingface.co resolve URL`,
    );
  }
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
        `model folder already exists: ${modelDir} — remove it first to re-pull. If you want to resume a download, remove the partial file (${fileName}.partial) and try again.`,
      );
    }
  }

  mkdirSync(modelDir, { recursive: true });
  const partial = `${dest}.partial`;
  const cleanup = (): void => {
    rmSync(partial, { force: true });
  };

  try {
    const resumed = await downloadWithResume(url, dest, doFetch, opts.onProgress);

    const actual = await sha256OfFile(partial);
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
    const ggufName =
      typeof meta.fields["general.name"] === "string"
        ? (meta.fields["general.name"] as string)
        : undefined;

    // Base model: derive from the download source when it is a HuggingFace
    // repo (owner/repo). The download host is the best available signal for
    // the upstream base model; the user can override in the draft YAML.
    const baseModel =
      ref && ref.owner && ref.repo
        ? `${ref.owner}/${ref.repo}`
        : urlRef && urlRef.owner && urlRef.repo
          ? `${urlRef.owner}/${urlRef.repo}`
          : undefined;

    // Model tier: draft adapter + empty bindings.
    const adapterPath = join(modelDir, `${id}.yaml`);
    writeFileSync(
      adapterPath,
      draftAdapterYaml({ id, family, fileName, sha256, profile, ggufName, baseModel }),
    );
    writeFileSync(join(modelDir, "bcb.jsonl"), EMPTY_JSON);
    writeFileSync(join(modelDir, "tcb.jsonl"), EMPTY_JSON);
    writeFileSync(join(modelDir, "server_setup.json"), EMPTY_JSON);

    // KV slot-save dirs for both fork variants (G3): llama-server requires
    // --slot-save-path to be an existing directory, so a fresh pull is
    // boot-ready without any extra step. The fork is a boot-time choice, so
    // both variants are scaffolded up front (cheap empty dirs).
    for (const fork of ["upstream", "cachyllama"] as const) {
      mkdirSync(slotSavePath(dest, fork), { recursive: true });
    }

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
