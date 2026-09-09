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
 *   <store>/<family>/instructions.md|notes.md
 *   <store>/<family>/<id>/<id>.yaml         (draft adapter, TODO-marked)
 *   <store>/<family>/<id>/<file>.gguf
 *   <store>/<family>/<id>/bcb.jsonl|tcb.jsonl|server_setup.json
 *   <store>/<family>/<id>/instructions.md|notes.md
 *   <store>/<family>/<id>/kv/<fork>/slots   (G3 slot-save dirs, both forks)
 *
 * The download is the only network step; sha256 is updated as bytes arrive
 * (a resumed `.partial` is hashed from disk first). Everything after the
 * digest check is local filesystem work. A failed verify deletes the partial
 * and leaves no scaffold behind. If weights land but the house fails to
 * write, the GGUF is kept; the same pull command finishes the scaffold
 * without downloading again.
 */

import { createHash, type Hash } from "node:crypto";
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
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { slotSavePath } from "../mba/server-lifecycle.js";
import { defaultModelStoreRoot } from "../service/paths.js";
import {
  draftAdapterYaml,
  draftFamilyYaml,
} from "./draft-adapter.js";
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

async function writeIfAbsent(path: string, content: string): Promise<void> {
  if (existsSync(path)) return;
  await writeFile(path, content);
}

/**
 * Empty bindings, cards, and KV dirs. Does not need the GGUF header.
 * Started beside header parse so libuv can write while the main thread reads.
 * Returns whether this pull created the family tier.
 * Existing files are left alone so a retry after a failed scaffold cannot
 * clobber a card the operator already filled.
 */
async function writeEmptyScaffolds(
  modelDir: string,
  familyDir: string,
  family: string,
  dest: string,
): Promise<boolean> {
  const jobs: Promise<unknown>[] = [
    writeIfAbsent(join(modelDir, "bcb.jsonl"), EMPTY_JSON),
    writeIfAbsent(join(modelDir, "tcb.jsonl"), EMPTY_JSON),
    writeIfAbsent(join(modelDir, "server_setup.json"), EMPTY_JSON),
    writeIfAbsent(join(modelDir, "instructions.md"), ""),
    writeIfAbsent(join(modelDir, "notes.md"), ""),
    mkdir(slotSavePath(dest, "upstream"), { recursive: true }),
    mkdir(slotSavePath(dest, "llama.cpp"), { recursive: true }),
  ];

  const familyYaml = join(familyDir, "family.yaml");
  const familyCreated = !existsSync(familyYaml);
  if (familyCreated) {
    jobs.push(
      writeIfAbsent(familyYaml, draftFamilyYaml({ family })),
      writeIfAbsent(join(familyDir, "bcb.jsonl"), EMPTY_JSON),
      writeIfAbsent(join(familyDir, "tcb.jsonl"), EMPTY_JSON),
      writeIfAbsent(join(familyDir, "structural.json"), EMPTY_JSON),
      writeIfAbsent(join(familyDir, "server_setup.json"), EMPTY_JSON),
      writeIfAbsent(join(familyDir, "instructions.md"), ""),
      writeIfAbsent(join(familyDir, "notes.md"), ""),
    );
  }
  await Promise.all(jobs);
  return familyCreated;
}

/**
 * How to treat an existing model folder.
 * - fresh: missing or empty — download
 * - resume: only the matching `.partial` — Range-append
 * - finish: weights are there, adapter YAML is not — skip download, write the house
 * - conflict: anything else (already pulled, or junk)
 */
function planModelDir(
  modelDir: string,
  fileName: string,
  id: string,
): "fresh" | "resume" | "finish" | "conflict" {
  if (!existsSync(modelDir)) return "fresh";
  const entries = readdirSync(modelDir);
  if (entries.length === 0) return "fresh";
  if (entries.length === 1 && entries[0] === `${fileName}.partial`) return "resume";
  if (entries.includes(fileName) && !entries.includes(`${id}.yaml`)) return "finish";
  return "conflict";
}

/** Bad input (missing/invalid id, sha256, or url) → HTTP 400. */
export class PullValidationError extends Error {}
/** The model folder already exists → HTTP 409. */
export class PullConflictError extends Error {}
/** Downloaded content does not match the expected digest → HTTP 422. */
export class PullVerifyError extends Error {}

/** Family and model folder names — one store segment, no `..` or separators. */
const STORE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeStoreSegment(kind: "id" | "family", value: string): void {
  if (!STORE_SEGMENT.test(value)) {
    throw new PullValidationError(
      `${kind} must be a single path segment (letters, digits, '.', '_', '-')`,
    );
  }
}

function assertInsideStore(storeRoot: string, target: string): void {
  const root = resolve(storeRoot);
  const resolved = resolve(target);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PullValidationError("id and family must stay inside the model store");
  }
}

