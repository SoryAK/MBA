/**
 * Harness envelope paths for staging `instructions.md` into a project.
 *
 * One card in the store. Environment (`harness` + `ide`) only picks the
 * filename/path the client already injects. These slots are extra files the
 * harness reads alongside the project's own playbook (CLAUDE.md / AGENTS.md).
 * MBA does not overwrite that playbook.
 *
 * Built-in harnesses ship out of the box. The operator may add more
 * (name + envelope) without MBA scanning the machine for IDEs.
 *
 * `notes.md` is not an envelope. It never leaves the store.
 */

/** Marker written into every staged file so MBA only overwrites its own copies. */
export const MBA_STAGE_MARKER = "<!-- mba-staged -->";

/** Closed set of harnesses MBA ships. Operator-defined names sit beside this. */
export const KNOWN_HARNESSES = ["claude-code", "cursor", "cline", "copilot", "continue"] as const;

export type KnownHarness = (typeof KNOWN_HARNESSES)[number];

const HARNESS_ALIASES: Readonly<Record<string, KnownHarness>> = {
  claude: "claude-code",
  claudecode: "claude-code",
  anthropic: "claude-code",
  githubcopilot: "copilot",
  vscodecopilot: "copilot",
};

const ENVELOPE_BY_HARNESS: Readonly<Record<KnownHarness, string>> = {
  "claude-code": "CLAUDE.local.md",
  cursor: ".cursor/rules/mba.mdc",
  cline: ".clinerules/mba.md",
  copilot: ".github/instructions/mba.instructions.md",
  continue: ".continue/rules/mba.md",
};

/** Extra envelope from an operator-defined client. */
export interface EnvelopeBinding {
  readonly name: string;
  readonly envelope: string;
}

export function compactHarnessKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Fold aliases (`claude`, `github-copilot`) onto the shipped harness set. */
export function normalizeHarness(raw: string): KnownHarness | undefined {
  const key = compactHarnessKey(raw);
  if ((KNOWN_HARNESSES as readonly string[]).includes(key)) return key as KnownHarness;
  return HARNESS_ALIASES[key];
}

/** True when the name is a shipped harness or an alias of one. */
export function isReservedHarnessName(raw: string): boolean {
  return normalizeHarness(raw) !== undefined;
}

export function builtInEnvelopeBindings(): readonly EnvelopeBinding[] {
  return KNOWN_HARNESSES.map((name) => ({ name, envelope: ENVELOPE_BY_HARNESS[name] }));
}

/**
 * Filesystem-safe stem when an operator envelope uses `{model}`.
 * Built-in slots do not use this — they are the filenames the harness
 * already injects. Empty / junk → `mba`.
 */
export function envelopeFileStem(modelId?: string): string {
  const stem = (modelId ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return stem.length > 0 ? stem.slice(0, 64) : "mba";
}

function fillEnvelopeTemplate(template: string, modelId?: string): string {
  if (!template.includes("{model}")) return template;
  return template.replaceAll("{model}", envelopeFileStem(modelId));
}

function modelMarkerLine(modelId?: string): string {
  const raw = (modelId ?? "").trim().replace(/-->/g, "");
  return raw.length > 0 ? `\n<!-- mba-model: ${raw} -->` : "";
}

/**
 * Project-relative path the harness already injects.
 * `ide` is accepted so the door matches env (`harness` + `ide`); this cut
 * keys the filename on harness. Built-in paths are stable so the client
 * keeps injecting the same slot; `modelId` is written into the card body.
 * An added client may put `{model}` in its envelope. Unknown harness with
 * no extra → undefined.
 */
export function envelopeRelativePath(
  harness: string,
  _ide?: string,
  extras: readonly EnvelopeBinding[] = [],
  modelId?: string,
): string | undefined {
  const known = normalizeHarness(harness);
  if (known) return fillEnvelopeTemplate(ENVELOPE_BY_HARNESS[known], modelId);
  const key = compactHarnessKey(harness);
  const extra = extras.find((e) => compactHarnessKey(e.name) === key);
  return extra ? fillEnvelopeTemplate(extra.envelope, modelId) : undefined;
}

export function isMbaStaged(text: string): boolean {
  return text.includes(MBA_STAGE_MARKER);
}

/** Model id planted in a staged envelope, if present. */
export function stagedModelId(text: string): string | undefined {
  const m = /<!--\s*mba-model:\s*([^\s>]+)\s*-->/.exec(text);
  return m?.[1];
}

/** Wrap store card text so the harness file is identifiable and (when needed) always-on. */
export function wrapStagedCard(harness: string, body: string, modelId?: string): string {
  const trimmed = body.replace(/^\uFEFF/, "").trimEnd() + "\n";
  const known = normalizeHarness(harness);
  const marker = `${MBA_STAGE_MARKER}${modelMarkerLine(modelId)}`;
  if (known === "cursor") {
    const label = modelId && modelId.trim().length > 0 ? modelId.trim() : "MBA";
    const description = JSON.stringify(`${label} model card (live copy; do not edit)`);
    return [
      "---",
      `description: ${description}`,
      "alwaysApply: true",
      "---",
      "",
      marker,
      "",
      trimmed,
    ].join("\n");
  }
  if (known === "copilot") {
    return ["---", 'applyTo: "**"', "---", "", marker, "", trimmed].join("\n");
  }
  return `${marker}\n\n${trimmed}`;
}
