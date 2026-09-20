import { resolveServiceUrl, serviceGet } from "./client.js";
import { formatPairedSlotLines } from "./slot-print.js";
import { formatServerLine } from "./list-print.js";
import { brand, dim, heading, kv, paint, GRN, RED } from "./style.js";
import type { StatusSnapshot } from "../service/status-snapshot.js";

export function statusView(url: string, snapshot: StatusSnapshot) {
  const loaded = snapshot.models.filter((m) => m.loaded);
  const watches = snapshot.watches;
  return {
    service: "up" as const,
    url,
    machine: snapshot.machineOverlay.mode,
    pairing: snapshot.pairing,
    registry: snapshot.registry,
    loaded: loaded.map((m) => m.id),
    watches: {
      modelId: watches.modelId,
      watches: watches.watches.map((w) => ({
        id: w.id,
        mode: w.mode,
        effective: w.effective,
      })),
    },
    models: snapshot.models.map((m) => ({ id: m.id, family: m.family, loaded: m.loaded })),
    servers: snapshot.servers.map((s) => ({
      id: s.id,
      port: s.port,
      healthy: s.healthy,
      modelFile: s.modelFile,
    })),
  };
}

function printServerRow(s: StatusSnapshot["servers"][number]): void {
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

  let snapshot: StatusSnapshot;
  try {
    snapshot = await serviceGet<StatusSnapshot>(url, "/status");
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

  if (json) {
    process.stdout.write(`${JSON.stringify(statusView(url, snapshot), null, 2)}\n`);
    return;
  }

  const loaded = snapshot.models.filter((m) => m.loaded);
  const sessions = snapshot.pairing.sessions;
  const pairing = snapshot.pairing;
  const registry = snapshot.registry;
  const machine = snapshot.machineOverlay.mode;
  const watches = snapshot.watches;

  process.stdout.write(`${brand("status")}\n`);
  process.stdout.write(`${kv("service", `${paint("up", GRN)}  ${dim(url)}`)}\n`);
  process.stdout.write(`${kv("machine", machine)}\n`);
  process.stdout.write(
    `${kv("loaded", loaded.length > 0 ? loaded.map((m) => m.id).join(", ") : dim("none"))}\n`,
  );
  process.stdout.write(`${kv("models", String(snapshot.models.length))}\n`);
  const pairingLabel = pairing.blocked
    ? `${paint("blocked", RED)}  ${dim("corrupt state")}`
    : pairing.active
      ? `${paint("locked", GRN)}  ${pairing.count}`
      : dim("off");
  process.stdout.write(`${kv("pairing", pairingLabel)}\n`);
  if (pairing.blocked && pairing.error) {
    process.stdout.write(`  ${dim(pairing.error)}\n`);
  }
  const registryLabel = registry.blocked
    ? `${paint("blocked", RED)}  ${dim("corrupt state")}`
    : dim("ok");
  process.stdout.write(`${kv("registry", registryLabel)}\n`);
  if (registry.blocked && registry.error) {
    process.stdout.write(`  ${dim(registry.error)}\n`);
  }
  const bits = watches.watches
    .map((w) => `${w.id} ${w.effective ? paint("on", GRN) : paint("off", RED)}`)
    .join("  ");
  const who = watches.modelId ?? "inherit";
  process.stdout.write(`${kv("watches", `${bits}  ${dim(who)}`)}\n`);

  process.stdout.write(`\n  ${heading("clients")}\n`);
  if (sessions.length === 0) {
    process.stdout.write(`    ${dim("none")}\n`);
  } else {
    for (const line of formatPairedSlotLines(sessions)) {
      process.stdout.write(`${line}\n`);
    }
  }

  process.stdout.write(`\n  ${heading("servers")}\n`);
  if (snapshot.servers.length === 0) {
    process.stdout.write(`    ${dim("none")}\n`);
    return;
  }
  for (const s of snapshot.servers) printServerRow(s);
}
