/**
 * llama-server catalog for boot (host GPU backend, not a model fact).
 *
 * MBA does not compile llama.cpp. It lists binaries the operator already
 * built, tags each by the ggml backend next to it (cuda / hip / vulkan /
 * metal / cpu), and picks one per spawn. Last choice lives in MBA state so
 * the daemon does not need a restart when the operator switches.
 *
 * Known trees only — no crawl of $HOME. `MBA_LLAMA_SERVER_BIN` still wins
 * when set.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { MachineInfo } from "./machine-info.js";
import type { MbaStorePaths } from "./config-store.js";

export const LLAMA_SERVER_CHOICE_FILENAME = "llama-server.json";

export type LlamaBackend = "cuda" | "hip" | "vulkan" | "metal" | "cpu";
export type GpuVendor = "nvidia" | "amd" | "apple";

export interface LlamaServerBinary {
  readonly path: string;
  readonly backend: LlamaBackend;
}

export interface LlamaServerChoice {
  readonly path: string;
  readonly backend: LlamaBackend;
  readonly updatedAt: string;
}

export interface LlamaBinaryScan {
  readonly homedir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
}

export interface LlamaServerSelection {
  readonly catalog: readonly LlamaServerBinary[];
  readonly selected?: LlamaServerBinary;
  readonly recommended?: LlamaBackend;
  readonly warning?: string;
}

const BACKEND_LIBS: ReadonlyArray<{ readonly backend: LlamaBackend; readonly names: readonly string[] }> = [
  { backend: "cuda", names: ["libggml-cuda.so", "libggml-cuda.so.0", "libggml-cuda.dylib", "ggml-cuda.dll"] },
  { backend: "hip", names: ["libggml-hip.so", "libggml-hip.so.0", "libggml-hip.dylib", "ggml-hip.dll"] },
  { backend: "vulkan", names: ["libggml-vulkan.so", "libggml-vulkan.so.0", "libggml-vulkan.dylib", "ggml-vulkan.dll"] },
  { backend: "metal", names: ["libggml-metal.dylib", "ggml-metal.metal"] },
];

function liveExists(path: string): boolean {
  return existsSync(path);
}

function liveRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** State file for the last llama-server the operator booted. */
export function llamaServerChoicePath(paths: MbaStorePaths): string {
  return join(paths.baseDir, "mba", LLAMA_SERVER_CHOICE_FILENAME);
}

export function readLlamaServerChoice(paths: MbaStorePaths): LlamaServerChoice | undefined {
  const file = llamaServerChoicePath(paths);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.path !== "string" || rec.path.length === 0) return undefined;
    if (!isLlamaBackend(rec.backend)) return undefined;
    const updatedAt = typeof rec.updatedAt === "string" ? rec.updatedAt : "";
    return { path: rec.path, backend: rec.backend, updatedAt };
  } catch {
    return undefined;
  }
}

