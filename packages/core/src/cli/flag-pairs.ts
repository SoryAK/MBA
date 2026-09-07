/**
 * Turn a flat llama.cpp argv (`--ctx-size`, `110000`, `--jinja`, …)
 * into flag/value rows so the CLI can print a table, not a stack dump.
 */

export interface FlagPair {
  readonly flag: string;
  readonly value: string;
}

export interface FlagGroup {
  readonly name: string;
  readonly pairs: readonly FlagPair[];
}

const GROUP_FLAGS: ReadonlyArray<{ readonly name: string; readonly flags: readonly string[] }> = [
  { name: "context", flags: ["--ctx-size", "-c", "--parallel"] },
  {
    name: "compute",
    flags: ["-ngl", "--n-gpu-layers", "--gpu-layers", "--threads", "--flash-attn", "-fa"],
  },
  {
    name: "cache",
    flags: [
      "--cache-reuse",
      "--cache-ram",
      "-ctk",
      "-ctv",
      "--cache-type-k",
      "--cache-type-v",
    ],
  },
  { name: "reasoning", flags: ["--reasoning-budget", "--reasoning-preserve"] },
];

export function pairCliArgs(args: readonly string[]): FlagPair[] {
  const out: FlagPair[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    const next = args[i + 1];
    if (flag.startsWith("-") && next !== undefined && !next.startsWith("-")) {
      out.push({ flag, value: next });
      i += 1;
    } else {
      out.push({ flag, value: flag.startsWith("-") ? "on" : flag });
    }
  }
  return out;
}

export function groupFlagPairs(pairs: readonly FlagPair[]): FlagGroup[] {
  const buckets = new Map<string, FlagPair[]>();
  for (const g of GROUP_FLAGS) buckets.set(g.name, []);
  const other: FlagPair[] = [];

  for (const pair of pairs) {
    const group = GROUP_FLAGS.find((g) => g.flags.includes(pair.flag));
    if (group) buckets.get(group.name)!.push(pair);
    else other.push(pair);
  }

  const out: FlagGroup[] = [];
  for (const g of GROUP_FLAGS) {
    const list = buckets.get(g.name) ?? [];
    if (list.length > 0) out.push({ name: g.name, pairs: list });
  }
  if (other.length > 0) out.push({ name: "other", pairs: other });
  return out;
}
