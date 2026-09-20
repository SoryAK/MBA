/**
 * Harness names the operator can connect: shipped envelopes plus
 * operator-defined clients. The catalog comes from GET /clients.
 */

import { serviceGet } from "./client.js";

export interface HarnessChoice {
  readonly name: string;
  readonly envelope: string;
  readonly source: "built-in" | "added";
  readonly ide?: string;
}

export async function listHarnessChoices(baseUrl: string): Promise<HarnessChoice[]> {
  const body = await serviceGet<{ clients: HarnessChoice[] }>(baseUrl, "/clients");
  return [...body.clients];
}

export async function harnessPickerRows(baseUrl: string): Promise<
  Array<{
    label: string;
    value: string;
    preview: ReadonlyArray<readonly [string, string]>;
  }>
> {
  const choices = await listHarnessChoices(baseUrl);
  return choices.map((h) => ({
    label: h.source === "added" ? `${h.name} (added)` : h.name,
    value: h.name,
    preview: [
      ["envelope", h.envelope],
      ["source", h.source],
    ] as const,
  }));
}
