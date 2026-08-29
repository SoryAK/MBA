/**
 * One-shot server-recipe resolver (ADR-0093 Phase 4 companion).
 *
 * Given a concrete weights file (the one the boot script is about to load),
 * resolve the *effective* MBA server recipe for it — the same 4-rung merge
 * (family bindings < family env < model bindings < model env) the proxy uses
 * at runtime — and emit it as a single JSON object on stdout.
 *
 * This is the bridge that lets `scripts/llama-server-up.sh` source its boot
 * dials (ctx size, GPU layers, reasoning budget, …) from the adapter tree
 * instead of duplicating them as hardcoded defaults. Because it calls the
 * exact same `resolveMbaConfig` + `sanitizeLlamaCppServerFlags` +
 * `buildLlamaServerFlags` the proxy consumes, the flags the script sets and
 * the flags the proxy applies are provably the same bytes.
 *
 * Run with: `npm run resolve-server-recipe -w @mba-ai/core -- --model-file <path>`
 *
 * Args:
 *   --model-file <path>   (required) Absolute path to the .gguf to boot.
 *   --adapter-dir <dir>   Adapters root (default: derived from --model-file,
 *                         falling back to the OS-aware model store, see service/paths.ts).
 *   --harness <name>      Harness for env-folder selection (default: copilot).
 *   --ide <name>          IDE for env-folder selection (default: vscode).
 *   --runtime <name>      Inference runtime (default: llamacpp).
 *
 * Output (stdout, single JSON object):
 *   {
 *     "flags":        { ...fully-populated in-range LlamaCppServerFlags },
 *     "cliArgs":      [ "--ctx-size", "100000", ... ],
 *     "profile":      { ...matched model profile } | null,
 *     "client":       { url, contextSize, ... } | null,
 *     "modelFile":    "<abs path>",
 *     "adapterDir":   "<abs adapters root>",
 *     "modelId":      "<adapter metadata.id>",
 *     "selectedIds":  [ ...adapter ids, most-specific last ],
 *     "diagnostics":  [ ...resolution diagnostics ]
 *   }
 *
 * Exit codes: 0 = resolved, 2 = usage/resolution error (message on stderr).
 */

import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { readClientBlock } from "./model-endpoint-sync.js";
import { resolveRecipe } from "./recipe-resolution.js";
import { defaultModelStoreRoot } from "./paths.js";

interface CliArgs {
  modelFile: string;
  adapterDir?: string;
  harness: string;
  ide: string;
  runtime: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    modelFile: "",
    harness: "copilot",
    ide: "vscode",
    runtime: "llamacpp",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${key}`);
      return v;
    };
    switch (key) {
      case "--model-file":
        args.modelFile = next();
        break;
      case "--adapter-dir":
        args.adapterDir = next();
        break;
      case "--harness":
        args.harness = next();
        break;
      case "--ide":
        args.ide = next();
        break;
      case "--runtime":
        args.runtime = next();
        break;
      default:
        throw new Error(`unknown argument: ${key}`);
    }
  }
  if (!args.modelFile) {
    throw new Error("--model-file <path> is required");
  }
  return args;
}

/**
 * Derive the adapters root from a weights-file path by walking up to the
 * `adapters` path segment. Returns undefined when no such segment exists so
 * the caller can fall back to the default home.
 */
function deriveAdaptersRoot(modelFilePath: string): string | undefined {
  const segments = resolve(modelFilePath).split(sep);
  const idx = segments.lastIndexOf("adapters");
  if (idx <= 0) return undefined;
  return segments.slice(0, idx + 1).join(sep);
}

function fail(message: string): never {
  process.stderr.write(`[resolve-server-recipe] ${message}\n`);
  process.exit(2);
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail((err as Error).message);
  }

  const modelFile = resolve(args.modelFile);
  if (!existsSync(modelFile)) {
    fail(`model file not found: ${modelFile}`);
  }

  const adapterDir = resolve(
    args.adapterDir ?? deriveAdaptersRoot(modelFile) ?? defaultModelStoreRoot(),
  );

  // The shared resolution chain (R1): catalog lookup → declared identity →
  // resolveMbaConfig → sanitize → buildLlamaServerFlags. The in-daemon
  // resolveBootRecipe runs the same chain, so the flags the script sets and
  // the flags the proxy applies are provably the same bytes.
  let recipe;
  try {
    recipe = resolveRecipe(modelFile, adapterDir, {
      harness: args.harness,
      ide: args.ide,
      serverRuntime: args.runtime,
    });
  } catch (err) {
    fail(
      `${err instanceof Error ? err.message : String(err)} — ` +
        `the model is not in the MBA adapter tree, so no recipe can be resolved`,
    );
  }
  const { resolved } = recipe;

  // Surface resolution problems loudly but non-fatally: the recipe is still
  // usable (it falls back to defaults), but the boot script should know.
  const hardDiagnostics = resolved.diagnostics.filter(
    (d) => d.kind === "ambiguous-resolution" || d.kind === "load-error",
  );
  if (resolved.selectedIds.length === 0) {
    fail(
      `resolver selected no adapters for model "${recipe.declaredName ?? recipe.catalogName}" ` +
        `(base dir ${dirname(adapterDir)})`,
    );
  }

  let client = null;
  try {
    client = readClientBlock(recipe.yamlPath);
  } catch {
    client = null;
  }

  const output = {
    flags: recipe.flags,
    cliArgs: recipe.cliArgs,
    profile: resolved.profile ?? null,
    client,
    modelFile,
    adapterDir,
    modelId: recipe.modelId,
    selectedIds: [...resolved.selectedIds],
    diagnostics: resolved.diagnostics.map((d) => ({ kind: d.kind, message: d.message })),
    sanitize: { dropped: recipe.dropped, clamped: recipe.clamped },
  };

  if (hardDiagnostics.length > 0) {
    process.stderr.write(
      `[resolve-server-recipe] warnings:\n` +
        hardDiagnostics.map((d) => `  - ${d.kind}: ${d.message}`).join("\n") +
        "\n",
    );
  }

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main();
