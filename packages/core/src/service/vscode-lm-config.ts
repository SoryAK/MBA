/**
 * VS Code chatLanguageModels.json path resolution (B6).
 *
 * VS Code records the active profile in `settings.json` under
 * `workbench.profile.default`. When that key is absent (or the file is
 * missing/unreadable), the user is on the default profile, whose config lives
 * at the no-profile location. The `MBA_VSCODE_LM_CONFIG` env override is
 * applied by the caller and always wins.
 *
 * Kept in its own module (no side effects) so it is testable without booting
 * the service.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function resolveVsCodeLmConfigPath(homeDir: string): string {
  const userDir = join(homeDir, ".config", "Code", "User");
  const settingsPath = join(userDir, "settings.json");
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      const profile = settings["workbench.profile.default"];
      if (typeof profile === "string" && profile.length > 0) {
        return join(userDir, "profiles", profile, "chatLanguageModels.json");
      }
    }
  } catch {
    // Unreadable or malformed settings.json — fall through to the default.
  }
  return join(userDir, "chatLanguageModels.json");
}
