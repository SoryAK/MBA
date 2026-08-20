import { describe, expect, it } from "vitest";
import {
  BUILTIN_RULE_CLASSES,
  expandRuleClass,
  isRuleClassRegistry,
  mergeRuleClassRegistries,
} from "./rule-classes.js";
import type { RuleClassDef, RuleClassRegistry } from "./rule-classes.js";

describe("expandRuleClass", () => {
  const def: RuleClassDef = {
    members: { repeatRun: { threshold: 4 }, directDuplication: { threshold: 3 } },
    escalation: { tiers: [{ tier: "mask", afterIgnoredTrips: 0 }], counterMode: "monotonic" },
  };

  it("expands each member into an enabled rule body carrying class params + escalation", () => {
    const out = expandRuleClass(def, true);
    expect(out.repeatRun).toEqual({
      enabled: true,
      threshold: 4,
      escalation: { tiers: [{ tier: "mask", afterIgnoredTrips: 0 }], counterMode: "monotonic" },
    });
    expect(out.directDuplication).toMatchObject({ enabled: true, threshold: 3 });
  });

  it("disables every member when the binding is disabled", () => {
    const out = expandRuleClass(def, false);
    expect(out.repeatRun).toEqual({ enabled: false });
    expect(out.directDuplication).toEqual({ enabled: false });
  });

  it("applies per-member overrides on top of class defaults", () => {
    const out = expandRuleClass(def, true, { repeatRun: { threshold: 9 } });
    expect(out.repeatRun).toMatchObject({ enabled: true, threshold: 9 });
  });
});

describe("mergeRuleClassRegistries", () => {
  it("lets a later registry override an earlier one and records the collision", () => {
    const base: RuleClassRegistry = { a: { members: { readClamp: {} } } };
    const user: RuleClassRegistry = { a: { members: { repeatRun: { threshold: 2 } } }, b: { members: {} } };
    const { registry, collisions } = mergeRuleClassRegistries(base, user);
    expect(registry.a).toBe(user.a);
    expect(registry.b).toBe(user.b);
    expect(collisions).toContain("a");
  });
});

describe("BUILTIN_RULE_CLASSES", () => {
  it("ships readSafety and loopBreaker", () => {
    expect(Object.keys(BUILTIN_RULE_CLASSES)).toEqual(expect.arrayContaining(["readSafety", "loopBreaker", "readLoop"]));
    expect(BUILTIN_RULE_CLASSES.readSafety!.members.binaryBlock).toBeDefined();
    expect(BUILTIN_RULE_CLASSES.loopBreaker!.escalation).toBeDefined();
  });

  it("readLoop carries repeatRun only (no directDuplication) with a mask ladder", () => {
    expect(Object.keys(BUILTIN_RULE_CLASSES.readLoop!.members)).toEqual(["repeatRun"]);
    expect(BUILTIN_RULE_CLASSES.readLoop!.escalation?.tiers.some((t) => t.tier === "mask")).toBe(true);
  });

  it("readSafety expands to a valid rule set", () => {
    const out = expandRuleClass(BUILTIN_RULE_CLASSES.readSafety!, true);
    expect(out.readClamp).toMatchObject({ enabled: true });
    expect(Array.isArray((out.binaryBlock as { extensions?: unknown }).extensions)).toBe(true);
  });
});

describe("isRuleClassRegistry", () => {
  it("accepts a well-formed registry", () => {
    expect(isRuleClassRegistry({ x: { members: { readClamp: {} } } })).toBe(true);
  });
  it("rejects malformed shapes", () => {
    expect(isRuleClassRegistry({ x: { members: "no" } })).toBe(false);
    expect(isRuleClassRegistry({ x: {} })).toBe(false);
    expect(isRuleClassRegistry(null)).toBe(false);
  });
});
