# MBA Code Audit — 2026-08-25

> Full-repo audit of `packages/core` + `packages/mcp-server` (~9.5k non-test TS lines, 92 files).
> Scope: bugs, circular imports, inefficiency, redundancy, god files.
> Method: 100% file coverage (every source file read) + madge circular-dependency check.
> Status: **partially fixed** — B1, B2, B4, B5, B6, R1 done (TDD, full suite green).
> Remaining: B3 (skipped by user), R2–R5, inefficiency nits, god-file splits.

## ✅ Clean (no action)

- **Circular imports: none** — madge v8, 92 files, "No circular dependency found".
- **BCB engine** (`bcb/*`): rules are pure, stateless, well-separated.
- **Adapter resolution** (`mba/resolver.ts`, `adapter-scoring.ts`, `adapter-merge.ts`, `adapter-identity.ts`): clean 4-rung merge, pure functions.
- `config-store.ts`, `paths.ts`, `upstream-registry.ts`, `model-switch.ts`, `server-lifecycle.ts`, `server-flags.ts`, `model-catalog.ts`, `ctx-size-resolver.ts`: clean.

## 🐛 Bugs

### B1 — gpuLayers hint/validation mismatch (`service/model-config.ts`) — ✅ FIXED

`dialHint` shows gpuLayers as `1–${blockCount}`, but `validateValue` accepts
`1..blockCount+1` (blockCount+1 = all layers on GPU, per the comment in
`findModelFiles`). The hint lies to the user.
**Fix:** hint should be `1–${blockCount + 1}`. One line.

### B2 — `restartServer` stops only the first match (`cli/mba.ts`) — ✅ FIXED

Stops only the **first** server entry matching the model file. If two servers
run the same GGUF, the second keeps running.
**Fix:** stop all matching entries.

### B3 — `file-metadata` MCP tool reads entire file into memory (`mcp-server/src/tools/file-metadata.ts`)

`readFileSync(absolute)` reads the **entire file** just to check for a null
byte and count lines. A 2 GB file → 2 GB buffer.
**Fix:** binary check only needs the first ~8 KB; line counting can stream.

### B4 — `sha256OfFile` reads whole GGUF into memory (`model/model-pull.ts`) — ✅ FIXED

`readFileSync` on a multi-GB GGUF before hashing.
**Fix:** stream via `createReadStream` + incremental hash update.

### B5 — unbounded module-level caches (`mba/loader.ts`) — ✅ FIXED

`yamlCache` / `jsonlCache` / `jsonCache` Maps are never evicted. In the
long-lived service process this is a slow memory leak (one entry per file,
forever).
**Fix:** LRU bound, or clear per boot/config-reload.

### B6 — hardcoded VS Code profile UUID (`service/main.ts`) — ✅ FIXED

Default `chatLanguageModels.json` path hardcodes profile UUID `51cf1714`.
Breaks on any machine where the active profile differs.
**Fix:** resolve the active profile, or default to the global
`User/chatLanguageModels.json`.

## 🔁 Redundancy (drift risk)

### R1 — `resolve-server-recipe.ts` duplicated the boot chain (226 lines) — ✅ FIXED (extract & share)

**Original audit premise was wrong.** The audit assumed `scripts/llama-server-up.sh`
was retired, so `resolve-server-recipe.ts` looked like dead code to delete. It is
**live**: `scripts/llama-server-up.sh:375` calls
`npm run resolve-server-recipe -w @mba-ai/core -- --model-file "$MODEL_PATH"` to
source its boot dials. Deleting it would break the C-Yard boot script.

The real defect was the duplication: `service/server-boot.ts` `resolveBootRecipe`
re-implemented the entire chain (catalog find → YAML read for declared
name/family → `resolveMbaConfig` → sanitize → build), so a fix to one entry point
could silently drift from the other.

