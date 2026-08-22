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
 *                         falling back to ~/models/adapters).
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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import YAML from "yaml";
import {
  buildLlamaServerFlags,
  resolveMbaConfig,
  sanitizeLlamaCppServerFlags,
} from "../mba/index.js";
import { readClientBlock } from "./model-endpoint-sync.js";
import { readModelCatalog } from "./model-catalog.js";

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
    args.adapterDir ?? deriveAdaptersRoot(modelFile) ?? join(homedir(), "models", "adapters"),
  );

  // Resolve the exact adapter identity for this weights file. The catalog
  // keys on `identity.model.file`, so this is an exact match — no reliance on
  // the (exact-equality) name predicate, which would miss a .gguf basename
  // that carries a quant suffix the declared name omits.
  const catalog = readModelCatalog(adapterDir);
  const entry = catalog.find((c) => c.modelFile === modelFile);
  if (!entry) {
    fail(
      `no adapter under ${adapterDir} declares model file ${modelFile} — ` +
        `the model is not in the MBA adapter tree, so no recipe can be resolved`,
    );
  }

  // The catalog's `name` is `metadata.name` (falls back to id), which is the
  // human label, not necessarily `identity.model.name`. For resolution we need
  // the declared identity name, so read it straight off the adapter YAML.
  // The resolver matches on identity.model.name (exact equality), so we must
  // feed it the declared name, not the .gguf basename.
  let declaredName: string | undefined;
  let declaredFamily: string | undefined;
  try {
    const raw = YAML.parse(readFileSync(entry.yamlPath, "utf8")) as {
      identity?: { model?: { name?: string; family?: string } };
    };
    declaredName = raw.identity?.model?.name;
    declaredFamily = raw.identity?.model?.family;
  } catch {
    // Fall through to catalog name below.
  }
  const modelName = declaredName ?? entry.name;

  // resolveMbaConfig expects the MBA *base* dir (the parent of `adapters/`) —
  // it joins `adapters` onto it internally. The catalog, by contrast, wants
  // the adapters dir itself. Keep the two distinct.
  const mbaBaseDir = dirname(adapterDir);
  const resolved = resolveMbaConfig(mbaBaseDir, {
    modelName,
    modelFamily: declaredFamily,
    harness: args.harness,
    ide: args.ide,
    serverRuntime: args.runtime,
  });

  // Surface resolution problems loudly but non-fatally: the recipe is still
  // usable (it falls back to defaults), but the boot script should know.
  const hardDiagnostics = resolved.diagnostics.filter(
    (d) => d.kind === "ambiguous-resolution" || d.kind === "load-error",
  );
  if (resolved.selectedIds.length === 0) {
    fail(
      `resolver selected no adapters for model "${modelName}" (base dir ${mbaBaseDir})`,
    );
  }

  const { flags, dropped, clamped } = sanitizeLlamaCppServerFlags(
    resolved.server["llama.cpp"],
  );
  const cliArgs = buildLlamaServerFlags(flags);

  let client = null;
  try {
    client = readClientBlock(entry.yamlPath);
  } catch {
    client = null;
  }

  const output = {
    flags,
    cliArgs,
    profile: resolved.profile ?? null,
    client,
    modelFile,
    adapterDir,
    modelId: entry.id,
    selectedIds: [...resolved.selectedIds],
    diagnostics: resolved.diagnostics.map((d) => ({ kind: d.kind, message: d.message })),
    sanitize: { dropped, clamped },
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
