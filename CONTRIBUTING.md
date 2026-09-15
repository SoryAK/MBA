# Contributing to MBA

MBA is the per-model behavior layer on your machine. It is not a host (Ollama)
and not a client (Cline).

We want **contributors and collaborators** — implementation, docs, and design.
Read this before you write code. Product direction lives in issues and
[`docs/adr/`](docs/adr/), not in this file.

## How to help

- **Issue** — a bug, a missing door, a design question.
- **PR** — a focused fix or a feature that already has an issue.
- **Docs** — README walkthrough, ADRs, AMPI handbook, this file.

Share what you build. Use MBA on a real model. That is the best review.

## Before you start

1. Search [issues](https://github.com/SoryAK/MBA/issues) and
   [PRs](https://github.com/SoryAK/MBA/pulls). Duplicates get closed.
2. **Features start with an issue**, not a PR. Let the design land first.
   Bug fixes may go straight to a PR if they include a test.
3. One concern per PR. Do not mix unrelated surfaces in the same change.
4. New public CLI verbs and daemon routes have a higher bar than internal
   tests. Say why an existing door is not enough.
5. A green checklist does not guarantee a merge. Architecture is in
   [`docs/adr/`](docs/adr/). A PR that quietly reverses an accepted ADR
   will not land.

If you are new: keep **one** open PR. Skip drive-by typo-only PRs unless they
fix something an operator will actually hit.

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
The daemon can still run from source (`tsx`); `mba restart` after
service-path changes (`mba start --foreground` for this terminal).

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

By contributing you agree that your contributions are licensed under the
project’s [Apache-2.0](LICENSE) license.

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

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
Use [GitHub private vulnerability reporting](https://github.com/SoryAK/MBA/security/advisories/new).

## Conduct

Be respectful. Harassment is not tolerated. See
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
