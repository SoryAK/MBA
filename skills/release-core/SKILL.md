---
name: release-core
description: >-
  Publish @mba-ai/core via GitHub Actions Trusted Publisher, then a GitHub
  Release from the changelog. Use when the user asks to release, cut a
  version, npm publish, bump core, or tag v*.
---

# Release `@mba-ai/core`

Auth is npm Trusted Publisher (OIDC) on tag `v*`. There is no `NPM_TOKEN`.
Do not `npm publish` from a laptop. Do not use Jenkins. Do not publish
`@mba-ai/mcp-server` in this skill unless the user named that package and
it has a changelog section for the new version.

Full gate: [`docs/ci.md`](../../docs/ci.md).

## Do not start until

- The user asked to release (version bump + tag is the release).
- `main` is the intended ship line (release commit on a PR, then tag
  **after** merge — or say if they want the tag on the PR branch).
- You know patch / minor / major. If they did not say, ask.

## 1. Bump

1. Set `packages/core/package.json` `"version"` to `X.Y.Z`.
2. Update the root `package-lock.json` so it matches (`npm install` in the
   repo root is enough if it rewrites the workspace version).
3. Add a **new top** `## [X.Y.Z] — YYYY-MM-DD` section to
   `packages/core/CHANGELOG.md` for **this version only**. Do not backfill
   older releases. Do not leave an `Unreleased` heading.
4. Confirm `CHANGELOG.md` is in that package’s `"files"` array.

Changelog: short Added / Fixed / Changed. User-facing behavior, not every
commit. Date is today.

The publish workflow fails if the tag (`vX.Y.Z`) does not match
`package.json`, if the `## [X.Y.Z]` section is missing, or if
`## [Unreleased]` is still in the file.

## 2. Land on `main`

Release notes + version bump go through a PR like any other change.
Protect main requires the `test` check.

Do not tag a version that is not on `origin/main`.

## 3. Tag

After the bump is on `origin/main`:

```sh
git checkout main
git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

The tag **is** the version. `v0.1.16` publishes `0.1.16`. That job also
opens a GitHub Release from the `## [X.Y.Z]` changelog section so operators
can follow what shipped. npm is still the artifact. Do not
`gh release create` from the laptop unless verify shows npm is up and
the Release is missing.

Do not `--generate-notes` (commit dump). Do not attach binaries. Do not
delete or recreate the `v*` tag. Do not `gh release delete`.

## 4. Verify

Watch `.github/workflows/publish.yml`. Confirm both:

- https://www.npmjs.com/package/@mba-ai/core shows `X.Y.Z`
- https://github.com/SoryAK/MBA/releases/tag/vX.Y.Z exists and the notes
  are that changelog section (plus the npm link)

If npm is up and the GitHub Release is missing:

```sh
gh release create vX.Y.Z \
  --title "@mba-ai/core X.Y.Z" \
  --notes-file notes.md \
  --latest \
  --verify-tag
```

`notes.md` is the npm one-liner plus the `## [X.Y.Z]` body (same as
`.github/scripts/changelog-section.mjs`). Do not invent a second set of
notes.

If publish fails with `ENEEDAUTH`, `setup-node` must set
`registry-url: https://registry.npmjs.org`. Do not add an npm token to
fix it.

## mcp-server

Out of scope unless asked. First publish under the changelog rule needs
`packages/mcp-server/CHANGELOG.md` with a real `## [x.y.z]` section
(start at that version; no backfill) and that file in `"files"`.
