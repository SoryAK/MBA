---
name: open-pr
description: >-
  Open a GitHub pull request for MBA with gh, then watch CI until the
  required checks are green. Use when the user asks to create a PR, open a
  pull request, push a PR, or land the current branch.
---

# Open a PR

MBA’s merge gate is GitHub Actions plus Protect main. Do not push to `main`.
Use `gh` for all GitHub work. Never update git config. Never force-push
`main`. Never skip hooks.

## 1. Read the branch

In parallel:

```sh
git status
git diff
git status -sb
git log origin/main...HEAD
git diff origin/main...HEAD
```

If there is nothing to ship, stop.

## 2. Commit only if the user asked

Uncommitted work: commit only when the user asked to commit or to land a PR
that includes it. Follow the repo commit protocol (status, diff, log, HEREDOC
message, no secrets). One concern per commit.

## 3. Branch

If HEAD is `main`, create a topic branch from the commits to ship. Do not
open a PR from `main`.

Name: `docs/…`, `fix/…`, `feat/…`, `chore/…` matching the change.

## 4. Push

```sh
git push -u origin HEAD
```

Needs unrestricted git/network. Do not `--force` unless the user explicitly
asked and the branch is not `main`.

## 5. Create the PR

```sh
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullets>

## Test plan
- [ ] `npm run typecheck && npm test && npm run build`
- [ ]

EOF
)"
```

- Title: repo tense (`feat:`, `fix:`, `docs:`, `chore:`), says why.
- Summary: operator-readable. Not a commit dump.
- Test plan: what you actually ran, or that CI covers.
- Use `.github/PULL_REQUEST_TEMPLATE.md` headings.

If a PR for this branch already exists, push and return that URL. Do not
open a second PR.

## 6. Watch until green

The job is not done when the PR exists. Stay on it until the **required**
check is green. That check is **`test`** (typecheck, test, build). CodeQL
also runs; it is not the merge gate.

```sh
gh pr checks --watch
```

Refresh with `gh pr view` / `gh pr checks`. Do not poll in a tight loop
while checks are still running.

On red `test`:

1. Read the failing log. Do not guess from a green local run.
2. Fix the failure in this PR’s scope. Smallest change. Run the failing
   check locally, then push.
3. Do not edit `.github/workflows/` just to make CI pass. Do not skip
   hooks. Do not force-push.

Loop until `test` is green, or you are blocked.

## 7. Inform the user if it is critical

Stop and tell the user immediately when:

- A fix would reverse an ADR, add a plane, or change publish/CI auth
- Security, credentials, or a design choice you must not guess
- The failure is outside this PR and merging `main` does not explain it
- You cannot make `test` green after a real fix attempt

Say what failed, what you tried, and what you need. Do not go silent.
Do not merge, auto-merge, or mark ready unless the user asked.

## 8. Return

Give the PR URL. Report success only after a fresh `gh pr checks` shows
`test` green. If you had to stop, say that and why.
