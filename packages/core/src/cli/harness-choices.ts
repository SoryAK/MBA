/**
 * Harness names the operator can connect: shipped envelopes plus
 * operator-defined clients in mba/clients.json.
 */

import { builtInEnvelopeBindings, envelopeRelativePath } from "../mba/envelope.js";
import { defaultStorePaths } from "../service/config-store.js";
import { readOperatorClients } from "../service/operator-clients.js";

export interface HarnessChoice {
  readonly name: string;
  readonly envelope: string;
  readonly source: "built-in" | "added";
}

export function listHarnessChoices(): HarnessChoice[] {
  const extras = readOperatorClients(defaultStorePaths().clientsPath);
  const builtIn = builtInEnvelopeBindings().map((b) => ({
    name: b.name,
    envelope: b.envelope,
    source: "built-in" as const,
  }));
  const added = extras.map((c) => ({
    name: c.name,
    envelope: c.envelope,
    source: "added" as const,
  }));
  return [...builtIn, ...added];
}

export function harnessPickerRows(): Array<{
  label: string;
  value: string;
  preview: ReadonlyArray<readonly [string, string]>;
}> {
  return listHarnessChoices().map((h) => ({
    label: h.source === "added" ? `${h.name} (added)` : h.name,
    value: h.name,
    preview: [
      ["envelope", envelopeRelativePath(h.name, undefined, [{ name: h.name, envelope: h.envelope }]) ?? h.envelope],
      ["source", h.source],
    ] as const,
  }));
}
