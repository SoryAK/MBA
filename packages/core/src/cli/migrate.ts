import { existsSync, readdirSync } from "node:fs";
import {
  defaultModelStoreRoot,
  defaultStateDir,
  ensureDir,
  executeMigration,
  legacyModelStoreRoot,
  legacyStateDir,
} from "../service/paths.js";

function probeDir(dir: string): { exists: boolean; empty: boolean } {
  const exists = existsSync(dir);
  const empty = exists && readdirSync(dir).length === 0;
  return { exists, empty };
}

/**
 * `mba migrate-paths` — one-time move of state + model store from the
 * legacy locations to the OS-aware ones. Local only; the service can be down.
 */
export function cmdMigratePaths(): void {
  const homes: ReadonlyArray<{ label: string; from: string; to: string }> = [
    { label: "state", from: legacyStateDir(), to: defaultStateDir() },
    { label: "store", from: legacyModelStoreRoot(), to: defaultModelStoreRoot() },
  ];
  let moved = 0;
  for (const home of homes) {
    const src = probeDir(home.from);
    const dst = probeDir(home.to);
    const result = executeMigration(home.from, home.to, src.exists, dst.exists, dst.empty);
    switch (result.status) {
      case "moved":
        moved += 1;
        process.stdout.write(`[mba] ${home.label}: moved ${home.from} → ${home.to}\n`);
        break;
      case "skipped-missing-source":
        process.stdout.write(`[mba] ${home.label}: nothing to move (no ${home.from})\n`);
        break;
      case "skipped-destination-exists":
        process.stdout.write(
          `[mba] ${home.label}: SKIPPED — ${home.to} already has data; not overwriting. ` +
            `Move or merge ${home.from} by hand if you need it.\n`,
        );
        break;
    }
  }
  ensureDir(defaultStateDir());
  ensureDir(defaultModelStoreRoot());
  process.stdout.write(
    `[mba] migrate-paths done — ${moved} home(s) moved. ` +
      `State: ${defaultStateDir()}\n[mba] Store: ${defaultModelStoreRoot()}\n`,
  );
}