export function writeLlamaServerChoice(paths: MbaStorePaths, choice: LlamaServerBinary): void {
  const file = llamaServerChoicePath(paths);
  mkdirSync(dirname(file), { recursive: true });
  const body: LlamaServerChoice = {
    path: choice.path,
    backend: choice.backend,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

function isLlamaBackend(value: unknown): value is LlamaBackend {
  return value === "cuda" || value === "hip" || value === "vulkan" || value === "metal" || value === "cpu";
}

/**
 * Backend of a llama-server from sibling ggml libs (the wrapper binary
 * itself is tiny; cuda/hip/vulkan live next to it).
 */
export function inspectLlamaBackend(binPath: string, exists: (path: string) => boolean = liveExists): LlamaBackend {
  const dir = dirname(binPath);
  for (const row of BACKEND_LIBS) {
    if (row.names.some((name) => exists(join(dir, name)))) return row.backend;
  }
  return "cpu";
}

/** Known install locations. PATH entries come first after the env override. */
export function llamaServerCandidatePaths(homedir: string, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const override = env.MBA_LLAMA_SERVER_BIN;
  if (override && override.length > 0) out.push(override);

  const pathEnv = env.PATH ?? env.Path ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    out.push(join(dir, "llama-server"), join(dir, "llama-server.exe"));
  }

  out.push(
    join(homedir, ".local", "bin", "llama-server"),
    join(homedir, "llama.cpp", "build", "bin", "llama-server"),
    join(homedir, "llama.cpp", "build-cuda", "bin", "llama-server"),
    join(homedir, "llama.cpp", "build-hip", "bin", "llama-server"),
    join(homedir, "llama.cpp", "build-vulkan", "bin", "llama-server"),
    join(homedir, "llama-cuda", "build", "bin", "llama-server"),
    join(homedir, "llama-hip", "build", "bin", "llama-server"),
    "/usr/local/bin/llama-server",
    "/usr/bin/llama-server",
  );
  return out;
}

export function listLlamaServers(scan: LlamaBinaryScan = {}): LlamaServerBinary[] {
  const homedir = scan.homedir ?? osHomedir();
  const env = scan.env ?? process.env;
  const exists = scan.exists ?? liveExists;
  const seen = new Set<string>();
  const catalog: LlamaServerBinary[] = [];
  for (const raw of llamaServerCandidatePaths(homedir, env)) {
    if (!exists(raw)) continue;
    const resolved = liveRealpath(raw);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    catalog.push({ path: resolved, backend: inspectLlamaBackend(resolved, exists) });
  }
  return catalog;
}

const NVIDIA_RE = /nvidia|geforce|rtx|gtx|quadro|tesla|titan/i;
const AMD_RE = /\bamd\b|radeon|strix|instinct|ryzen ai/i;
const APPLE_RE = /\bapple\b|\bm[1-4](?:\s|$)|metal/i;

export function gpuVendors(info: MachineInfo | undefined): ReadonlySet<GpuVendor> {
  const out = new Set<GpuVendor>();
  if (!info) return out;
  if (info.os === "darwin") out.add("apple");
  for (const gpu of info.gpus ?? []) {
    const name = gpu.name ?? "";
    if (NVIDIA_RE.test(name)) out.add("nvidia");
    if (AMD_RE.test(name)) out.add("amd");
    if (APPLE_RE.test(name)) out.add("apple");
  }
  return out;
}

export function recommendBackend(
  vendors: ReadonlySet<GpuVendor>,
  catalog: readonly LlamaServerBinary[],
): LlamaBackend | undefined {
  const have = new Set(catalog.map((b) => b.backend));
  if (vendors.has("nvidia") && have.has("cuda")) return "cuda";
  if (vendors.has("amd") && have.has("hip")) return "hip";
  if (vendors.has("apple") && have.has("metal")) return "metal";
  if (vendors.size > 0 && have.has("vulkan")) return "vulkan";
  return catalog[0]?.backend;
}

export function binaryMismatchWarning(
  backend: LlamaBackend,
  vendors: ReadonlySet<GpuVendor>,
): string | undefined {
  if (vendors.size === 0) return undefined;
  if (backend === "cuda" && !vendors.has("nvidia")) return "CUDA build; no NVIDIA GPU detected";
  if (backend === "hip" && !vendors.has("amd")) return "HIP build; no AMD GPU detected";
  if (backend === "metal" && !vendors.has("apple")) return "Metal build; not an Apple GPU host";
  if (backend === "cpu") return "CPU-only llama-server; GPU is present";
  return undefined;
}

function samePath(a: string, b: string): boolean {
  return liveRealpath(a) === liveRealpath(b);
}

/**
 * Choose which catalog entry to spawn. Last successful boot wins; then
 * `MBA_LLAMA_SERVER_BIN`; then a backend that matches detected GPUs; then
 * the first catalog row.
 */
export function selectLlamaServer(opts: {
  readonly lastPath?: string;
  readonly machineInfo?: MachineInfo;
  readonly scan?: LlamaBinaryScan;
}): LlamaServerSelection {
  const env = opts.scan?.env ?? process.env;
  const catalog = listLlamaServers(opts.scan);
  const vendors = gpuVendors(opts.machineInfo);
  const recommended = recommendBackend(vendors, catalog);

  const override = env.MBA_LLAMA_SERVER_BIN;
  let selected: LlamaServerBinary | undefined;
  if (opts.lastPath && opts.lastPath.length > 0) {
    selected = catalog.find((b) => samePath(b.path, opts.lastPath!));
  }
  if (!selected && override && override.length > 0) {
    selected =
      catalog.find((b) => samePath(b.path, override)) ??
      (opts.scan?.exists?.(override) || liveExists(override)
        ? { path: liveRealpath(override), backend: inspectLlamaBackend(override, opts.scan?.exists ?? liveExists) }
        : { path: override, backend: inspectLlamaBackend(override, opts.scan?.exists ?? liveExists) });
  }
  if (!selected && recommended) {
    selected = catalog.find((b) => b.backend === recommended);
  }
  if (!selected) selected = catalog[0];

  const warning = selected ? binaryMismatchWarning(selected.backend, vendors) : undefined;
  return { catalog, selected, recommended, warning };
}
