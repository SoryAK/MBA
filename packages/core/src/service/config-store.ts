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
 * Layout under the base dir (default `~/.mba`):
 *   bcb/tool-circuit-breakers.json  — global TCB config
 *   mba/rule-classes.json           — global rule-class layer
 *   mba/version.json                — { version: number }
 *
 * First-boot seed: if the global TCB file is missing, seed it from the
 * built-in defaults.
 *
 * Base-dir migration: the store originally lived under `~/.cyard` (MBA's
 * C-Yard origin). `migrateLegacyBaseDir` copies any state found there into
 * the new `~/.mba` location on first boot — copy, never overwrite, and the
 * legacy files are left in place.
 *
 * Pure-ish: all fs I/O is explicit and injected-friendly via the `paths`
 * parameter so tests can point at a temp dir. No globals, no implicit DB.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
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

export function defaultStorePaths(baseDir: string = join(homedir(), ".mba")): MbaStorePaths {
  return {
    baseDir,
    tcbPath: join(baseDir, "bcb", "tool-circuit-breakers.json"),
    ruleClassesPath: join(baseDir, "mba", "rule-classes.json"),
    versionPath: join(baseDir, "mba", "version.json"),
    serviceInfoPath: join(baseDir, "mba", "service.json"),
  };
}

/**
 * One-time migration from the legacy `~/.cyard` base dir to `~/.mba`.
 *
 * Copies every file under the legacy dir into the new one, preserving the
 * relative layout. Copy, never overwrite: files already present in the new
 * dir win. Legacy files are left in place (no delete) so a rollback is
 * trivial. No-op when the legacy dir does not exist.
 *
 * Returns the list of files copied (empty when nothing to migrate).
 */
export function migrateLegacyBaseDir(
  legacyBaseDir: string = join(homedir(), ".cyard"),
  newBaseDir: string = join(homedir(), ".mba"),
): string[] {
  if (!existsSync(legacyBaseDir) || legacyBaseDir === newBaseDir) return [];
  const copied: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const src = join(dir, entry.name);
      const rel = relative(legacyBaseDir, src);
      const dest = join(newBaseDir, rel);
      if (entry.isDirectory()) {
        mkdirSync(dest, { recursive: true });
        walk(src);
      } else if (entry.isFile() && !existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        copied.push(rel);
      }
    }
  };
  walk(legacyBaseDir);
  return copied;
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
 * Read the global config, seeding on first boot.
 *
 * - TCB: global file → (if missing) built-in defaults (written).
 * - Rule classes: global file → (if missing) empty registry.
 * - Version: version file → (if missing) 0.
 */
export function readGlobalConfig(paths: MbaStorePaths): MbaGlobalConfig {
  // TCB config with first-boot seed.
  let tcb: ToolCircuitBreakerConfig | undefined;
  const globalTcb = readJsonOrNull(paths.tcbPath);
  if (isToolCircuitBreakerConfig(globalTcb)) {
    tcb = globalTcb;
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
