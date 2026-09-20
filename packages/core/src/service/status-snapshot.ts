/**
 * One house snapshot for GET /status.
 *
 * `mba status` used to assemble models, servers, overlay, pairing, registry,
 * and watches from five GETs. Those facts already live on the daemon; this
 * block owns the combined payload so the CLI is one GET. GET /models and
 * GET /servers stay as focused doors and reuse the same list helpers.
 */

import { resolve } from "node:path";
import { envelopeRelativePath } from "../mba/envelope.js";
import { readEnvelopeOwner } from "../mba/stage-instructions.js";
import { readGlobalConfig, type MbaStorePaths } from "./config-store.js";
import { readModelCatalog, type CatalogEntry } from "./model-catalog.js";
import { notesPreview, readModelShelf, type ModelNotesPreview } from "./model-config.js";
import { isLoadedPath, probeLoadedModel } from "./model-switch.js";
import { defaultWatches, readModelWatches, type ModelWatches } from "./model-watches.js";
import { operatorEnvelopeBindings, readOperatorClients } from "./operator-clients.js";
import {
  pairingActive,
  publicSessions,
  readSessions,
  type PublicSession,
} from "./sessions.js";
import {
  listUpstreams,
  readRegistry,
  resolveUpstream,
  type RegistryReadResult,
  type UpstreamEntry,
} from "./upstream-registry.js";
import { getServerTypeOps } from "./server-types.js";

export interface StatusCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly family?: string;
  readonly modelFile?: string;
  readonly loaded: boolean;
  readonly notes?: ModelNotesPreview;
}

export interface StatusServerRow {
  readonly id: string;
  readonly serverType: string;
  readonly modelFile: string;
  readonly port: number;
  readonly fork?: "upstream" | "llama.cpp";
  readonly pid?: number;
  readonly startedAt: string;
  readonly healthy: boolean;
  readonly resolved: boolean;
  readonly duplicate: boolean;
}

export interface StatusPairingSession extends PublicSession {
  readonly card: boolean;
  readonly envelope?: string;
}

export interface StatusPairing {
  readonly active: boolean;
  readonly blocked: boolean;
  readonly count: number;
  readonly integrity: "missing" | "valid" | "corrupt";
  readonly sessions: readonly StatusPairingSession[];
  readonly error?: string;
}

export interface StatusRegistry {
  readonly blocked: boolean;
  readonly count: number;
  readonly integrity: "missing" | "valid" | "corrupt";
  readonly error?: string;
}

export type StatusClients = StatusRegistry;

export interface StatusSnapshot {
  readonly version: number;
  readonly uptimeMs: number;
  readonly pairing: StatusPairing;
  readonly registry: StatusRegistry;
  readonly clients: StatusClients;
  readonly paths: {
    readonly baseDir: string;
    readonly tcbPath: string;
    readonly ruleClassesPath: string;
    readonly versionPath: string;
    readonly machineOverlayPath: string;
    readonly modelHistoryPath: string;
  };
  readonly machineOverlay: { readonly mode: string };
  readonly models: readonly StatusCatalogModel[];
  readonly servers: readonly StatusServerRow[];
  readonly watches: ModelWatches;
}

export interface StatusSnapshotOpts {
  readonly paths: MbaStorePaths;
  readonly adapterDir: string;
  readonly upstreamUrl?: string;
  readonly fetch?: typeof fetch;
  readonly startedAt: number;
}

/**
 * Probe whether `entry`'s model is loaded, resolving the probe target per
 * model (ADR-0097 Phase 1): upstream registry → adapter `client.url` →
 * `MBA_UPSTREAM_URL` → "not loaded".
 *
 * Lazy validation (G2): the registry is read once per call; candidates are
 * probed in resolve order (most-recently-booted first) and a dead or stale
 * entry is dropped on read — the next candidate, then the next rung, is
 * tried. No sweeper, no timers.
 */
export async function probeModelLoaded(
  entry: CatalogEntry,
  paths: MbaStorePaths,
  envUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const registryState = readRegistry(paths.upstreamsPath);
  // Chat routing already fails closed on corrupt. Loaded-probes skip the
  // registry rung rather than inventing an empty guest book.
  const registry = registryState.kind === "corrupt" ? [] : registryState.entries;
  for (const candidate of entry.modelFile ? listUpstreams(registry, entry.modelFile) : []) {
    const probed = await probeLoadedModel(`http://127.0.0.1:${candidate.port}`, fetchImpl);
    if (probed !== null && isLoadedPath(probed, entry.modelFile)) return probed;
  }
  if (entry.clientUrl) {
    const probed = await probeLoadedModel(entry.clientUrl.replace(/\/v1\/?$/, ""), fetchImpl);
    if (probed !== null && isLoadedPath(probed, entry.modelFile)) return probed;
  }
  if (envUrl) {
    const probed = await probeLoadedModel(envUrl, fetchImpl);
    if (probed !== null && isLoadedPath(probed, entry.modelFile)) return probed;
  }
  return null;
}

/**
 * Probe a server's /health endpoint. Unreachable or non-2xx → false (the
 * probe is advisory; a dead server is "not healthy", never an error).
 */
