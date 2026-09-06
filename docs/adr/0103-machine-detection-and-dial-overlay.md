# ADR 0103: Machine detection, model memory estimation, and dial overlay

- **Status:** Accepted
- **Date:** 2026-09-06
- **Deciders:** project maintainer + agent
- **Tags:** mba, daemon, hardware, machine, recipe, server-setup, performance, memory
- **Relates to:** ADR-0091 (facts vs dials), ADR-0092 (daemon as orchestrator), ADR-0097 (daemon owns server lifecycle)

## Context and Problem Statement

An MBA adapter is a dossier: it records what a model *is* (GGUF facts) and how the operator wants to *run* it (dials). ADR-0091 already separates immutable facts from mutable dials and validates dials against model ceilings — e.g. `ctxSize ≤ maxContextLength` and `gpuLayers ≤ blockCount + 1`.

What the adapter cannot know is the host machine that will actually boot the model. A user can currently set:

- `ctxSize: 200000` on a 16 GB RAM box,
- `gpuLayers: 80` on a GPU with 40 layers or no GPU at all,
- `threads: 64` on a 4-core CPU.

These mistakes are not caught until the server fails to load or the OS starts swapping. The daemon is the orchestrator (ADR-0092) and owns the server lifecycle (ADR-0097), so it is the right place to know the machine, estimate what a model will need, and clamp dials to what the host can actually provide.

## Decision Drivers

- **Do no harm.** A bad dial should not crash the user's box or make it unusable.
- **Preserve intent.** The user's explicit choices should stay in force unless they exceed real hardware limits.
- **Fail open.** If detection fails, estimation fails, or the overlay is disabled, MBA falls back to today's behavior (adapter dials only).
- **No native build required.** The estimator should be TypeScript so it lives in the same runtime as the daemon and works cross-platform immediately.
- **Stay platform-agnostic.** Detection is platform-specific, but estimation and overlay policy are pure and platform-independent.
- **Record once, validate occasionally.** Machine specs are detected at setup and persisted; re-validation happens on daemon restart and explicit refresh.

## Considered Options

- **Option A — Add dials to the adapter tree that describe the machine.** The user would write `machine: { ram_gb: 16, vram_gb: 8 }` in every environment. Rejected: it pushes hardware knowledge into user-edited files, which drift and duplicate.
- **Option B — Detect the machine at boot and apply a clamping overlay.** The daemon detects the host once, stores a small machine profile, and clamps resolved dials before building server flags. Accepted, with the addition of a model memory estimator.
- **Option C — Suggest defaults from the machine.** When a dial is missing, fill it from a machine-derived heuristic. Rejected for v1: it changes behavior more aggressively than clamping and is harder to reason about. We may revisit it later.
- **Option D — Native Rust/C++ binary using llama.cpp's own planner.** Rejected for v1: adds build complexity, cross-platform packaging, and a second language/runtime. It remains a future accuracy upgrade if the TypeScript estimator proves insufficient.

## Decision

We will implement **Option B** with a **TypeScript model memory estimator** reverse-engineered from llama.cpp's formulas:

1. Detect the host machine at daemon boot and persist the specs.
2. Estimate the memory a resolved recipe would require using the model's GGUF metadata.
3. Clamp dials so the recipe fits the recorded machine specs.

### Machine detection and persistence

At daemon boot, the daemon detects the host and writes a machine profile to the state dir:

```text
~/.mba/mba/machine.json
```

Example profile:

```json
{
  "recordedAt": "2026-09-06T...",
  "os": "linux",
  "cpuCores": 16,
  "totalRamBytes": 34359738368,
  "gpus": [
    {
      "name": "Example NVIDIA GPU",
      "vramBytes": 25769803776
    }
  ],
  "source": "detected"
}
```

| Field | Linux | macOS | Windows (deferred) |
|-------|-------|-------|--------------------|
| `totalRamBytes` | `/proc/meminfo` | `host_statistics` / `sysctl` | `wmic` |
| `gpus[].vramBytes` | `nvidia-smi` | `system_profiler` (limited) | `wmic` |
| `gpus[].name` | `nvidia-smi` | `system_profiler` | `wmic` |
| `cpuCores` | `os.cpus().length` | `os.cpus().length` | `os.cpus().length` |
| `os` | `process.platform` | `process.platform` | `process.platform` |

First implementation targets Linux (`nvidia-smi`) and macOS (RAM + CPU only). If detection fails for any field, that field is `undefined` and the overlay skips the related clamp.

