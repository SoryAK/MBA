import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import {
  callLlamaSlot,
  listLlamaSlots,
  sanitizeSlotFilename,
  slotDirForEntry,
  SlotFilenameError,
  SlotOpError,
} from "./slot-control.js";

function slotFetch(opts: {
  status?: number;
  body?: unknown;
  hang?: boolean;
}): {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; url: string; body: string }>;
} {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ method, url, body });
    if (opts.hang) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify(opts.body ?? { id_slot: 0 }), {
      status: opts.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("sanitizeSlotFilename", () => {
  it("accepts a basename", () => {
    expect(sanitizeSlotFilename("pin.bin")).toBe("pin.bin");
    expect(sanitizeSlotFilename("keeper-1.bin")).toBe("keeper-1.bin");
  });

  it("rejects empty, paths, and traversal", () => {
    expect(() => sanitizeSlotFilename("")).toThrow(SlotFilenameError);
    expect(() => sanitizeSlotFilename("../escape.bin")).toThrow(SlotFilenameError);
    expect(() => sanitizeSlotFilename("a/b.bin")).toThrow(SlotFilenameError);
    expect(() => sanitizeSlotFilename("a\\b.bin")).toThrow(SlotFilenameError);
    expect(() => sanitizeSlotFilename(".hidden")).toThrow(SlotFilenameError);
  });
});

describe("slotDirForEntry", () => {
  it("uses G3 kv/<fork>/slots next to the weights", () => {
    const modelFile = "/store/qwen/qwen.gguf";
    expect(slotDirForEntry({ modelFile })).toBe(join(dirname(modelFile), "kv", "upstream", "slots"));
    expect(slotDirForEntry({ modelFile, fork: "llama.cpp" })).toBe(
      join(dirname(modelFile), "kv", "llama.cpp", "slots"),
    );
  });
});

describe("callLlamaSlot", () => {
  it("POSTs erase with an empty JSON body (avoids hang)", async () => {
    const { fetchImpl, calls } = slotFetch({ body: { n_erased: 12 } });
    const out = await callLlamaSlot(8080, { action: "erase" }, fetchImpl);
    expect(out.slotId).toBe(0);
    expect(out.filename).toBeUndefined();
    expect(out.upstream).toEqual({ n_erased: 12 });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:8080/slots/0?action=erase",
      body: "{}",
    });
  });

  it("POSTs save with a sanitized filename", async () => {
    const { fetchImpl, calls } = slotFetch({ body: { filename: "pin.bin" } });
    const out = await callLlamaSlot(8080, { action: "save", filename: "pin.bin", slotId: 0 }, fetchImpl);
    expect(out.filename).toBe("pin.bin");
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:8080/slots/0?action=save",
      body: JSON.stringify({ filename: "pin.bin" }),
    });
  });

  it("POSTs restore with filename", async () => {
    const { fetchImpl, calls } = slotFetch({});
    await callLlamaSlot(9123, { action: "restore", filename: "pin.bin", slotId: 1 }, fetchImpl);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9123/slots/1?action=restore");
  });

  it("rejects save without a filename before touching the server", async () => {
    const { fetchImpl, calls } = slotFetch({});
    await expect(callLlamaSlot(8080, { action: "save" }, fetchImpl)).rejects.toThrow(SlotFilenameError);
    expect(calls).toHaveLength(0);
  });

  it("wraps a non-2xx as SlotOpError", async () => {
    const { fetchImpl } = slotFetch({ status: 500, body: { error: "nope" } });
    await expect(callLlamaSlot(8080, { action: "erase" }, fetchImpl)).rejects.toThrow(SlotOpError);
  });

  it("wraps a refused connection as SlotOpError", async () => {
    const { fetchImpl } = slotFetch({ hang: true });
    await expect(callLlamaSlot(8080, { action: "erase" }, fetchImpl)).rejects.toThrow(/failed/);
  });
});

describe("listLlamaSlots", () => {
  it("GETs /slots", async () => {
    const { fetchImpl, calls } = slotFetch({ body: [{ id: 0 }] });
    const out = await listLlamaSlots(8080, fetchImpl);
    expect(out).toEqual([{ id: 0 }]);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "http://127.0.0.1:8080/slots",
    });
  });
});
