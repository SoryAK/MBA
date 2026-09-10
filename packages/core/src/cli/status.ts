import { formatClientLabel } from "../service/env-context.js";
import { brand, dim, heading, kv, paint, shortenHome, BOLD, GRN, RED } from "./style.js";
import type { ModelEntry } from "./interactive.js";
import type { ServerEntry } from "./types.js";

interface PublicSession {
  readonly id: string;
  readonly modelId: string;
  readonly harness: string;
  readonly ide?: string;
  readonly projectRoot: string;
  readonly createdAt: string;
  readonly card?: boolean;
}

interface StatusBody {
  readonly pairing?: {
    readonly active: boolean;
    readonly count: number;
    readonly sessions?: readonly PublicSession[];
  };
}

function printServerRow(s: ServerEntry): void {
  const health = s.healthy ? paint("ok", GRN) : paint("down", RED);
  const pid = s.pid !== undefined ? String(s.pid) : "-";
  process.stdout.write(
    `    ${paint(s.id.padEnd(18), BOLD)}  ${String(s.port).padEnd(5)}  ${pid.padEnd(7)}  ${health}  ${dim(s.modelFile)}\n`,
  );
}

function printSessionRow(s: PublicSession): void {
  const who = formatClientLabel(s.harness, s.ide);
  const tag = (s.card ? "card" : "pair").padEnd(4);
  process.stdout.write(
    `    ${paint(who.padEnd(18), BOLD)}  ${s.modelId.padEnd(22)}  ${s.card ? paint(tag, GRN) : dim(tag)}  ${dim(shortenHome(s.projectRoot))}\n`,
  );
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
    process.stdout.write(`  ${dim("start the service or set MBA_SERVICE_URL")}\n`);
    return;
  }

  let models: ModelEntry[] = [];
  let servers: ServerEntry[] = [];
  let machine = "unknown";
  let pairing: StatusBody["pairing"];
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

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          service: "up",
          url,
          machine,
          pairing: pairing
            ? { active: pairing.active, count: pairing.count, sessions }
            : { active: false, count: 0, sessions: [] },
          loaded: loaded.map((m) => m.id),
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
  const pairingLabel = pairing?.active
    ? `${paint("locked", GRN)}  ${pairing.count}`
    : dim("off");
  process.stdout.write(`${kv("pairing", pairingLabel)}\n`);

  process.stdout.write(`\n  ${heading("clients")}`);
  if (sessions.length === 0) {
    process.stdout.write(`  ${dim("none")}\n`);
  } else {
    process.stdout.write(`\n`);
    for (const sess of sessions) printSessionRow(sess);
  }

  process.stdout.write(`\n  ${heading("servers")}`);
  if (servers.length === 0) {
    process.stdout.write(`  ${dim("none")}\n`);
    return;
  }
  process.stdout.write(`\n`);
  for (const s of servers) printServerRow(s);
}
