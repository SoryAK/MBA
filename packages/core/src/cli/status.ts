import { resolveServiceUrl, serviceGet } from "./client.js";
import { formatPairedSlotLines } from "./slot-print.js";
import { formatServerLine } from "./list-print.js";
import { brand, dim, heading, kv, paint, GRN, RED } from "./style.js";
import type { ModelEntry } from "./interactive.js";
import type { PairingSession, ServerEntry, ModelWatches } from "./types.js";

interface StatusBody {
  readonly pairing?: {
    readonly active: boolean;
    readonly blocked?: boolean;
    readonly count: number;
    readonly integrity?: "missing" | "valid" | "corrupt";
    readonly error?: string;
    readonly sessions?: readonly PairingSession[];
  };
  readonly registry?: {
    readonly blocked?: boolean;
    readonly count: number;
    readonly integrity?: "missing" | "valid" | "corrupt";
    readonly error?: string;
  };
}

function printServerRow(s: ServerEntry): void {
  process.stdout.write(`${formatServerLine(s)}\n`);
}

export async function cmdStatus(json: boolean): Promise<void> {
  const url = resolveServiceUrl();
  if (!url) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ service: "down", url: null }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${brand("status")}\n`);
    process.stdout.write(`${kv("service", paint("down", RED))}\n`);
    process.stdout.write(`  ${dim("mba start  or set MBA_SERVICE_URL")}\n`);
    return;
  }

  let models: ModelEntry[] = [];
  let servers: ServerEntry[] = [];
  let machine = "unknown";
  let pairing: StatusBody["pairing"];
  let registry: StatusBody["registry"];
  let watches: ModelWatches | undefined;
  try {
    const [m, s, overlay, st] = await Promise.all([
      serviceGet<{ models: ModelEntry[] }>(url, "/models"),
      serviceGet<{ servers: ServerEntry[] }>(url, "/servers"),
      serviceGet<{ mode: string }>(url, "/config/machine-overlay"),
      serviceGet<StatusBody>(url, "/status"),
    ]);
    models = [...m.models];
    servers = [...s.servers];
    machine = overlay.mode;
    pairing = st.pairing;
    registry = st.registry;
  } catch (err) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ service: "error", url, error: err instanceof Error ? err.message : String(err) }, null, 2)}\n`,
      );
      return;
    }
    process.stdout.write(`${brand("status")}\n`);
    process.stdout.write(`${kv("service", paint("error", RED))}\n`);
    process.stdout.write(`  ${dim(err instanceof Error ? err.message : String(err))}\n`);
    return;
  }

  const loaded = models.filter((m) => m.loaded);
  const sessions = pairing?.sessions ?? [];
  try {
    const loadedId = loaded[0]?.id;
    watches = loadedId
      ? await serviceGet<ModelWatches>(url, `/models/watches?id=${encodeURIComponent(loadedId)}`)
      : await serviceGet<ModelWatches>(url, "/models/watches");
  } catch {
    watches = undefined;
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          service: "up",
          url,
          machine,
          pairing: pairing
            ? { ...pairing, sessions }
            : { active: false, blocked: false, count: 0, integrity: "missing", sessions: [] },
          registry: registry
            ? { ...registry }
            : { blocked: false, count: 0, integrity: "missing" },
          loaded: loaded.map((m) => m.id),
          watches: watches
            ? {
                modelId: watches.modelId,
                watches: watches.watches.map((w) => ({
                  id: w.id,
                  mode: w.mode,
                  effective: w.effective,
                })),
              }
            : null,
          models: models.map((m) => ({ id: m.id, family: m.family, loaded: m.loaded })),
          servers: servers.map((s) => ({
            id: s.id,
            port: s.port,
            healthy: s.healthy,
            modelFile: s.modelFile,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`${brand("status")}\n`);
  process.stdout.write(`${kv("service", `${paint("up", GRN)}  ${dim(url)}`)}\n`);
  process.stdout.write(`${kv("machine", machine)}\n`);
  process.stdout.write(
    `${kv("loaded", loaded.length > 0 ? loaded.map((m) => m.id).join(", ") : dim("none"))}\n`,
  );
  process.stdout.write(`${kv("models", String(models.length))}\n`);
  const pairingLabel = pairing?.blocked
    ? `${paint("blocked", RED)}  ${dim("corrupt state")}`
    : pairing?.active
      ? `${paint("locked", GRN)}  ${pairing.count}`
      : dim("off");
  process.stdout.write(`${kv("pairing", pairingLabel)}\n`);
  if (pairing?.blocked && pairing.error) {
    process.stdout.write(`  ${dim(pairing.error)}\n`);
  }
  const registryLabel = registry?.blocked
    ? `${paint("blocked", RED)}  ${dim("corrupt state")}`
    : dim("ok");
  process.stdout.write(`${kv("registry", registryLabel)}\n`);
  if (registry?.blocked && registry.error) {
    process.stdout.write(`  ${dim(registry.error)}\n`);
  }
  if (watches) {
    const bits = watches.watches
      .map((w) => `${w.id} ${w.effective ? paint("on", GRN) : paint("off", RED)}`)
      .join("  ");
    const who = watches.modelId ?? "inherit";
    process.stdout.write(`${kv("watches", `${bits}  ${dim(who)}`)}\n`);
  }

  process.stdout.write(`\n  ${heading("clients")}\n`);
  if (sessions.length === 0) {
    process.stdout.write(`    ${dim("none")}\n`);
  } else {
    for (const line of formatPairedSlotLines(sessions)) {
      process.stdout.write(`${line}\n`);
    }
  }

  process.stdout.write(`\n  ${heading("servers")}\n`);
  if (servers.length === 0) {
    process.stdout.write(`    ${dim("none")}\n`);
    return;
  }
  for (const s of servers) printServerRow(s);
}
