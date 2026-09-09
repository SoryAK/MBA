import { fail, serviceGet, servicePost } from "./client.js";
import { pickLabeledInteractive } from "./interactive.js";
import { brand, kv } from "./style.js";

const VALID = ["enforce", "warn", "off"] as const;

function printMode(mode: string, version?: number): void {
  process.stdout.write(`${brand("machine")}\n`);
  process.stdout.write(`${kv("mode", mode)}\n`);
  if (version !== undefined) {
    process.stdout.write(`${kv("version", String(version))}\n`);
  }
}

async function setMode(baseUrl: string, mode: string): Promise<void> {
  const body = await servicePost<{ mode: string; version: number }>(
    baseUrl,
    "/config/machine-overlay",
    { mode },
  );
  printMode(body.mode, body.version);
}

async function machineMenu(baseUrl: string): Promise<void> {
  for (;;) {
    const { mode } = await serviceGet<{ mode: string }>(baseUrl, "/config/machine-overlay");
    const row = (value: string, doText: string) => {
      const preview: Array<readonly [string, string]> = [["do", doText]];
      if (value === mode) preview.push(["now", "current"]);
      return { label: value, value, preview };
    };
    const pick = await pickLabeledInteractive(
      "machine",
      [
        row("enforce", "clamp recipes to this machine"),
        row("warn", "log only, do not clamp"),
        row("off", "ignore machine specs"),
      ],
      { selectedValue: mode },
    );
    if (pick === null) return;
    if (pick === mode) continue;
    await setMode(baseUrl, pick);
  }
}

/**
 * `mba machine [enforce|warn|off]` — show or set how MBA applies machine
 * specs to recipes. Alias: `mba machine-overlay`. On a TTY with no args,
 * pick a mode.
 */
export async function cmdMachine(baseUrl: string, args: readonly string[]): Promise<void> {
  const [mode] = args;
  if (mode !== undefined && !(VALID as readonly string[]).includes(mode)) {
    fail(`usage: mba machine [${VALID.join("|")}]`);
  }

  if (mode === undefined) {
    if (process.stdin.isTTY) {
      await machineMenu(baseUrl);
      return;
    }
    const body = await serviceGet<{ mode: string }>(baseUrl, "/config/machine-overlay");
    printMode(body.mode);
    return;
  }

  await setMode(baseUrl, mode);
}
