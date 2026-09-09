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
 * Project-relative path the harness already injects.
 * `ide` is accepted so the door matches env (`harness` + `ide`); this cut
 * keys the filename on harness. Unknown harness with no extra → undefined.
 */
export function envelopeRelativePath(
  harness: string,
  _ide?: string,
  extras: readonly EnvelopeBinding[] = [],
): string | undefined {
  const known = normalizeHarness(harness);
  if (known) return ENVELOPE_BY_HARNESS[known];
  const key = compactHarnessKey(harness);
  const extra = extras.find((e) => compactHarnessKey(e.name) === key);
  return extra?.envelope;
}

export function isMbaStaged(text: string): boolean {
  return text.includes(MBA_STAGE_MARKER);
}

/** Wrap store card text so the harness file is identifiable and (when needed) always-on. */
export function wrapStagedCard(harness: string, body: string): string {
  const trimmed = body.replace(/^\uFEFF/, "").replace(/\s+$/, "") + "\n";
  const known = normalizeHarness(harness);
  if (known === "cursor") {
    return [
      "---",
      "description: MBA model card (live copy; do not edit)",
      "alwaysApply: true",
      "---",
      "",
      MBA_STAGE_MARKER,
      "",
      trimmed,
    ].join("\n");
  }
  if (known === "copilot") {
    return ["---", 'applyTo: "**"', "---", "", MBA_STAGE_MARKER, "", trimmed].join("\n");
  }
  return `${MBA_STAGE_MARKER}\n\n${trimmed}`;
}
