import { describe, expect, it } from "vitest";
import {
  HfResolveError,
  parseHfRef,
  parseHfUrl,
  resolveHfSource,
  searchHfModels,
} from "./hf-resolve.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
/** Commit hash of the fake repo's default branch (git sha, 40 hex chars). */
const DEFAULT_REF = "d".repeat(40);

/**
 * Fake HuggingFace API: one repo with two GGUFs and one non-GGUF file.
 * The model-info endpoint reports the default revision as `sha` (a commit
 * hash) unless overridden; the tree is served at `/tree/<sha>`.
 */
function fakeHfFetch(over: { sha?: string; status?: number } = {}): typeof fetch {
  const tree = [
    { type: "file", path: "model.Q4_K_M.gguf", lfs: { oid: SHA_A, size: 100 } },
    { type: "file", path: "model.Q8_0.gguf", lfs: { oid: SHA_B, size: 200 } },
    { type: "file", path: "README.md", lfs: { oid: "c".repeat(64), size: 10 } },
    { type: "directory", path: "subdir" },
  ];
  const ref = over.sha ?? DEFAULT_REF;
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (over.status) {
      return new Response("nope", { status: over.status });
    }
    if (url.endsWith("/api/models/owner/repo")) {
      return Response.json({ sha: ref });
    }
    // Tree listing — served for the default revision and for any branch named
    // in a resolve URL.
    if (url.includes("/api/models/owner/repo/tree/")) {
      return Response.json(tree);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("parseHfRef", () => {
  it("parses owner/repo", () => {
    expect(parseHfRef("owner/repo")).toEqual({ owner: "owner", repo: "repo", file: undefined });
  });

  it("parses owner/repo:file with path", () => {
    expect(parseHfRef("owner/repo:sub/model.gguf")).toEqual({
      owner: "owner",
      repo: "repo",
      file: "sub/model.gguf",
    });
  });

  it("parses owner/repo:QUANT", () => {
    expect(parseHfRef("owner/repo:Q4_K_M")).toEqual({
      owner: "owner",
      repo: "repo",
      file: "Q4_K_M",
    });
  });

  it("rejects URLs and multi-segment strings", () => {
    expect(parseHfRef("https://huggingface.co/owner/repo")).toBeUndefined();
    expect(parseHfRef("a/b/c")).toBeUndefined();
    expect(parseHfRef("justone")).toBeUndefined();
  });
});

describe("parseHfUrl", () => {
  it("parses a resolve URL", () => {
    expect(
      parseHfUrl("https://huggingface.co/owner/repo/resolve/main/model.Q4_K_M.gguf"),
    ).toEqual({ owner: "owner", repo: "repo", branch: "main", file: "model.Q4_K_M.gguf" });
  });

  it("decodes URL-encoded file names", () => {
    expect(parseHfUrl("https://huggingface.co/owner/repo/resolve/main/my%20model.gguf")).toEqual({
      owner: "owner",
      repo: "repo",
      branch: "main",
      file: "my model.gguf",
    });
  });

  it("rejects non-HF hosts and non-resolve paths", () => {
    expect(parseHfUrl("https://example.com/owner/repo/resolve/main/f.gguf")).toBeUndefined();
    expect(parseHfUrl("https://huggingface.co/owner/repo")).toBeUndefined();
    expect(parseHfUrl("not a url")).toBeUndefined();
  });
});

describe("resolveHfSource", () => {
  it("resolves owner/repo:QUANT via quant-suffix match", async () => {
    const r = await resolveHfSource("owner/repo:Q4_K_M", fakeHfFetch());
    expect(r).toEqual({
      url: `https://huggingface.co/owner/repo/resolve/${DEFAULT_REF}/model.Q4_K_M.gguf`,
      sha256: SHA_A,
      fileName: "model.Q4_K_M.gguf",
    });
  });

  it("resolves owner/repo:file via exact path match", async () => {
    const r = await resolveHfSource("owner/repo:model.Q8_0.gguf", fakeHfFetch());
    expect(r.sha256).toBe(SHA_B);
    expect(r.fileName).toBe("model.Q8_0.gguf");
  });

  it("resolves a bare owner/repo when exactly one GGUF exists", async () => {
    const single = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/models/owner/repo")) {
        return Response.json({ sha: DEFAULT_REF });
      }
      return Response.json([
        { type: "file", path: "only.gguf", lfs: { oid: SHA_A, size: 1 } },
      ]);
    }) as typeof fetch;
    const r = await resolveHfSource("owner/repo", single);
    expect(r.url).toBe(`https://huggingface.co/owner/repo/resolve/${DEFAULT_REF}/only.gguf`);
    expect(r.sha256).toBe(SHA_A);
  });

  it("resolves a HuggingFace resolve URL", async () => {
    const r = await resolveHfSource(
      "https://huggingface.co/owner/repo/resolve/main/model.Q4_K_M.gguf",
      fakeHfFetch(),
    );
    expect(r.sha256).toBe(SHA_A);
    expect(r.fileName).toBe("model.Q4_K_M.gguf");
  });

  it("lists available GGUFs when the repo has multiple and no file given", async () => {
    await expect(resolveHfSource("owner/repo", fakeHfFetch())).rejects.toThrow(
      /multiple GGUF files[\s\S]*model\.Q4_K_M\.gguf[\s\S]*model\.Q8_0\.gguf/,
    );
  });

  it("reports an unknown file with the available GGUFs", async () => {
    await expect(resolveHfSource("owner/repo:Q6_K", fakeHfFetch())).rejects.toThrow(
      /no file matching 'Q6_K'[\s\S]*model\.Q4_K_M\.gguf/,
    );
  });

  it("reports an ambiguous quant match", async () => {
    const dup = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/models/owner/repo")) {
        return Response.json({ sha: DEFAULT_REF });
      }
      return Response.json([
        { type: "file", path: "a.Q4_K_M.gguf", lfs: { oid: SHA_A, size: 1 } },
        { type: "file", path: "b.Q4_K_M.gguf", lfs: { oid: SHA_B, size: 1 } },
      ]);
    }) as typeof fetch;
    await expect(resolveHfSource("owner/repo:Q4_K_M", dup)).rejects.toThrow(/ambiguous quant/);
  });

  it("requires an explicit --sha256 when the repo publishes no LFS oid", async () => {
    const noLfs = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/models/owner/repo")) {
        return Response.json({ sha: DEFAULT_REF });
      }
      return Response.json([{ type: "file", path: "small.gguf" }]);
    }) as typeof fetch;
    await expect(resolveHfSource("owner/repo", noLfs)).rejects.toThrow(
      /does not publish an LFS sha256/,
    );
  });

  it("rejects non-HuggingFace sources with a pointer to --sha256", async () => {
    await expect(
      resolveHfSource("https://example.com/model.gguf", fakeHfFetch()),
    ).rejects.toThrow(HfResolveError);
    await expect(
      resolveHfSource("https://example.com/model.gguf", fakeHfFetch()),
    ).rejects.toThrow(/pass --sha256 explicitly/);
  });

  it("surfaces a 404 as a repo-not-found error", async () => {
    await expect(resolveHfSource("owner/repo", fakeHfFetch({ status: 404 }))).rejects.toThrow(
      /repo not found/,
    );
  });

  it("surfaces a 404 on the tree as a repo-not-found error", async () => {
    const badRepo = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/models/owner/repo")) {
        return Response.json({ sha: DEFAULT_REF });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    await expect(resolveHfSource("owner/repo", badRepo)).rejects.toThrow(/repo not found/);
  });
});

