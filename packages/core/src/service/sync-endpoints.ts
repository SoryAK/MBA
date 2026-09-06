/**
 * One-shot VS Code endpoint sync (ADR-0093 Phase 4, fallback B).
 *
 * The primary path (A) is the watcher inside the running MBA service. This
 * command is the fallback for when the service is not running: it performs a
 * single sync pass and exits. Same env contract as the service entrypoint.
 *
 * Run with: `npm run sync-endpoints -w @mba-ai/core`
 *
 * Env:
 *   MBA_ADAPTER_DIR      — adapter tree root (default: OS-aware model store, see service/paths.ts)
 *   MBA_VSCODE_LM_CONFIG — chatLanguageModels.json path (default: active profile)
 *   MBA_VSCODE_LM_API_KEY_REF — required apiKey reference for the generated block
 *
 * Option C: when an adapter's `client` block omits `contextSize`, the sync
 * falls back to the resolved server-recipe `ctxSize` (the same 4-rung merge
 * the boot script and proxy use) instead of the historical 128k default. A
 * YAML `contextSize`, when present, always wins.
 */

import { homedir } from "node:os";
import { buildCtxSizeResolver } from "./ctx-size-resolver.js";
import { syncVsCodeEndpoints } from "./model-endpoint-sync.js";
import { defaultModelStoreRoot, ensureDir } from "./paths.js";
import { resolveVsCodeLmConfigPath } from "./vscode-lm-config.js";

const adapterDir = process.env.MBA_ADAPTER_DIR ?? defaultModelStoreRoot();
ensureDir(adapterDir);
const configPath = process.env.MBA_VSCODE_LM_CONFIG ?? resolveVsCodeLmConfigPath(homedir());
const apiKeyRef = process.env.MBA_VSCODE_LM_API_KEY_REF;

if (!configPath) {
  console.log(
    "[sync-endpoints] no VS Code profile detected; set MBA_VSCODE_LM_CONFIG to sync",
  );
  process.exit(0);
}
if (!apiKeyRef) {
  console.log("[sync-endpoints] MBA_VSCODE_LM_API_KEY_REF is not set; skipping");
  process.exit(0);
}

const result = syncVsCodeEndpoints({
  adapterDir,
  configPath,
  apiKeyRef,
  resolveCtxSize: buildCtxSizeResolver(adapterDir),
});

if (result.created) {
  console.log(`[sync-endpoints] created ${configPath} (${result.models.length} models)`);
} else if (result.updated) {
  console.log(`[sync-endpoints] updated ${configPath} (${result.models.length} models)`);
} else {
  console.log(`[sync-endpoints] no change (${result.models.length} models)`);
}