export async function probeServerHealth(port: number, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listCatalogModels(opts: {
  readonly adapterDir: string;
  readonly paths: MbaStorePaths;
  readonly upstreamUrl?: string;
  readonly fetch?: typeof fetch;
}): Promise<StatusCatalogModel[]> {
  const catalog = readModelCatalog(opts.adapterDir);
  const fetchImpl = opts.fetch ?? fetch;
  return Promise.all(
    catalog.map(async (e) => ({
      id: e.id,
      name: e.name,
      family: e.family,
      modelFile: e.modelFile,
      loaded: isLoadedPath(
        await probeModelLoaded(e, opts.paths, opts.upstreamUrl, fetchImpl),
        e.modelFile,
      ),
      notes: notesPreview(readModelShelf(opts.adapterDir, e.id)?.notes),
    })),
  );
}

export async function listRegistryServers(
  registryState: RegistryReadResult,
  fetchImpl: typeof fetch,
): Promise<StatusServerRow[]> {
  if (registryState.kind === "corrupt") return [];
  const registry = registryState.entries;
  const health = new Map<string, boolean>();
  await Promise.all(
    registry.map(async (e) => {
      const ops = getServerTypeOps(e.serverType);
      health.set(
        e.id,
        ops ? await ops.health(e, fetchImpl) : await probeServerHealth(e.port, fetchImpl),
      );
    }),
  );
  const healthyIds = new Set(registry.filter((e) => health.get(e.id)).map((e) => e.id));
  return registry.map((e) => serverRow(e, registry, health, healthyIds));
}

function serverRow(
  e: UpstreamEntry,
  registry: readonly UpstreamEntry[],
  health: ReadonlyMap<string, boolean>,
  healthyIds: ReadonlySet<string>,
): StatusServerRow {
  const resolved = resolveUpstream(registry, e.modelFile, healthyIds)?.id === e.id;
  const duplicate = !resolved && listUpstreams(registry, e.modelFile).length > 1;
  return {
    id: e.id,
    serverType: e.serverType,
    modelFile: e.modelFile,
    port: e.port,
    fork: e.fork,
    pid: e.pid,
    startedAt: e.startedAt,
    healthy: health.get(e.id) ?? false,
    resolved,
    duplicate,
  };
}

export function watchesForStatus(
  adapterDir: string,
  models: readonly StatusCatalogModel[],
): ModelWatches {
  const loaded = models.find((m) => m.loaded);
  if (!loaded) return defaultWatches();
  return readModelWatches(adapterDir, loaded.id) ?? defaultWatches();
}

export async function buildStatusSnapshot(opts: StatusSnapshotOpts): Promise<StatusSnapshot> {
  const cfg = readGlobalConfig(opts.paths);
  const sessionState = readSessions(opts.paths.sessionsPath);
  const sessions = sessionState.sessions;
  const registryState = readRegistry(opts.paths.upstreamsPath);
  const registry = registryState.entries;
  const fetchImpl = opts.fetch ?? fetch;
  const models = await listCatalogModels({
    adapterDir: opts.adapterDir,
    paths: opts.paths,
    upstreamUrl: opts.upstreamUrl,
    fetch: fetchImpl,
  });
  const servers = await listRegistryServers(registryState, fetchImpl);
  const clientState = readOperatorClients(opts.paths.clientsPath);
  const extras = operatorEnvelopeBindings(clientState.clients);
  const ownerBySlot = new Map<string, string | undefined>();
  const sessionsOut = publicSessions(sessions).map((s) => {
    const key = `${s.harness}\0${resolve(s.projectRoot)}`;
    if (!ownerBySlot.has(key)) {
      ownerBySlot.set(key, readEnvelopeOwner(s.projectRoot, s.harness, extras, s.ide));
    }
    return {
      ...s,
      card: ownerBySlot.get(key) === s.modelId,
      envelope: envelopeRelativePath(s.harness, s.ide, extras),
    };
  });
  return {
    version: cfg.version,
    uptimeMs: Date.now() - opts.startedAt,
    pairing: {
      active: pairingActive(sessions),
      blocked: sessionState.kind === "corrupt",
      count: sessions.length,
      integrity: sessionState.kind,
      sessions: sessionsOut,
      ...(sessionState.kind === "corrupt" ? { error: sessionState.error } : {}),
    },
    registry: {
      blocked: registryState.kind === "corrupt",
      count: registry.length,
      integrity: registryState.kind,
      ...(registryState.kind === "corrupt" ? { error: registryState.error } : {}),
    },
    clients: {
      blocked: clientState.kind === "corrupt",
      count: clientState.clients.length,
      integrity: clientState.kind,
      ...(clientState.kind === "corrupt" ? { error: clientState.error } : {}),
    },
    paths: {
      baseDir: opts.paths.baseDir,
      tcbPath: opts.paths.tcbPath,
      ruleClassesPath: opts.paths.ruleClassesPath,
      versionPath: opts.paths.versionPath,
      machineOverlayPath: opts.paths.machineOverlayPath,
      modelHistoryPath: opts.paths.modelHistoryPath,
    },
    machineOverlay: { mode: cfg.machineOverlay },
    models,
    servers,
    watches: watchesForStatus(opts.adapterDir, models),
  };
}
