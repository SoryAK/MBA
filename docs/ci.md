# CI — GitHub Actions merge gate

MBA’s quality gate is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
It runs on every **pull request** and on every **push to `main`**. The
**Protect main** ruleset requires that check to be green before a PR can
merge. A red typecheck, test, or build cannot land on `main` unless someone
explicitly bypasses the ruleset.

## What a run does

1. **Install** — `npm ci` (exact deps from `package-lock.json`)
2. **Audit** — `npm audit --omit=dev --audit-level=high`
3. **Typecheck** — `npm run typecheck` (`tsc --noEmit`)
4. **Test** — `npm test` (`vitest run`)
5. **Build** — `npm run build` (all workspaces with a build script)

The check name GitHub requires is **`test`** (the job in that workflow).
CodeQL also runs on PRs; it is not part of the merge requirement.

## Local parity

A green local `npm run typecheck && npm test && npm run build` should mean a
green Actions run (audit is extra on CI).

After CLI UI changes, rebuild `@mba-ai/core` so a linked `mba` matches CI’s
`dist`. The daemon still runs from source (`tsx`); restart the user unit
after service-path changes.

## Ruleset

Repository **Settings → Rules → Protect main** (branch `main`):

- Must go through a pull request
- Required status check: `test` (GitHub Actions)
- No force-push, no deleting `main`

The repo owner can still bypass in an emergency. Treat that as exceptional.

## npm publish (Trusted Publisher)

`@mba-ai/core` publishes from [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
when you push a tag that matches the package version (`v0.1.16` → `0.1.16`).
It does not run on PRs or on `main`. `@mba-ai/mcp-server` is not in this
workflow.

GitHub Actions authenticates to npm with OIDC. There is no `NPM_TOKEN`.
`setup-node` must set `registry-url: https://registry.npmjs.org` or npm
never requests that token (`ENEEDAUTH`).

One-time on [npmjs.com](https://www.npmjs.com/package/@mba-ai/core) → package
settings → **Trusted Publisher** → **GitHub Actions**:

| Field | Value |
| --- | --- |
| Organization or user | `SoryAK` |
| Repository | `MBA` (the name only, not the git URL) |
| Workflow filename | `publish.yml` |
| Environment | leave empty |
| Allowed actions | `npm publish` |

Keep two-factor authentication required on the account.

Release path: bump `packages/core/package.json` (and the lockfile), add a
`## [x.y.z]` section to `packages/core/CHANGELOG.md`, merge to `main`, then
`git tag vX.Y.Z && git push origin vX.Y.Z`.

If a check ever needs this machine’s GPU or LAN, add a self-hosted
Actions runner — not a second CI product.
