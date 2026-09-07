import { resolveServiceUrl, serviceGet } from "./client.js";
import { brand, dim, heading, kv, paint, BOLD, GRN, RED } from "./style.js";
import type { ModelEntry } from "./interactive.js";
import type { ServerEntry } from "./types.js";

function printServerRow(s: ServerEntry): void {
  const health = s.healthy ? paint("ok", GRN) : paint("down", RED);
  const pid = s.pid !== undefined ? String(s.pid) : "-";
  process.stdout.write(
    `    ${paint(s.id.padEnd(18), BOLD)}  ${String(s.port).padEnd(5)}  ${pid.padEnd(7)}  ${health}  ${dim(s.modelFile)}\n`,
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
  try {
    const [m, s, overlay] = await Promise.all([
      serviceGet<{ models: ModelEntry[] }>(url, "/models"),
      serviceGet<{ servers: ServerEntry[] }>(url, "/servers"),
      serviceGet<{ mode: string }>(url, "/config/machine-overlay"),
    ]);
    models = [...m.models];
    servers = [...s.servers];
    machine = overlay.mode;
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

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          service: "up",
          url,
          machine,
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
  process.stdout.write(`\n  ${heading("servers")}`);
  if (servers.length === 0) {
    process.stdout.write(`  ${dim("none")}\n`);
    return;
  }
  process.stdout.write(`\n`);
  for (const s of servers) printServerRow(s);
}
