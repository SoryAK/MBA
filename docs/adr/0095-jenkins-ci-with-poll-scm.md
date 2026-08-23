# ADR-0095: Jenkins CI with Poll SCM (local, no internet exposure)

**Status:** Accepted

## Context

The MBA repo needed automated CI: on every push to `main`, run typecheck + tests + build. Constraints:

- No GitHub Actions (local-only workflow; the repo is a private personal project).
- Jenkins 2.568.2 runs locally at `localhost:8082` as a systemd service.
- GitHub cannot reach `localhost` — a GitHub webhook would require a public tunnel (ngrok/cloudflared) that must stay alive and is a standing internet-exposure surface.

The decision under review: how should the Jenkins job be triggered on push?

## Decision

Use **Jenkins with Poll SCM** (schedule `H/5 * * * *`, every 5 minutes) rather than a GitHub webhook. The job is a declarative Pipeline defined in `Jenkinsfile` (script from SCM), using the NodeJS Plugin's `node-22` tool (Node 22.23.2). Stages: Checkout → Install (`npm ci`) → Typecheck → Test → Build.

## Consequences

**Pros:**

- **Zero internet exposure.** No tunnel, no public endpoint, no webhook secret to manage. The machine's only outbound traffic is the periodic `git ls-remote` poll.
- **Robust for local use.** Nothing to babysit: the poller survives Jenkins restarts, tunnel drops, and GitHub API hiccups. Jenkins runs as a systemd service with status `enabled`, so it auto-starts on reboot.
- **Verified end-to-end.** Build #1 (manual) green in 25s; Build #2 (poll-triggered, "Started by an SCM change") green in 15s.

**Cons / Trade-offs:**

- **≤5 minute latency** between push and build start (vs. seconds for a webhook). Acceptable for a personal project; the schedule can be tightened to `H/1` if needed.
- **Only builds while the machine is on and Jenkins is running.** A push made while the machine is off builds on the next poll after boot.
- **`main`-only.** Branch/PR builds would need a Multibranch Pipeline — deferred, not needed yet.

**Reversibility:** switching to a webhook later is a config change (GitHub plugin + payload URL `http://<jenkins-host>:8080/github-webhook/`) plus removing the poll schedule — no code changes. Documented in `docs/ci.md` §4.
