/**
 * Global MBA config store (ADR-0092 Step 2).
 *
 * Owns the GLOBAL rule state on disk — the TCB config and the global
 * rule-class layer. This is the state `set_rules` mutates and the proxy
 * invalidates its cache against via the version counter.
 *
 * Design (converged 2026-08-20):
 *   - GLOBAL, not per-project. BCB/TCB guard against model failure modes,
 *     which are model-tier, not workspace-tier. Project overrides are a v2
 *     merge layer (the resolver already accepts the slot).
 *   - FILES ARE TRUTH. The store reads/writes JSON on disk; any external
 *     edit is picked up on the next read. The store is restartable with zero
 *     data loss.
 *   - ATOMIC WRITES. write-temp → rename so a crash never leaves a torn file.
 *   - VERSION COUNTER. Bumped on every mutation the store performs. The proxy
 *     caches the merged config and re-fetches when the version changes.
 *
 * Layout under the base dir (default `~/.cyard`):
 *   bcb/tool-circuit-breakers.json  — global TCB config
 *   mba/rule-classes.json           — global rule-class layer
 *   mba/version.json                — { version: number }
 *
 * First-boot migration (Option A): if the global TCB file is missing, copy an
 * existing per-project `.cyard-store/bcb/tool-circuit-breakers.json` (the
 * user's live config) so nothing changes for them; if that's missing too,
 * seed from the built-in defaults.
 *
 * Pure-ish: all fs I/O is explicit and injected-friendly via the `paths`
 * parameter so tests can point at a temp dir. No globals, no implicit DB.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultToolCircuitBreakerConfig } from "../bcb/default-config.js";
import { isToolCircuitBreakerConfig } from "../bcb/is-config.js";
import type { ToolCircuitBreakerConfig } from "../bcb/types.js";
import { isRuleClassRegistry, type RuleClassRegistry } from "../bcb/rule-classes.js";

/** Resolved on-disk locations for the global store. */
export interface MbaStorePaths {
  readonly baseDir: string;
  readonly tcbPath: string;
  readonly ruleClassesPath: string;
  readonly versionPath: string;
  /** Discovery file the service writes on boot so consumers can find it. */
  readonly serviceInfoPath: string;
}

/** Result of a store read. */
export interface MbaGlobalConfig {
  readonly tcb: ToolCircuitBreakerConfig;
  readonly ruleClasses: RuleClassRegistry;
  readonly version: number;
}

/** Result of a `set_rules` mutation. */
export interface MbaSetRulesResult {
  readonly version: number;
  readonly tcb: ToolCircuitBreakerConfig;
}

export function defaultStorePaths(baseDir: string = join(homedir(), ".cyard")): MbaStorePaths {
  return {
    baseDir,
    tcbPath: join(baseDir, "bcb", "tool-circuit-breakers.json"),
    ruleClassesPath: join(baseDir, "mba", "rule-classes.json"),
    versionPath: join(baseDir, "mba", "version.json"),
    serviceInfoPath: join(baseDir, "mba", "service.json"),
  };
}

/** Discovery record the service writes on boot (port + pid). */
export interface MbaServiceInfo {
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
}

export function writeServiceInfo(paths: MbaStorePaths, info: MbaServiceInfo): void {
  atomicWriteJson(paths.serviceInfoPath, info);
}

export function readServiceInfoOrNull(paths: MbaStorePaths): MbaServiceInfo | null {
  const raw = readJsonOrNull(paths.serviceInfoPath) as
    | { port?: unknown; pid?: unknown; startedAt?: unknown }
    | null;
  if (
    !raw ||
    typeof raw.port !== "number" ||
    typeof raw.pid !== "number" ||
    typeof raw.startedAt !== "string"
  ) {
    return null;
  }
  return { port: raw.port, pid: raw.pid, startedAt: raw.startedAt };
}

/**
 * The per-project TCB config path the proxy used before the global store
 * existed. Used only as a first-boot migration source (Option A).
 */
export function legacyProjectTcbPath(projectRoot: string): string {
  return join(projectRoot, ".cyard-store", "bcb", "tool-circuit-breakers.json");
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function readJsonOrNull(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Read the global config, migrating/seeding on first boot.
 *
 * - TCB: global file → (if missing) legacy per-project file (copied in) →
 *   (if missing) built-in defaults (written).
 * - Rule classes: global file → (if missing) empty registry.
 * - Version: version file → (if missing) 0.
 */
export function readGlobalConfig(
  paths: MbaStorePaths,
  opts: { readonly legacyTcbPath?: string } = {},
): MbaGlobalConfig {
  // TCB config with first-boot migration.
  let tcb: ToolCircuitBreakerConfig | undefined;
  const globalTcb = readJsonOrNull(paths.tcbPath);
  if (isToolCircuitBreakerConfig(globalTcb)) {
    tcb = globalTcb;
  } else if (opts.legacyTcbPath && existsSync(opts.legacyTcbPath)) {
    const legacy = readJsonOrNull(opts.legacyTcbPath);
    if (isToolCircuitBreakerConfig(legacy)) {
      tcb = legacy;
      atomicWriteJson(paths.tcbPath, legacy); // Option A: move the user's live config.
    }
  }
  if (!tcb) {
    tcb = defaultToolCircuitBreakerConfig();
    atomicWriteJson(paths.tcbPath, tcb);
  }

  // Global rule-class layer (optional).
  const rcRaw = readJsonOrNull(paths.ruleClassesPath);
  const ruleClasses: RuleClassRegistry = isRuleClassRegistry(rcRaw) ? rcRaw : {};

  // Version counter.
  const vRaw = readJsonOrNull(paths.versionPath) as { version?: unknown } | null;
  const version =
    vRaw && typeof vRaw.version === "number" && Number.isFinite(vRaw.version) ? vRaw.version : 0;

  return { tcb, ruleClasses, version };
}

/**
 * Persist a new TCB config (and optionally the global rule-class layer),
 * bumping the version. Atomic. Returns the new version + the stored TCB.
 */
export function setRules(
  paths: MbaStorePaths,
  input: { readonly tcb: ToolCircuitBreakerConfig; readonly ruleClasses?: RuleClassRegistry },
): MbaSetRulesResult {
  if (!isToolCircuitBreakerConfig(input.tcb)) {
    throw new Error("set_rules: invalid TCB config shape");
  }
  if (input.ruleClasses !== undefined && !isRuleClassRegistry(input.ruleClasses)) {
    throw new Error("set_rules: invalid rule-class registry shape");
  }

  atomicWriteJson(paths.tcbPath, input.tcb);
  if (input.ruleClasses !== undefined) {
    atomicWriteJson(paths.ruleClassesPath, input.ruleClasses);
  }

  const current = readJsonOrNull(paths.versionPath) as { version?: unknown } | null;
  const next =
    current && typeof current.version === "number" && Number.isFinite(current.version)
      ? current.version + 1
      : 1;
  atomicWriteJson(paths.versionPath, { version: next });

  return { version: next, tcb: input.tcb };
}
