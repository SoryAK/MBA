import { describe, it, expect } from "vitest";
import { SERVICE_CONTRACT_VERSION } from "./contracts.js";

describe("service contract", () => {
  it("pins the HTTP JSON version CLI and MCP lock to", () => {
    expect(SERVICE_CONTRACT_VERSION).toBe(2);
  });
});
