# 0100 — Open-ended `extraArgs` map for llama.cpp server flags

- **Status:** Proposed
- **Date:** 2026-08-29
- **Deciders:** user + agent
- **Tags:** mba, server-flags, llama.cpp, config, boot, adapter-merge

## Context and Problem Statement

MBA passes a fixed set of llama.cpp server flags to `llama-server`, built by
`buildLlamaServerFlags` from the typed `LlamaCppServerFlags` struct
(`ctxSize`, `gpuLayers`, `threads`, `flashAttn`, `specType`, …). Every flag
MBA wants to expose is a hand-written field: a typed property on the struct,
a range in `LLAMA_CPP_RANGES`, a sanitize branch, and a `--flag value` push in
the builder.

llama.cpp moves fast. New flags appear in every release (`--n-cpu-moe`,
`--no-mmap`, `--cache-type-k`, …), and each one that a user wants forces a
code change in MBA just to *pass it through*. The team was chasing this churn
flag-by-flag. The user proposed an open-ended escape hatch so that new llama.cpp
flags can be set from config without an MBA release.

The tension: an open-ended bag of raw flags is a footgun. If a user can set
`--ctx-size` freely, they can silently fight the typed `ctxSize` field, and the
two values will race for the same flag on the command line. The design has to
give the escape hatch *and* keep the managed flags authoritative.

## Decision Drivers

- **Stop chasing flag churn.** New llama.cpp flags must be settable from
  `server_setup.json` with no MBA code change.
- **Managed flags stay authoritative.** The typed fields are the
  mission-critical dials (context, offload, attention, spec decoding). They must
  not be silently overridable by a raw string.
- **Fail loudly, before spawn.** A conflict must reject the boot with a precise
  error, not let `llama-server` die on a duplicate flag after the process is up.
- **Keep the pure resolver pure.** `sanitizeLlamaCppServerFlags` is documented
  as never-throwing on untrusted input; it must stay that way.
- **Zero resolver changes.** The 4-rung adapter merge already deep-merges nested
  plain objects, so a nested `extraArgs` map must merge key-by-key for free.

## Considered Options

### Shape of the escape hatch

- **Option A — raw string array.** `extraArgs: string[]` of literal CLI tokens
  (e.g. `["--n-cpu-moe", "4"]`). Maximum freedom, zero structure.
- **Option B — structured map.** `extraArgs: Record<string, string|number|boolean>`
  keyed by flag name without the leading `--`. `true` → bare flag, `false` →
  omitted, `string|number` → `--key value`.

**Chosen: Option B.** The map is self-describing, type-checkable, and — critically
— its *keys* are inspectable, which is what makes the managed-flag conflict guard
possible. A raw string array hides the flag name inside a token, so MBA could not
tell `--ctx-size` apart from `--n-cpu-moe` without parsing CLI strings. The map
buys the safety property for the cost of a small shape constraint.

### Where a managed-flag conflict is enforced

- **Option A — throw in `sanitizeLlamaCppServerFlags`.** Reject at sanitize time.
- **Option B — report in sanitize, throw in `buildLlamaServerFlags`.** Sanitize
  records the conflict in a `conflicts` field; the builder throws
  `LlamaFlagConflictError` before the process is spawned.

**Chosen: Option B.** `sanitizeLlamaCppServerFlags` is a pure, never-throwing
validator over untrusted input (it already reports `dropped`/`clamped` instead of
throwing). Adding a throw would break that contract and its callers
(`ctx-size-resolver.ts` reads `.flags` and would now have to handle a throw).
The builder is the single choke point that turns a resolved flag set into CLI
args — the right place to fail the boot, and it runs before `spawn`.

### How the denylist is derived

- **Option A — hand-maintain a list of managed flag names per call site.**
- **Option B — a single `MANAGED_LLAMA_FLAGS` set, the one source of truth.**

