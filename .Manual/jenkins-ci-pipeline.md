# Jenkins CI Pipeline

## Feature Name

Automated build verification for the MBA repo — every push to `main` is typechecked, tested, and built by Jenkins.

## Functional Description

When a commit lands on `main` on GitHub, Jenkins (running locally) automatically checks out that exact commit and runs the full quality gate: install dependencies, typecheck, run all tests, build all packages. A green build means the pushed code is known-good; a red build points at the stage that failed. The developer does not need to remember to run anything — the machine does it within ~5 minutes of the push.

## Internal Workflow

1. Developer pushes a commit to `main` on GitHub.
2. Every 5 minutes, Jenkins polls GitHub (`git ls-remote`) for the `main` branch (Poll SCM, schedule `H/5 * * * *`).
3. When a new commit is detected, Jenkins starts a build ("Started by an SCM change").
4. Jenkins clones the repo fresh from GitHub into `/var/lib/jenkins/workspace/MBA` (it builds the **committed** code, never the local working copy).
5. Pipeline stages run in order: **Checkout** → **Install** (`npm ci`) → **Typecheck** (`npm run typecheck`) → **Test** (`npm test`, vitest) → **Build** (`npm run build`).
6. The build result (green/red) is visible on the job page at `http://localhost:8082/job/MBA/`; the console log shows per-stage output.

## Configuration/Params

| Setting | Value | Where |
| --- | --- | --- |
| Jenkins URL | `http://localhost:8082` | systemd service, auto-starts on reboot (status `enabled`) |
| Job name | `MBA` (Pipeline) | Jenkins UI |
| SCM | Git, `https://github.com/SoryAK/MBA.git`, branch `*/main` | Job config |
| Script Path | `Jenkinsfile` (repo root) | Job config |
| Node tool | `node-22` (Node 22.23.2, auto-installed by NodeJS Plugin 1.6.6) | Manage Jenkins → Tools |
| Poll schedule | `H/5 * * * *` (every 5 min) | Job config → Triggers → Poll SCM |
| Poll log | `http://localhost:8082/job/MBA/scmPollLog` | Job page link |

## Known Constraints

- **≤5 minute latency** between push and build start (polling interval).
- **Builds only while the machine is on** and Jenkins is running.
- **`main`-only** — no branch/PR builds (would need a Multibranch Pipeline).
- **Committed code only** — uncommitted local changes are never built.
- **No webhook** — GitHub cannot reach `localhost`; a webhook would need a public tunnel. Documented as a future option in `docs/ci.md` §4 (only if Jenkins ever moves to a publicly reachable server).