function resolveStoreRoot(storeRoot?: string): string {
  if (storeRoot && storeRoot.length > 0) return storeRoot;
  const env = process.env.MBA_ADAPTER_DIR;
  if (env && env.length > 0) return env;
  return defaultModelStoreRoot();
}

/**
 * Feed an existing file into a running hasher (resume prefix). Constant
 * memory — same rule as `sha256OfFile`.
 */
async function feedHashFromFile(hash: Hash, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(path);
    rs.on("error", reject);
    rs.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    rs.on("end", () => resolve());
  });
}

/**
 * Download `url` to `dest`, resuming from an existing `<dest>.partial` when
 * present. Hashes the same bytes that are written (and the resume prefix
 * from disk). Returns whether a resume happened and the digest of the
 * completed partial.
 */
async function downloadWithResume(
  url: string,
  dest: string,
  doFetch: typeof fetch,
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<{ resumed: boolean; digest: string }> {
  const partial = `${dest}.partial`;
  let start = 0;
  if (existsSync(partial)) {
    start = statSync(partial).size;
  }

  const headers: Record<string, string> = {};
  if (start > 0) headers.Range = `bytes=${start}-`;

  const res = await doFetch(url, { headers });

  if (start > 0 && res.status === 416) {
    // The partial already covers the whole file — hash what is on disk.
    return { resumed: true, digest: await sha256OfFile(partial) };
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
  const hash = createHash("sha256");
  if (start > 0) {
    await feedHashFromFile(hash, partial);
  }

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

      hash.update(value);
      downloadedBytes += value.length;
      onProgress?.(downloadedBytes, totalSize);

      // Respect backpressure: when the write buffer is full, wait for drain
      // before pulling the next chunk (multi-GB GGUFs must not buffer
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
    return { resumed: start > 0, digest: hash.digest("hex") };
  } catch (error) {
    fileStream.destroy();
    throw error;
  }
}

/**
 * Stream a file's sha256 in constant memory. Multi-GB GGUFs must never be
 * read whole into a Buffer just to hash them. Pull hashes as it downloads;
 * this helper is the 416 (already-complete partial) path and tests.
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
  const family = opts.family && opts.family.length > 0 ? opts.family : id;
  assertSafeStoreSegment("id", id);
  assertSafeStoreSegment("family", family);

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

  const storeRoot = resolveStoreRoot(opts.storeRoot);
  const familyDir = join(storeRoot, family);
  const modelDir = join(familyDir, id);

  const fileName = basename(new URL(url).pathname) || "model.gguf";
  if (fileName === "." || fileName === ".." || fileName.includes("/") || fileName.includes("\\")) {
    throw new PullValidationError("download url must end in a file name inside the model folder");
  }
  const dest = join(modelDir, fileName);
  assertInsideStore(storeRoot, familyDir);
  assertInsideStore(storeRoot, modelDir);
  assertInsideStore(storeRoot, dest);

  const dirPlan = planModelDir(modelDir, fileName, id);
  if (dirPlan === "conflict") {
    throw new PullConflictError(
      `model folder already exists: ${modelDir} — remove it first to re-pull`,
    );
  }

  mkdirSync(modelDir, { recursive: true });
  const partial = `${dest}.partial`;
  const cleanupPartial = (): void => {
    rmSync(partial, { force: true });
  };

  let resumed = false;
  if (dirPlan === "finish") {
    const actual = await sha256OfFile(dest);
    if (actual !== sha256.toLowerCase()) {
      throw new PullVerifyError(
        `sha256 mismatch: expected ${sha256.toLowerCase()}, got ${actual} — existing weights left in place; remove ${modelDir} to re-pull`,
      );
    }
  } else {
    const downloaded = await downloadWithResume(url, dest, doFetch, opts.onProgress);
    resumed = downloaded.resumed;
    if (downloaded.digest !== sha256.toLowerCase()) {
      cleanupPartial();
      throw new PullVerifyError(
        `sha256 mismatch: expected ${sha256.toLowerCase()}, got ${downloaded.digest} — partial deleted`,
      );
    }
    renameSync(partial, dest);
  }

  const adapterPath = join(modelDir, `${id}.yaml`);
  try {
    // Empty files do not need the header. Kick them to the fs threadpool
    // so they overlap the (sync) header parse on this thread. YAML is last
    // so a missing adapter is the signal that the house is unfinished.
    const scaffold = writeEmptyScaffolds(modelDir, familyDir, family, dest);

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

    const familyCreated = await scaffold;
    if (!existsSync(adapterPath)) {
      writeFileSync(
        adapterPath,
        draftAdapterYaml({ id, family, fileName, sha256, profile, ggufName, baseModel }),
      );
    }
    cleanupPartial();

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
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `weights verified at ${dest}; scaffold failed: ${detail} — re-run the same pull to finish the house`,
    );
  }
}