**Chosen: Option B.** The set is exported from `server-flags.ts` and used by both
the sanitize conflict-report and the builder conflict-throw. Adding a new typed
field means adding its flag name to the set in one place; the guard follows
automatically.

## Decision

`LlamaCppServerFlags` gains an optional field:

```ts
extraArgs?: Record<string, string | number | boolean>;
```

- **Key** = llama.cpp flag name *without* the leading `--` (e.g. `"n-cpu-moe"`,
  `"no-mmap"`).
- **Value** = `string | number | boolean`. `true` emits a bare flag
  (`--no-mmap`); `false` omits it; `string | number` emits `--key value`.
- **Position** = appended *after* all managed flags in `buildLlamaServerFlags`.

`server-flags.ts` gains:

- `MANAGED_LLAMA_FLAGS: ReadonlySet<string>` — the flags MBA emits itself
  (`ctx-size`, `ngl`, `threads`, `jinja`, `parallel`, `cache-reuse`,
  `cache-ram`, `reasoning-budget`, `reasoning-preserve`, `flash-attn`, `ctk`,
  `ctv`, `spec-type`, `spec-draft-n-max`). Single source of truth for the guard.
- `LlamaFlagConflictError extends Error` — thrown by the builder on a conflict.
- `SanitizedLlamaCppFlags.conflicts: readonly string[]` — `extraArgs` keys that
  collide with a managed flag. Reported, not thrown.

Behavior:

1. `sanitizeLlamaCppServerFlags` validates `extraArgs` shape-only: it must be a
   plain object; each entry must be `string | number | boolean` (bad entries are
   dropped and reported as `extraArgs.<key>`; a non-object value drops the whole
   `extraArgs`). It records any managed-flag collision in `conflicts` but does
   **not** throw.
2. `buildLlamaServerFlags` computes the same collision and, if non-empty, throws
   `LlamaFlagConflictError` naming the offending keys and pointing at the typed
   field to use instead. This runs before `spawn`, so the boot fails with a
   precise error.
3. The 4-rung adapter merge (`deepMergeObjects`) deep-merges nested `extraArgs`
   key-by-key for free — a child rung augments the parent's map. No resolver
   change. Guarded by `adapter-merge.test.ts`.

`extraArgs` is **not** a dial field: `FieldKind` has no `"object"` kind, so it is
edited directly in `server_setup.json` and validated at boot. `setModelDial`
preserves unknown keys (it parses the whole JSON, mutates one field, writes
back), so `extraArgs` survives dial writes.

## Consequences

**Pros**

- **Ends the flag-churn treadmill.** Any current or future llama.cpp flag is
  settable from config with no MBA code change. The typed fields remain for the
  dials MBA cares about; `extraArgs` is the long tail.
- **Managed flags stay authoritative, with a loud failure.** A user who tries to
  set `--ctx-size` in `extraArgs` gets a precise `LlamaFlagConflictError` before
  spawn, naming the key and the typed field to use — not a cryptic duplicate-flag
  crash from `llama-server`.
- **Pure resolver stays pure.** Sanitize remains never-throwing; the enforcement
  lives at the single builder choke point, keeping the contract and its callers
  intact.

**Cons / Trade-offs**

- **No `--help` cross-check yet.** `extraArgs` is validated for *shape* only; a
  typo'd or removed llama.cpp flag name is not caught by MBA and will surface as
  a `llama-server` startup error. A `--help`-driven validation pass is a
  deliberate fast-follow, not part of this ADR.
- **One more config surface to document.** Users now have two ways to influence
  server flags (typed fields + `extraArgs`). The conflict guard prevents the
  dangerous overlap, but the docs/manual must make the "typed field wins, use
  `extraArgs` only for the long tail" rule explicit.
- **The denylist must be kept in sync.** `MANAGED_LLAMA_FLAGS` is hand-maintained
  alongside the typed fields. A new typed field whose flag name is not added to
  the set would silently allow a conflict. Mitigated by the single-source set and
  the builder test, but it is a maintenance obligation.
