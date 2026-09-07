import { fail, serviceGet, servicePost } from "./client.js";
import { brand, kv } from "./style.js";

const VALID = ["enforce", "warn", "off"] as const;

/**
 * `mba machine [enforce|warn|off]` — show or set how MBA applies machine
 * specs to recipes. Alias: `mba machine-overlay`.
 */
export async function cmdMachine(baseUrl: string, args: readonly string[]): Promise<void> {
  const [mode] = args;
  if (mode !== undefined && !(VALID as readonly string[]).includes(mode)) {
    fail(`usage: mba machine [${VALID.join("|")}]`);
  }

  if (mode === undefined) {
    const body = await serviceGet<{ mode: string }>(baseUrl, "/config/machine-overlay");
    process.stdout.write(`${brand("machine")}\n`);
    process.stdout.write(`${kv("mode", body.mode)}\n`);
    return;
  }

  const body = await servicePost<{ mode: string; version: number }>(
    baseUrl,
    "/config/machine-overlay",
    { mode },
  );
  process.stdout.write(`${brand("machine")}\n`);
  process.stdout.write(`${kv("mode", body.mode)}\n`);
  process.stdout.write(`${kv("version", String(body.version))}\n`);
}
