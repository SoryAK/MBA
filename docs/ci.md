# CI — Jenkins Pipeline

MBA builds on every push to `main` via a Jenkins declarative pipeline defined in
[`Jenkinsfile`](../Jenkinsfile) at the repo root.

## What a build does

1. **Checkout** — clones the latest `main` from GitHub (`SoryAK/MBA`, public — no credential needed)
2. **Install** — `npm ci` (exact deps from `package-lock.json`)
3. **Typecheck** — `npm run typecheck` (`tsc --noEmit`)
4. **Test** — `npm test` (`vitest run`)
5. **Build** — `npm run build` (all workspaces with a build script)

Any stage failing marks the build red.

## One-time Jenkins setup

### 1. Node 22 tool

The pipeline references a NodeJS tool named **`node-22`**.

- Manage Jenkins → **Tools** → **NodeJS** → *Add NodeJS*
- **Name:** `node-22` (must match exactly)
- Either tick *Install automatically* (Jenkins downloads Node 22.x) or point
  **Tool home** at an existing install, e.g. `/usr/lib/node_modules` is NOT
  correct — use the directory *containing* the `bin/` folder, e.g.
  `/opt/node-22` or wherever `node` lives (`dirname $(dirname $(readlink -f $(command -v node)))`).

### 2. Create the job

1. **New Item** → name it `MBA` → type **Pipeline** → OK
2. **Pipeline** section:
   - **Definition:** *Pipeline script from SCM*
   - **SCM:** Git
   - **Repository URL:** `https://github.com/SoryAK/MBA.git`
   - **Branch:** `main`
   - **Script Path:** `Jenkinsfile`
3. **Save** → **Build Now** to verify the first run is green.

### 3. Trigger on push (optional but recommended)

GitHub → repo **Settings → Webhooks → Add webhook**:

- **Payload URL:** `http://<jenkins-host>:8080/github-webhook/`
- **Content type:** `application/json`
- **Events:** *Only selected events* → **Pushes**

Requires the **GitHub plugin** (Manage Jenkins → Plugins). After that, every
push to `main` triggers a build automatically — no polling.

Alternative without the webhook: tick **Build Triggers → Poll SCM** with
`H/5 * * * *` (checks every 5 min).

## Local parity

The pipeline runs exactly the scripts in `package.json`, so a green local
`npm run typecheck && npm test && npm run build` should always mean a green
build.
