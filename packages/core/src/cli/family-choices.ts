/**
 * TTY family pick for migrate and pull: existing hub families, or type a new one.
 */

import { askTextInteractive, pickLabeledInteractive } from "./interactive.js";
import {
  NEW_FAMILY,
  rankHubFamilies,
  suggestFamily,
  type HubFamily,
} from "../model/suggest-family.js";

export function familyPickerRows(
  families: readonly HubFamily[],
  needles: readonly string[],
): Array<{
  label: string;
  value: string;
  preview: ReadonlyArray<readonly [string, string]>;
}> {
  const rows = rankHubFamilies(families, needles).map((f) => ({
    label: f.name,
    value: f.name,
    preview: [
      ["models", String(f.models)],
      ["do", "existing family"],
    ] as ReadonlyArray<readonly [string, string]>,
  }));
  const hint = needles.find((n) => n.trim().length > 0)?.trim() ?? "";
  const newPreview: ReadonlyArray<readonly [string, string]> = hint
    ? [
        ["do", "type a family name"],
        ["hint", hint],
      ]
    : [["do", "type a family name"]];
  rows.push({
    label: "new",
    value: NEW_FAMILY,
    preview: newPreview,
  });
  return rows;
}

/**
 * Pick a family already in the hub, or type a new slug.
 * Empty hub → one-line text prompt (same as before).
 */
export async function askFamilyInteractive(
  needles: readonly string[],
  families: readonly HubFamily[],
): Promise<string | null> {
  const typedDefault =
    needles.find((n) => n.trim().length > 0)?.trim() ?? "model";
  if (families.length === 0) {
    return askTextInteractive("family", typedDefault);
  }
  const suggested = suggestFamily(needles, families);
  const pick = await pickLabeledInteractive(
    "family",
    familyPickerRows(families, needles),
    { selectedValue: suggested ?? NEW_FAMILY },
  );
  if (pick === null) return null;
  if (pick === NEW_FAMILY) {
    return askTextInteractive("family", typedDefault);
  }
  return pick;
}
