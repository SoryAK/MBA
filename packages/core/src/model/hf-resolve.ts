/**
 * HuggingFace source resolution (ADR-0099).
 *
 * Turns a repo shorthand (`owner/repo[:file-or-quant]`) or a HuggingFace
 * resolve URL into the two facts `pullModel` needs: the download URL and
 * the content sha256 (the repo's LFS `oid`).
 *
 * The digest comes from the same host as the file — the repo's published
 * LFS metadata — so this removes the copy-paste step without weakening the
 * integrity guarantee: MBA still verifies the downloaded bytes against the
 * digest before anything enters the store.
 *
 * Only HuggingFace is supported; any other host still requires an explicit
 * `--sha256` (ADR-0098).
 */

const HF_HOSTS = new Set(["huggingface.co", "hf.co"]);

/** The source could not be resolved to a URL + published digest. */
export class HfResolveError extends Error {}

export interface HfResolvedSource {
  /** Download URL (HuggingFace resolve endpoint). */
  readonly url: string;
  /** Content sha256 (64 hex chars) from the repo's LFS metadata. */
  readonly sha256: string;
  /** File name within the repo (basename of the download). */
  readonly fileName: string;
}

interface HfTreeEntry {
  readonly type?: unknown;
  readonly path?: unknown;
  readonly lfs?: { readonly oid?: unknown; readonly size?: unknown } | null;
}

interface HfModelInfo {
  /** Commit hash of the repo's default branch (used to pin the tree listing). */
  readonly sha?: unknown;
}

/**
 * Parse a repo shorthand: `owner/repo`, `owner/repo:file`, or
 * `owner/repo:QUANT`. Returns undefined when the string is not a shorthand
 * (e.g. it is a URL or has more than two path segments).
 */
export function parseHfRef(
  ref: string,
): { owner: string; repo: string; file?: string } | undefined {
  const m = ref.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?::([A-Za-z0-9_.\-/]+))?$/);
  if (!m || !m[1] || !m[2]) return undefined;
  const file = m[3] && m[3].length > 0 ? m[3] : undefined;
  return { owner: m[1], repo: m[2], file };
}

/**
 * Extract `owner/repo/branch/file` from a HuggingFace resolve URL.
 * Returns undefined for non-HF hosts or non-resolve paths.
 */
export function parseHfUrl(
  url: string,
): { owner: string; repo: string; branch: string; file: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!HF_HOSTS.has(u.hostname)) return undefined;
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/resolve\/([^/]+)\/(.+)$/);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return undefined;
  return { owner: m[1], repo: m[2], branch: m[3], file: decodeURIComponent(m[4]) };
}

