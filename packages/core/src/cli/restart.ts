/**
 * Post-write restart is a CLI decision. The service reports
 * { restartRequired, modelLoaded } and never reboots itself (ADR-0096).
 */

import { serviceGet, servicePost } from "./client.js";
import { askYesNoInteractive } from "./interactive.js";
import { resolveModelFile } from "./resolve-model.js";
import { selectRestartTargets } from "./restart-selection.js";
import { doneBox } from "./style.js";
import type { BootResult, ServerEntry, SetResult } from "./types.js";

export async function askYesNo(question: string): Promise<boolean> {
  const answer = await askYesNoInteractive(question);
  return answer === true;
}

async function restartServer(
  baseUrl: string,
  modelId: string,
  modelFile: string | undefined,
  port: number,
): Promise<void> {
  const file =
    modelFile && modelFile.length > 0 ? modelFile : await resolveModelFile(baseUrl, modelId);
  const { servers } = await serviceGet<{ servers: ServerEntry[] }>(baseUrl, "/servers");
  const interactive = process.stdin.isTTY === true;
  const { targets, prompt } = selectRestartTargets(servers, file, interactive);
  if (targets.length > 0) {
    if (prompt) {
      const stopAll = await askYesNo(
        `${targets.length} servers are running this model — stop all of them?`,
      );
      if (!stopAll) {
        process.stdout.write(
          `[mba] not stopping the other ${targets.length - 1} server(s); ` +
            `the reboot may fail if the port is still held. Stop them with 'mba servers stop <id>'.\n`,
        );
        return;
      }
    }
    for (const target of targets) {
      process.stdout.write(`[mba] stopping server ${target.id}\n`);
      await servicePost<{ stopped: string }>(baseUrl, "/servers/stop", { id: target.id });
    }
  }
  process.stdout.write(`[mba] rebooting ${modelId} on port ${port} (waits for health)…\n`);
  const entry = await servicePost<BootResult>(baseUrl, "/servers/boot", { modelFile: file, port });
  process.stdout.write(
    doneBox("BOOTED", [
      ["id", entry.id],
      ["port", String(entry.port)],
      ["pid", entry.pid !== undefined ? String(entry.pid) : "-"],
      ["next", `mba s logs ${entry.id}`],
    ]) + "\n",
  );
}

export async function handleRestartPrompt(
  baseUrl: string,
  modelId: string,
  result: SetResult,
  assumeNo: boolean,
): Promise<void> {
  if (!result.restartRequired) {
    process.stdout.write("[mba] saved — synced live, no restart needed\n");
    return;
  }
  if (!result.modelLoaded) {
    process.stdout.write("[mba] saved — takes effect on next boot (model not currently loaded)\n");
    return;
  }
  const port = Number(process.env.MBA_SWITCH_PORT ?? 8080);
  const hint = `mba servers boot ${modelId} ${port}`;
  if (assumeNo) {
    process.stdout.write(`[mba] saved — restart required. Reboot with: ${hint}\n`);
    return;
  }
  const yes = await askYesNo(`Restart ${modelId} now to apply?`);
  if (!yes) {
    process.stdout.write(`[mba] saved — restart required. Reboot with: ${hint}\n`);
    return;
  }
  await restartServer(baseUrl, modelId, result.modelFile, port);
  process.stdout.write("[mba] reboot complete\n");
}

export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
