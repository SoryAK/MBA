# 0099 — HuggingFace repo shorthand for `mba pull`: auto-resolved URLs and digests

- **Status:** Proposed
- **Date:** 2026-08-28
- **Deciders:** user + agent
- **Tags:** mba, model-management, cli, service, gguf, download, huggingface

## Context and Problem Statement

[ADR-0098](0098-model-pull-capability.md) made `--sha256` mandatory for
`mba pull` — a deliberate integrity decision. But the digest is not
something the user computes: it is *published by the source* alongside the
file. For HuggingFace (where nearly all GGUFs live) the sha256 of every file
is the LFS `oid` in the repo's file listing, available both in the web UI
and via the public API
(`GET /api/models/<owner>/<repo>/tree/<ref>`).

So the mandatory digest turned a one-command onboarding into a
three-step ritual: open the repo, find the file's hash, copy-paste a 64-char
hex string into the command. The ADR-0098 authors accepted this friction
explicitly ("one copy-paste from the source — the friction is acceptable"),
but in practice it is the most annoying step of the whole flow.

## Decision Drivers

- **Integrity is non-negotiable.** The downloaded bytes must still be
  verified against a digest before anything enters the store. Auto-resolution
  must not weaken this.
- **Least friction for the common case.** HuggingFace is the dominant GGUF
  source; the copy-paste should disappear there.
- **Universal guarantee preserved.** Non-HF hosts have no universal
  "give me the digest" API, so they keep the explicit `--sha256` requirement
  from ADR-0098.
- **Explicit digest always wins.** A user who has an independently published
  digest (e.g. from a release notes page) must be able to override the
  auto-resolved one.

## Considered Options

### How much to automate

- **Option A — auto-resolve only.** `--sha256` becomes optional; when
  omitted, MBA resolves the digest from the source.
- **Option B — helper command.** `mba digest <url>` prints the digest; the
  user still pastes it.
- **Option C — repo shorthand.** `mba pull owner/repo[:file-or-quant]` —
  MBA resolves *both* the download URL and the digest from the repo listing.

**Chosen: Option C, with Option A's semantics underneath.** The shorthand
kills the most friction (no URL construction either), and the same
resolution path also accepts a plain HuggingFace resolve URL without a
digest. `--sha256` stays as an optional override.

### Where the digest comes from

- **Option A — the repo's LFS `oid` via the HF API.** Same value the web UI
  shows; machine-readable; no file download needed.
- **Option B — download the file, hash it, compare to nothing.** Defeats the
  purpose (no independent digest to verify against).

**Chosen: Option A.** The trust model is unchanged from ADR-0098: the user
trusts the source to publish the correct digest; MBA guarantees the bytes on
disk match it. Auto-fetching the digest from the same host does not weaken
that — it removes the copy-paste, not the check.

### File selection in the shorthand

- **Option A — require an exact file path.** `owner/repo:path/to/file.gguf`.
- **Option B — also accept a quant suffix.** `owner/repo:Q4_K_M` matches any
  file ending in `.Q4_K_M.gguf`.

**Chosen: Option B.** Quant labels are the natural unit of choice for a
GGUF repo (the user picks a quant, not a filename). Exact paths still work
and take precedence. Ambiguous matches fail with the candidate list.

## Decision

`mba pull` and `POST /models/pull` accept, in place of a download URL:

- **Repo shorthand:** `owner/repo` (exactly one GGUF in the repo),
  `owner/repo:path/to/file.gguf` (exact path), or `owner/repo:QUANT`
  (quant-suffix match, e.g. `Q4_K_M`).
- **A HuggingFace resolve URL** (`https://huggingface.co/o/r/resolve/branch/file`).

When `--sha256` is omitted, the service resolves the source via the
HuggingFace API:

1. `GET /api/models/<owner>/<repo>` → `sha`, the commit hash of the repo's
   default branch (when the branch is not already in the URL).
2. `GET /api/models/<owner>/<repo>/tree/<ref>` → file list with LFS oids,
   where `<ref>` is that commit hash (or the branch from a resolve URL).
   Pinning to a commit keeps the digest and the download URL consistent with
   the exact revision the repo published.
3. Match the requested file (exact path, then quant suffix, then
   single-GGUF default). The LFS `oid` is the sha256.
4. Download from `https://huggingface.co/<owner>/<repo>/resolve/<ref>/<file>`
   and verify against the resolved digest — the ADR-0098 pipeline is
   otherwise untouched.

When `--sha256` **is** supplied, it always wins: a repo shorthand still
resolves the download URL via the API (the user may not know the exact
filename), but the supplied digest is used instead of the repo's; a full
resolve URL with a supplied digest needs no API lookup at all.

Non-HuggingFace sources without `--sha256` fail with a clear error pointing
at the flag. Repos that do not publish an LFS oid for the file (small files
stored in git, not LFS) fail the same way.

New module in `@mba-ai/core` (`src/model/`):

- `hf-resolve.ts` — `parseHfRef`, `parseHfUrl`, `resolveHfSource` (pure
  parsing + one API round-trip; injectable fetch for tests), and
  `HfResolveError`.

`pullModel` gains an optional `sha256`; the CLI and service route make the
flag/body field optional. `HfResolveError` maps to HTTP 400 (bad source,
same class as `PullValidationError`).

## Consequences

**Pros:**

- The common case is now genuinely one command:
  `mba pull rico03/Qwen3.8-27B-...-GGUF:Q4_K_M --id qwen3.8-27b-opus-distill`
  — no URL construction, no hash hunting, no copy-paste.
- Integrity is unchanged: bytes are still verified against the source's
  published digest before entering the store.
- Error messages are actionable: ambiguous/unknown files list the available
  GGUFs; non-HF sources point at `--sha256`.

**Cons / Trade-offs:**

- **HuggingFace coupling.** The auto path only works for HF. This is
  accepted: HF is where GGUFs live, and every other host keeps the explicit
  digest path. A future host (e.g. GitHub releases) would add another
  resolver behind the same interface.
- **One extra API round-trip** (repo info + tree) before the download.
  Negligible next to a multi-GB transfer.
- **Trust step is less visible.** The user no longer *sees* the digest they
  are trusting. Mitigation: the pull output and the adapter YAML still
  record the sha256 (`fileFingerprint`), and `--sha256` remains available
  for an independently sourced digest.