async function hfGetJson(
  doFetch: typeof fetch,
  url: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await doFetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new HfResolveError(
      `HuggingFace request failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 404) {
    throw new HfResolveError(`HuggingFace repo not found: ${url}`);
  }
  if (!res.ok) {
    throw new HfResolveError(`HuggingFace request failed: HTTP ${res.status} for ${url}`);
  }
  try {
    return await res.json();
  } catch {
    throw new HfResolveError(`HuggingFace returned non-JSON for ${url}`);
  }
}

/**
 * List the repo's files with their LFS oids (sha256).
 *
 * The tree is pinned to a git ref: either the branch named in a resolve URL,
 * or the default branch's commit hash (the `sha` field of the model-info
 * endpoint) when no branch is given. Pinning to a commit keeps the digest and
 * the download URL consistent with the exact revision the repo published.
 */
async function listRepoFiles(
  doFetch: typeof fetch,
  owner: string,
  repo: string,
  branch?: string,
): Promise<{ ref: string; files: Array<{ path: string; sha256?: string; size?: number }> }> {
  const base = `https://huggingface.co/api/models/${owner}/${repo}`;
  let ref = branch;
  if (!ref) {
    const info = (await hfGetJson(doFetch, base)) as HfModelInfo;
    if (typeof info.sha !== "string" || info.sha.length === 0) {
      throw new HfResolveError(`could not determine the default revision of ${owner}/${repo}`);
    }
    ref = info.sha;
  }
  const tree = (await hfGetJson(doFetch, `${base}/tree/${ref}`)) as unknown;
  if (!Array.isArray(tree)) {
    throw new HfResolveError(`unexpected HuggingFace tree response for ${owner}/${repo}`);
  }
  const files: Array<{ path: string; sha256?: string; size?: number }> = [];
  for (const entry of tree as HfTreeEntry[]) {
    if (entry.type !== "file" || typeof entry.path !== "string") continue;
    const oid = entry.lfs && typeof entry.lfs.oid === "string" ? entry.lfs.oid : undefined;
    const size = entry.lfs && typeof entry.lfs.size === "number" ? entry.lfs.size : undefined;
    files.push({ path: entry.path, sha256: oid, size });
  }
  return { ref, files };
}

function ggufFiles(files: Array<{ path: string; sha256?: string }>): Array<{ path: string; sha256?: string }> {
  return files.filter((f) => f.path.toLowerCase().endsWith(".gguf"));
}

function fileListing(files: Array<{ path: string }>): string {
  return files.map((f) => `  ${f.path}`).join("\n");
}

/**
 * Resolve a HuggingFace source to a download URL + sha256.
 *
 * Accepts:
 * - repo shorthand: `owner/repo` (single GGUF), `owner/repo:path/to/file.gguf`,
 *   or `owner/repo:QUANT` (quant-suffix match, e.g. `Q4_K_M`)
 * - a HuggingFace resolve URL: `https://huggingface.co/o/r/resolve/branch/file`
 *
 * Throws HfResolveError when the source is not HuggingFace, the file is not
 * found, the match is ambiguous, or the repo does not publish an LFS oid for
 * the file (in which case an explicit --sha256 is required).
 */
export async function resolveHfSource(
  source: string,
  doFetch: typeof fetch = fetch,
): Promise<HfResolvedSource> {
  const ref = parseHfRef(source);
  const urlRef = parseHfUrl(source);
  if (!ref && !urlRef) {
    throw new HfResolveError(
      `cannot resolve a digest for ${source} — supported sources: HuggingFace repo shorthand (owner/repo[:file-or-quant]) or a huggingface.co resolve URL; for other hosts pass --sha256 explicitly`,
    );
  }

  const owner = ref ? ref.owner : urlRef!.owner;
  const repo = ref ? ref.repo : urlRef!.repo;
  const branch = urlRef?.branch;
  const wanted = ref?.file ?? urlRef?.file;

  const { ref: resolvedRef, files } = await listRepoFiles(doFetch, owner, repo, branch);
  const ggufs = ggufFiles(files);

  let match: { path: string; sha256?: string } | undefined;
  if (wanted) {
    // 1. Exact path match (relative to the repo root).
    match = ggufs.find((f) => f.path === wanted);
    if (!match) {
      // 2. Quant-suffix match: `Q4_K_M` → any file ending in `.Q4_K_M.gguf`.
      const suffix = `.${wanted.toLowerCase()}.gguf`;
      const candidates = ggufs.filter((f) => f.path.toLowerCase().endsWith(suffix));
      if (candidates.length === 1) {
        match = candidates[0];
      } else if (candidates.length > 1) {
        throw new HfResolveError(
          `ambiguous quant '${wanted}' in ${owner}/${repo} — pick a file:\n${fileListing(candidates)}`,
        );
      } else {
        throw new HfResolveError(
          `no file matching '${wanted}' in ${owner}/${repo} — available GGUFs:\n${fileListing(ggufs)}`,
        );
      }
    }
  } else {
    if (ggufs.length === 1) {
      match = ggufs[0];
    } else if (ggufs.length === 0) {
      throw new HfResolveError(`no GGUF files found in ${owner}/${repo}`);
    } else {
      throw new HfResolveError(
        `${owner}/${repo} has multiple GGUF files — pick one with owner/repo:file or owner/repo:QUANT:\n${fileListing(ggufs)}`,
      );
    }
  }

  if (!match?.sha256) {
    throw new HfResolveError(
      `${owner}/${repo} does not publish an LFS sha256 for ${match?.path ?? wanted} — pass --sha256 explicitly`,
    );
  }

  return {
    url: `https://huggingface.co/${owner}/${repo}/resolve/${resolvedRef}/${match.path}`,
    sha256: match.sha256.toLowerCase(),
    fileName: match.path.split("/").pop() ?? match.path,
  };
}

/** A single result from the HuggingFace model-search endpoint. */
export interface HfSearchResult {
  /** Repo id in `owner/repo` form. */
  readonly id: string;
  /** Download count, when the API reports one. */
  readonly downloads?: number;
  /** Like count, when the API reports one. */
  readonly likes?: number;
}

interface HfSearchEntry {
  readonly id?: unknown;
  readonly downloads?: unknown;
  readonly likes?: unknown;
}

/**
 * Search HuggingFace for models matching a free-text query.
 *
 * Results are sorted by download count (descending) so the most-used repos
 * surface first. Used by the interactive `mba pull search` flow.
 */
export async function searchHfModels(
  query: string,
  opts: { limit?: number; doFetch?: typeof fetch } = {},
): Promise<HfSearchResult[]> {
  const { limit = 20, doFetch = fetch } = opts;
  const url =
    `https://huggingface.co/api/models?search=${encodeURIComponent(query)}` +
    `&limit=${limit}&sort=downloads&direction=-1`;
  const data = (await hfGetJson(doFetch, url)) as unknown;
  if (!Array.isArray(data)) {
    throw new HfResolveError(`unexpected HuggingFace search response for '${query}'`);
  }
  const results: HfSearchResult[] = [];
  for (const entry of data as HfSearchEntry[]) {
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    results.push({
      id: entry.id,
      downloads: typeof entry.downloads === "number" ? entry.downloads : undefined,
      likes: typeof entry.likes === "number" ? entry.likes : undefined,
    });
  }
  return results;
}

/** A GGUF file published in a HuggingFace repo. */
export interface HfGgufFile {
  /** File path relative to the repo root. */
  readonly path: string;
  /** Content sha256 (LFS oid), when the repo publishes one. */
  readonly sha256?: string;
  /** File size in bytes, when the API reports one. */
  readonly size?: number;
}

/** The pinned revision plus the GGUF files published in a HuggingFace repo. */
export interface HfGgufListing {
  /** The pinned commit sha of the default branch (or the requested ref). */
  readonly ref: string;
  /** GGUF files in the repo. Empty when the repo has no GGUFs. */
  readonly files: HfGgufFile[];
}

/**
 * List the GGUF files published in a HuggingFace repo (default branch).
 *
 * Used by the interactive `mba pull search` flow to offer a quant picker.
 * Returns the pinned `ref` alongside the files so callers can build a full
 * resolve URL and skip the second tree fetch during pull.
 */
export async function listHfGgufs(
  owner: string,
  repo: string,
  doFetch: typeof fetch = fetch,
): Promise<HfGgufListing> {
  const { ref, files } = await listRepoFiles(doFetch, owner, repo);
  return { ref, files: ggufFiles(files) };
}