Re-validation happens on **daemon restart** and on explicit refresh via the CLI/API. If the profile changes, the daemon rewrites the file and logs a diff.

### Model memory estimator

Instead of a native binary, we implement a TypeScript estimator in `service/gguf-memory-estimator.ts`. It reads the GGUF metadata already parsed by MBA and computes:

- **Weight memory** from architecture dimensions, layer count, and quantization.
- **KV cache memory** from context size, layer count, KV heads, head dimension, and cache type.
- **Compute buffer memory** from context size, batch size, and model shape.
- **Overhead margin** for activation tensors, graph tensors, and temporary buffers.

For GPU offloading, the estimator splits the estimate between RAM and VRAM based on `gpuLayers` and the model's layer count. The formulas are derived from llama.cpp's own memory estimator; we will keep a comment in the code pointing to the upstream functions and commit hash for traceability.

If the estimator encounters an unknown architecture or quantization, it returns `undefined` and the overlay falls back to conservative heuristics.

### What we clamp

After the full recipe resolution (built-in defaults → global → family → model → environment), but before `buildLlamaServerFlags`:

| Dial | Clamp rule |
|------|-----------|
| `ctxSize` | ≤ model `maxContextLength` (already enforced) AND ≤ the largest context that fits in available RAM / VRAM per the estimator |
| `gpuLayers` | ≤ model `blockCount + 1` (already enforced) AND ≤ the most layers that fit in VRAM per the estimator |
| `threads` | ≤ `cpuCores` |
| `parallel` | ≤ a conservative heuristic based on `ctxSize` and RAM |

Clamping means **only reduce**. If the user's value already fits, it is unchanged. If a value is missing, it stays missing (we are not implementing default-filling in v1).

### User controls

- `MBA_MACHINE_OVERLAY=off` — disable detection, estimation, and clamping entirely.
- `MBA_MACHINE_INFO='{"totalRamBytes":17179869184,"gpus":[{"vramBytes":8589934592}],"cpuCores":8}'` — inject a machine profile manually. Useful for cloud/headless boxes where detection is unreliable.
- `MBA_MACHINE_REFRESH=1` — force a one-time refresh of `machine.json` on the next daemon boot.

### Architecture

New modules:

1. **`service/machine-info.ts`** — detection only. Reads platform sensors and returns `MachineInfo`. No policy, no side effects.
2. **`service/machine-store.ts`** — persistence. Reads/writes `machine.json`, handles refresh logic, and computes diffs.
3. **`service/gguf-memory-estimator.ts`** — estimation only. Takes GGUF metadata and a candidate recipe, returns `MemoryEstimate` (RAM + VRAM + breakdown) or `undefined` if it cannot estimate.
4. **`service/machine-overlay.ts`** — policy only. Takes a resolved recipe, machine info, and optional memory estimate; returns a clamped recipe. Fully unit-testable with fake inputs.

The daemon detects machine info at boot, persists it, and caches it in the service handle. `resolveBootRecipe` and the VS Code endpoint sync path call `applyMachineOverlay` before producing the final config or endpoint block. The overlay calls the estimator when the model's GGUF path is known; otherwise it falls back to heuristic clamping.

## Consequences

- Booting a model becomes safer on underspecced hosts.
- Users can still force aggressive values if they believe the machine can handle it, by disabling the overlay or injecting a larger machine profile.
- The detection code is platform-specific and will need per-platform tests. We keep it isolated so the rest of the daemon stays platform-agnostic.
- The estimator is TypeScript, so it is easy to test and iterate but must be kept in sync with llama.cpp memory accounting. We will validate it against actual `llama-server` runs on known hardware.
- This is additive: existing adapters keep resolving the same way when detection, estimation, or the overlay is disabled or unavailable.
- A future extension could add a native `mba-assess` binary for exact memory estimates, or implement Option C (fill missing dials from machine defaults). Both are intentionally out of scope for this ADR.

## Open questions

1. What is the right safety margin to reserve for the OS and other processes? We will measure on a few local machines before finalizing.
2. Should `ctxSize` clamp consider RAM + sum of all GPU VRAM, or the smallest available resource? Likely the bottleneck resource for the chosen offload split.
3. How do we validate the TypeScript estimator against real llama.cpp runs? We will collect a small set of reference models and compare predicted vs. actual peak RAM/VRAM.