**Fix (done):** extracted the shared chain into `service/recipe-resolution.ts`
(`resolveRecipe(modelFile, adapterDir, ctx)`). Both entry points are now thin
wrappers over it — `resolveBootRecipe` (daemon) and the `resolve-server-recipe`
CLI (boot script) — so the flags the script sets and the flags the proxy applies
are provably the same bytes. Both entry points kept; CLI stdout JSON contract
unchanged. Verified: `tsc --noEmit` clean, full suite 412/412 green, CLI smoke
emits positive JSON (`selectedIds` populated, `EXIT=0`).

### R2 — service-URL discovery ×3

`resolveServiceUrl` (CLI `cli/mba.ts`), `resolveServiceBaseUrl`
(`mcp-server/src/service-client.ts`), and the env→`service.json` logic.
The mcp-server copy is **deliberate** (ADR-0092 standalone — must not import
`@mba-ai/core`). The CLI and service-side copies could share one helper in
core.
**Fix (optional):** extract one helper in core for CLI + service; leave the
mcp-server mirror as-is.

### R3 — deliberate mirrors (do NOT "fix")

- `gguf-metadata.ts` ×2 (core + mcp-server) — ADR-0098, headers say "change both".
- `paths.ts` ×2 — ADR-0092.
- `MbaModelProfile` type ×2 — ADR-0092.

Acceptable, but a standing maintenance tax: 3 mirrored type/parse surfaces.
**Action:** note the mirror-check obligation in the Manual; no code change.

### R4 — `readModelDials` reads the adapter YAML twice (`service/model-config.ts`)

Once in `findModelFiles`, once for the client block.
**Fix:** pass the already-parsed YAML down, or have `findModelFiles` return it.

### R5 — hand-rolled YAML parser in `service/model-endpoint-sync.ts`

`readClientBlock` is a line-based YAML parser while the `yaml` package is
already a dependency. `syncVsCodeEndpoints` also reads the config file twice
(read + compare).
**Fix:** use the `yaml` package; single read.

## 🐌 Inefficiency (minor)

- `server.ts` GET /models: probes run in `Promise.all` across models (good);
  each probe walks registry→YAML→env rungs sequentially (by design — fallback
  chain, fine).
- `server-types.ts` ollama `stop`: issues a real generate call (prompt `"hi"`)
  to unload — documented intentional (Ollama has no `/api/unload`), burns a
  few tokens per stop. Acceptable.
- `defaultSwitchExecutor` (`service/server.ts`) calls
  `(opts.paths ?? defaultStorePaths())` 3× — compute once.

## 📦 God files

- **`cli/mba.ts` (719 lines)** — over the 600-line guardrail. Extract the
  dial-editing flow (pick model → pick field → ask value → set) into
  `cli/dial-flow.ts`; interactive primitives already live in
  `cli/interactive.ts`.
- **`mcp-server/src/server.ts` (313 lines)** — ~200 lines are inline tool JSON
  schemas. Extract to `mcp-server/src/tools/schemas.ts` — handlers are already
  split per-file; schemas are the only thing left inline.

## Minor nits

- `bcb/tool-circuit-breaker.ts`: doc comment lists "repeatRun" twice.
- `bcb/rules/read-clamp.ts`: `formatReadClampHeader` is a pure alias of
  `formatReadResultHeader` — dead weight if no external caller.
- `mcp-server/src/adapter/loader.ts` `loadAdapters`: `modelPath` is computed
  then immediately discarded in favor of `resolvedPath` (same value).

## Prioritized fix list

1. **B1** — one-line hint fix (trivial, user-facing correctness)
2. **B3 + B4** — stream the file reads (memory safety on large files)
3. **B2** — stop all matching servers in `restartServer`
4. **R1** — delete `resolve-server-recipe.ts` + script entry (dead code, ~230 lines)
5. **B6** — active-profile resolution for the VS Code config path
6. **B5** — bound the loader caches
7. **R4 / R5 + minor nits** — small cleanups in one pass
8. **God files** — extract `cli/dial-flow.ts` and `tools/schemas.ts` (bigger, do last)
