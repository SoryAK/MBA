/**
 * Remove leftover Vitest fixture dirs from `os.tmpdir()`.
 *
 * Production MBA never `mkdtemp`s under /tmp. Tests do (`mba-*`, `bcb-*`),
 * and many files never `rmSync`. Vitest 5 runs this via `globalSetup`; the
 * returned function is the teardown so a suite cannot keep filling tmp.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PREFIXES = ["mba-", "bcb-"] as const;

export function isMbaTestTempName(name: string): boolean {
  return TEST_PREFIXES.some((p) => name.startsWith(p));
}

/** Delete matching dirs. Returns the paths removed. */
export function removeMbaTestTempDirs(root: string = tmpdir()): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!isMbaTestTempName(name)) continue;
    const path = join(root, name);
    try {
      if (!statSync(path).isDirectory()) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Best-effort: a still-open sqlite handle or racing test can fail one dir.
    }
  }
  return removed;
}

export function setup(): () => void {
  return () => {
    const removed = removeMbaTestTempDirs();
    if (removed.length > 0) {
      console.log(`[vitest] removed ${removed.length} leftover test temp dir(s)`);
    }
  };
}

export default setup;