describe("searchHfModels", () => {
  /**
   * Fake HF model-search endpoint. Records the query string it was called with
   * so tests can assert the search term and limit were passed through.
   */
  function fakeSearchFetch(
    results: Array<{ id: string; downloads?: number; likes?: number }>,
    seen: { url?: string },
  ): typeof fetch {
    return (async (input: string | URL | Request) => {
      seen.url = String(input);
      return Response.json(results);
    }) as typeof fetch;
  }

  it("returns id/downloads/likes for each result", async () => {
    const seen: { url?: string } = {};
    const r = await searchHfModels(
      "qwen3 coder",
      {
        doFetch: fakeSearchFetch(
          [
            { id: "Qwen/Qwen3-Coder-30B", downloads: 1000, likes: 50 },
            { id: "other/repo", downloads: 5 },
          ],
          seen,
        ),
      },
    );
    expect(r).toEqual([
      { id: "Qwen/Qwen3-Coder-30B", downloads: 1000, likes: 50 },
      { id: "other/repo", downloads: 5, likes: undefined },
    ]);
  });

  it("passes the search term and limit to the API", async () => {
    const seen: { url?: string } = {};
    await searchHfModels("llama", { limit: 7, doFetch: fakeSearchFetch([], seen) });
    expect(seen.url).toContain("search=llama");
    expect(seen.url).toContain("limit=7");
  });

  it("defaults the limit to 20 when omitted", async () => {
    const seen: { url?: string } = {};
    await searchHfModels("llama", { doFetch: fakeSearchFetch([], seen) });
    expect(seen.url).toContain("limit=20");
  });

  it("returns an empty list for no matches", async () => {
    const r = await searchHfModels("zzz-no-such-model", {
      doFetch: fakeSearchFetch([], {}),
    });
    expect(r).toEqual([]);
  });

  it("surfaces a non-OK response as an HfResolveError", async () => {
    const bad = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(searchHfModels("x", { doFetch: bad })).rejects.toThrow(HfResolveError);
  });
});
