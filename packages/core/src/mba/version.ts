/**
 * Per-runtime version comparison for MBA server selectors.
 *
 * ADR-0084 specifies:
 * - llama.cpp build tags compare numerically after stripping a leading "b"
 *   ("b3659" → 3659). Only ">=" and "<" are required.
 * - vllm/ollama use a semver subset (">=", "<", "~").
 *
 * For v1 we support ">=" and "<" for all runtimes. llama.cpp build tags are
 * normalized to integers; semver-looking strings are compared tuple-wise.
 */

const RANGE_RE = /^(>=|<|~|\^)\s*(.+)$/;

function normalizeLlamaBuild(version: string): number | undefined {
  const trimmed = version.trim();
  const withoutB = trimmed.startsWith("b") || trimmed.startsWith("B") ? trimmed.slice(1) : trimmed;
  const n = Number(withoutB);
  if (Number.isFinite(n)) return n;
  return undefined;
}

function parseSemverTuple(version: string): number[] {
  const head = version.split("-")[0] ?? version;
  return head
    .split(".")
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n));
}

function compareTuples(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function compareVersions(runtime: string, lhs: string, rhs: string): number {
  if (runtime === "llama.cpp") {
    const ln = normalizeLlamaBuild(lhs);
    const rn = normalizeLlamaBuild(rhs);
    if (ln !== undefined && rn !== undefined) return ln - rn;
  }
  return compareTuples(parseSemverTuple(lhs), parseSemverTuple(rhs));
}

function satisfiesOp(runtime: string, op: string, actual: string, bound: string): boolean {
  const cmp = compareVersions(runtime, actual, bound);
  switch (op) {
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "~":
    case "^":
      // Tilde/caret are not implemented for v1; treat as match to avoid
      // rejecting adapters that use them. A warning is the consumer's job.
      return true;
    default:
      return false;
  }
}

/**
 * Return true when `actualVersion` satisfies `range` for the given runtime.
 * An unparseable range is treated as a wildcard (returns true) so a typo does
 * not silently disable a safety config. Consumers should log a warning.
 */
export function satisfiesVersionRange(
  runtime: string,
  range: string,
  actualVersion: string | undefined,
): boolean {
  if (!actualVersion) return false;
  const match = RANGE_RE.exec(range.trim());
  if (!match) return true; // unparseable = wildcard per ADR-0084
  const op = match[1]!;
  const bound = match[2]!;
  return satisfiesOp(runtime, op, actualVersion, bound);
}
