/**
 * Adapter loader for the MBA MCP server.
 *
 * Loads YAML adapter indexes from a directory tree. In Phase 1 this is
 * read-only: the server exposes adapter metadata so tools can be scoped to
 * an adapter, but does not yet perform full ADR-0084 resolution.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import YAML from "yaml";
import { createGgufMetadataCache } from "../model/gguf-metadata-cache.js";
import { type GgufMetadata } from "../model/gguf-metadata.js";

export interface MbaAdapter {
  readonly apiVersion: string;
  readonly kind: "ModelBehavioralAdapter";
  readonly metadata: {
    readonly id: string;
    readonly name?: string;
    readonly family?: string;
  };
  readonly identity: {
    readonly model: {
      readonly family?: string;
      readonly name?: string;
      /** Declared lineage, root → leaf (ADR-0090 cross-check label). */
      readonly lineage?: readonly string[];
      /**
       * Absolute (or YAML-relative) path to the weights file. Lives with
       * `profile` — one fact: "these weights, at this path" (ADR-0085,
       * ADR-0091).
       */
      readonly file?: string;
      /**
       * Immutable GGUF facts for the weights file (ADR-0091). Read-only at
       * every rung; environments may not touch it. Mirrors the proxy's
       * `MbaModelProfile` shape.
       */
      readonly profile?: MbaModelProfile;
    };
  };
  readonly bindings: {
    readonly bcb?: string;
    readonly tcb?: string;
    readonly structural?: string;
    readonly server_setup?: string;
  };
}

/**
 * Immutable model facts (ADR-0091). Mirrors `MbaModelProfile` from
 * `packages/proxy/src/mba/types.ts`; kept local because this package is
 * standalone (no dependency on the proxy).
 */
export interface MbaModelProfile {
  readonly architecture?: string;
  readonly finetune?: string;
  readonly sizeLabel?: string;
  readonly quant?: string;
  readonly quantizedBy?: string;
  readonly license?: string;
  readonly baseModel?: string;
  readonly params?: {
    readonly blockCount?: number;
    readonly maxContextLength?: number;
    readonly embeddingLength?: number;
    readonly feedForwardLength?: number;
    readonly headCount?: number;
    readonly headCountKv?: number;
    readonly keyLength?: number;
    readonly valueLength?: number;
    readonly ropeFreqBase?: number;
    readonly expertCount?: number;
    readonly expertUsedCount?: number;
    readonly expertFeedForwardLength?: number;
  };
  readonly tokenizer?: {
    readonly model?: string;
    readonly pre?: string;
    readonly eosTokenId?: number;
    readonly paddingTokenId?: number;
    readonly addBosToken?: boolean;
    readonly chatTemplateDigest?: string;
  };
  readonly gguf?: {
    readonly version?: number;
    readonly tensorCount?: number;
    readonly kvCount?: number;
    readonly fileFingerprint?: string;
    readonly imatrix?: {
      readonly file?: string;
      readonly dataset?: string;
    };
  };
}

export interface LoadedAdapter {
  readonly path: string;
  readonly adapter: MbaAdapter;
  readonly modelMetadata?: GgufMetadata;
}

function isAdapter(value: unknown): value is MbaAdapter {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.apiVersion !== "mba.c-yard.dev/v1alpha1") return false;
  if (v.kind !== "ModelBehavioralAdapter") return false;
  if (typeof v.metadata !== "object" || v.metadata === null) return false;
  if (typeof (v.metadata as Record<string, unknown>).id !== "string") return false;
  if (typeof v.identity !== "object" || v.identity === null) return false;
  if (typeof v.bindings !== "object" || v.bindings === null) return false;
  return true;
}

function scanAdapterFiles(dir: string, out: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanAdapterFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
      out.push(full);
    }
  }
  return out;
}

export function loadAdapters(adapterDir: string, workspaceRoot: string): LoadedAdapter[] {
  const stat = statSync(adapterDir, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    return [];
  }

  const files = scanAdapterFiles(adapterDir);
  const adapters: LoadedAdapter[] = [];
  const cache = createGgufMetadataCache({
    cacheDir: resolve(workspaceRoot, ".MBA/cache/gguf-metadata"),
  });

  for (const file of files) {
    const raw = YAML.parse(readFileSync(file, "utf8")) as unknown;
    if (!isAdapter(raw)) {
      throw new Error(`invalid MBA adapter shape in ${file}`);
    }

    const adapter: LoadedAdapter = { path: file, adapter: raw };

    const modelFile = raw.identity.model.file;
    if (typeof modelFile === "string" && modelFile.length > 0) {
      const modelPath = resolve(dirname(file), modelFile);
      const resolvedPath = isAbsolute(modelFile) ? modelFile : modelPath;
      adapters.push({ ...adapter, modelMetadata: cache(resolvedPath) });
      continue;
    }

    adapters.push(adapter);
  }

  return adapters;
}
