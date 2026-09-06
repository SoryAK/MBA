# ADR 0103: Machine detection and dial overlay

- **Status:** Proposed
- **Date:** 2026-09-06
- **Deciders:** project maintainer + agent
- **Tags:** mba, daemon, hardware, machine, recipe, server-setup, performance
- **Relates to:** ADR-0091 (facts vs dials), ADR-0092 (daemon as orchestrator), ADR-0097 (daemon owns server lifecycle)

## Context and Problem Statement

An MBA adapter is a dossier: it records what a model *is* (GGUF facts) and how the operator wants to *run* it (dials). ADR-0091 already separates immutable facts from mutable dials and validates dials against model ceilings — e.g. `ctxSize ≤ maxContextLength` and `gpuLayers ≤ blockCount + 1`.

What the adapter cannot know is the host machine that will actually boot the model. A user can currently set:

- `ctxSize: 200000` on a 16 GB RAM box,
- `gpuLayers: 80` on a GPU with 40 layers or no GPU at all,
- `threads: 64` on a 4-core CPU.

These mistakes are not caught until the server fails to load or the OS starts swapping. The daemon is the orchestrator (ADR-0092) and owns the server lifecycle (ADR-0097), so it is the right place to know the machine and clamp dials to what it can actually provide.

## Decision Drivers

- **Do no harm.** A bad dial should not crash the user's box or make it unusable.
- **Preserve intent.** The user's explicit choices should stay in force unless they exceed real hardware limits.
- **Fail open.** If detection fails or is disabled, MBA falls back to today's behavior (adapter dials only).
- **Stay platform-agnostic.** Detection is platform-specific, but the overlay policy is pure and platform-independent.
- **Keep it simple first.** Start with RAM, GPU VRAM, and CPU cores. Add more sensors later if needed.

## Considered Options

- **Option A — Add dials to the adapter tree that describe the machine.** The user would write `machine: { ram_gb: 16, vram_gb: 8 }` in every environment. Rejected: it pushes hardware knowledge into user-edited files, which drift and duplicate.
- **Option B — Detect the machine at boot and apply a clamping overlay.** The daemon detects the host once, stores a small machine profile, and clamps resolved dials before building server flags. Accepted.
- **Option C — Suggest defaults from the machine.** When a dial is missing, fill it from a machine-derived heuristic. Rejected for v1: it changes behavior more aggressively than clamping and is harder to reason about. We may revisit it later.

## Decision

We will implement **Option B**: detect the host machine, then clamp resolved dials to safe machine-derived ceilings.

### What we detect

| Field | Linux | macOS | Windows (deferred) |
|-------|-------|-------|--------------------|
| `totalRamBytes` | `/proc/meminfo` | `host_statistics` / `sysctl` | `wmic` |
| `gpus[].vramBytes` | `nvidia-smi` | `system_profiler` (limited) | `wmic` |
| `gpus[].name` | `nvidia-smi` | `system_profiler` | `wmic` |
| `cpuCores` | `os.cpus().length` | `os.cpus().length` | `os.cpus().length` |
| `os` | `process.platform` | `process.platform` | `process.platform` |

First implementation targets Linux (`nvidia-smi`) and macOS (RAM + CPU only). If detection fails for any field, that field is `undefined` and the overlay skips the related clamp.

### What we clamp

After the full recipe resolution (built-in defaults → global → family → model → environment), but before `buildLlamaServerFlags`:

| Dial | Clamp rule |
|------|-----------|
| `ctxSize` | ≤ model `maxContextLength` (already enforced) AND ≤ a safe fraction of available RAM / total GPU VRAM |
| `gpuLayers` | ≤ model `blockCount + 1` (already enforced) AND ≤ an estimate of what GPU VRAM can hold |
| `threads` | ≤ `cpuCores` |
| `parallel` | ≤ a conservative heuristic based on `ctxSize` and RAM |

Clamping means **only reduce**. If the user's value already fits, it is unchanged. If a value is missing, it stays missing (we are not implementing default-filling in v1).

### User controls

- `MBA_MACHINE_OVERLAY=off` — disable detection and clamping entirely.
- `MBA_MACHINE_INFO='{"totalRamBytes":17179869184,"gpus":[{"vramBytes":8589934592}],"cpuCores":8}'` — inject a machine profile manually. Useful for cloud/headless boxes where detection is unreliable.

### Architecture

Two new pure modules:

1. **`service/machine-info.ts`** — detection only. Returns `MachineInfo | undefined`. No policy, no side effects.
2. **`service/machine-overlay.ts`** — policy only. Takes a resolved recipe and `MachineInfo`, returns a clamped recipe. Fully unit-testable with fake machine info.

The daemon detects machine info once at boot and caches it in the service handle. `resolveBootRecipe` and the VS Code endpoint sync path call `applyMachineOverlay` before producing the final config or endpoint block.

## Consequences

- Booting a model becomes safer on underspecced hosts.
- Users can still force aggressive values if they believe the machine can handle it, by disabling the overlay or injecting a larger machine profile.
- The detection code is platform-specific and will need per-platform tests. We keep it isolated so the rest of the daemon stays platform-agnostic.
- This is additive: existing adapters keep resolving the same way when detection is disabled or unavailable.
- A future extension (Option C) could fill missing dials from machine-derived defaults, but that is intentionally out of scope for this ADR.

## Open questions

1. What is the right safe fraction of RAM to reserve for `ctxSize`? 50%? 66%? We will measure on a few local machines before finalizing.
2. Should `ctxSize` clamp consider RAM + sum of all GPU VRAM, or the smallest of them? Likely the smaller of total RAM and total GPU VRAM for offloaded inference.
3. Should we cache a `~/.mba/machine.json` so detection does not run every boot? Defer — detection is cheap and hardware rarely changes while the daemon is down.
