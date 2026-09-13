import { describe, expect, it } from "vitest";
import {
  extraEnvironmentLines,
  renderLocalDropIn,
  renderMbaUserUnit,
  systemdQuote,
  UNIT_MARKER,
} from "./systemd-user.js";

describe("systemdQuote", () => {
  it("leaves simple paths unquoted", () => {
    expect(systemdQuote("/usr/bin/node")).toBe("/usr/bin/node");
  });

  it("quotes paths with spaces", () => {
    expect(systemdQuote("/home/me/My Apps/node")).toBe('"/home/me/My Apps/node"');
  });
});

describe("extraEnvironmentLines", () => {
  it("keeps machine env and drops PATH", () => {
    const unit = [
      "Environment=PATH=/nvm/bin:/usr/bin",
      "Environment=MBA_LLAMA_SERVER_BIN=/opt/llama-server",
      "Environment=HSA_OVERRIDE_GFX_VERSION=11.5.0",
    ].join("\n");
    expect(extraEnvironmentLines(unit)).toEqual([
      "Environment=MBA_LLAMA_SERVER_BIN=/opt/llama-server",
      "Environment=HSA_OVERRIDE_GFX_VERSION=11.5.0",
    ]);
  });
});

describe("renderMbaUserUnit", () => {
  it("is a user unit with on-failure restart and a generated marker", () => {
    const text = renderMbaUserUnit({
      execStart: "/usr/bin/node /opt/mba/dist/service/main.js",
      pathEnv: "/usr/bin:/bin",
    });
    expect(text.startsWith(UNIT_MARKER)).toBe(true);
    expect(text).toContain("WantedBy=default.target");
    expect(text).toContain("Restart=on-failure");
    expect(text).toContain("ExecStart=/usr/bin/node /opt/mba/dist/service/main.js");
    expect(text).not.toContain("Restart=always");
  });
});

describe("renderLocalDropIn", () => {
  it("is a [Service] drop-in the generator will not rewrite", () => {
    const text = renderLocalDropIn(["Environment=MBA_LLAMA_SERVER_BIN=/opt/llama-server"]);
    expect(text).toContain("[Service]");
    expect(text).toContain("does not overwrite");
    expect(text).toContain("MBA_LLAMA_SERVER_BIN=/opt/llama-server");
  });
});
