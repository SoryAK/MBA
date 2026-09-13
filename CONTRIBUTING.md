# Contributing to MBA

MBA is the per-model behavior layer on your machine. It is not a host (Ollama)
and not a client (Cline). You give a model a house: how it boots, who may talk
to it, and what the system watches while it works.

We want **contributors and collaborators** — implementation, another inference
server, docs, and design. Read this before you write code.

## How to help

- **Issue** — a bug, a missing door, a design question.
- **PR** — a focused fix or a feature that already has an issue.
- **Docs** — README walkthrough, ADRs, AMPI handbook, this file.
- **Inference servers** — MBA boots llama.cpp today. More servers are welcome;
  do not lock the product to one.

Share what you build. Use MBA on a real model. That is the best review.

## Before you start

1. Search [issues](https://github.com/SoryAK/MBA/issues) and
   [PRs](https://github.com/SoryAK/MBA/pulls). Duplicates get closed.
2. **Features start with an issue**, not a PR. Let the design land first.
   Bug fixes may go straight to a PR if they include a test.
3. One concern per PR. Do not mix a CLI polish with an AMPI recipe.
4. New public CLI verbs and daemon routes have a higher bar than internal
   tests. Say why an existing door is not enough.
5. A green checklist does not guarantee a merge. MBA is opinionated about
   what belongs in the product.

If you are new: keep **one** open PR. Skip drive-by typo-only PRs unless they
fix something an operator will actually hit.

## Product lines (do not fight these)

These are already decided. A PR that quietly reverses them will not land.

- **Per-model house.** Dials, watches, and recipes belong to **this** model,
  not the fleet.
- **Daemon owns state.** `mba` is a thin door (ADR-0096). It does not edit
  adapter JSONL/YAML itself. Exception: `mba start` / `mba stop` (ADR-0107)
  (and `--help`, `completion`, `estimate-memory`).
- **Escalation names AMPI only.** The ladder never names a context cut.
  Context Management splices `messages[]`.
- **AMPI always finishes.** Bound/held limits are not AMPI. Assist is supply,
  not a clamp. Sanitize is the live recipe today; Assist / Sanction / Recover
  stay parked until their cut is named.
- **Boot is bare.** Connect attaches the client. Pairing must not silently
  pick an env overlay.
- **Commands take a model id.** `mba models list` is **id · family** (left
  column is what you type).

Architecture lives in [`docs/adr/`](docs/adr/). AMPI lives in
[`docs/ampi.md`](docs/ampi.md). The operator walkthrough is the
[README](README.md).

## Repo setup

Node **≥ 22**. From a clone:

```sh
npm install
npm run typecheck
npm test
npm run build
```

That is the same gate as CI ([`docs/ci.md`](docs/ci.md)): typecheck, test,
build. Audit runs on Actions only.

Run the daemon from the checkout:

```sh
mba start                 # or: npm run mba -- start
mba status
```

`mba` on your PATH is `packages/core/dist/cli/mba.js`. After CLI changes:

```sh
npm run build -w @mba-ai/core
```

If you `npm link` in `packages/core`, rebuild again so the linked bin matches.
The daemon can still run from source (`tsx`); restart the user unit after
service-path changes (`mba stop` then `mba start`, or `mba start --foreground`
for this terminal).

### Tests

- Put tests next to the code they cover (`*.test.ts`). Vitest.
- A bug fix should fail before the change and pass after.
- Do not snapshot whole TTY dumps. Route/parse tests and small printers are
  enough. JSON field names are the contract; TTY labels may move.

CLI work follows [`docs/workflows/cli-development.md`](docs/workflows/cli-development.md):
service payload first, then `mba` print. No Ink, Commander, or fzf.

## Pull requests

Branch from `main`. Open against `main`. Use the PR template.

- **Title** says why, in the repo’s tense (`feat:`, `fix:`, `docs:`, `chore:`).
- **Summary** is a few bullets an operator can read.
- **Test plan** is a checklist you actually ran (or that CI covers).
- Keep the diff to the concern. Do not reformat unrelated files.
- Do not bump `@mba-ai/*` versions or rewrite a shipped changelog section
  unless the PR **is** the release. See [`docs/ci.md`](docs/ci.md).

CI must be green (`test` job). CodeQL also runs; it is not the merge gate.

Expect review comments. Rebase onto `main` if the PR goes stale. Maintainers
squash-merge.

## AI

You may use AI. You are responsible for every line, however it was produced.

- Disclose if a model wrote a substantial part of the patch.
- Do not open a second PR for work that already has one.
- Review the diff yourself before you ask anyone else to.
- Be able to explain the change. “The model did it” is not a review.
- Do not paste unread model output as an issue, a PR body, or a reply.
  Those are how we talk to each other.

Low-quality or unreviewed dumps will be closed.

## Docs

- Operator path: [README](README.md)
- Package: [`packages/core/README.md`](packages/core/README.md)
- AMPI: [`docs/ampi.md`](docs/ampi.md)
- Decisions: [`docs/adr/`](docs/adr/)
- Merge gate: [`docs/ci.md`](docs/ci.md)
- System manual: [`.Manual/model-behavioral-adapters.md`](.Manual/model-behavioral-adapters.md)

If you had to read the source to use something, add a sentence where the next
person will look.

## Conduct

Be respectful. Harassment is not tolerated. See
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
