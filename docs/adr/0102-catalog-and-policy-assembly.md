# ADR 0102: Catalog vs policy — playbooks and the small assembly file

- **Status:** Proposed
- **Date:** 2026-09-05
- **Deciders:** project maintainer + agent
- **Tags:** architecture, mba, bcb, tcb, ampi, policy, rule-class, config
- **Relates to:** ADR-0084 (adapter spec), ADR-0087 (rule classes, in-code), ADR-0088 / ADR-0101 (AMPI recipes), ADR-0092 (daemon as orchestrator)

## Context and Problem Statement

MBA's job is per-model behavioral dossiers on a local machine: YAML adapters
hold identity, GGUF facts, and *pointers* to other files. They do **not**
inline TCB/BCB rule bodies. Guardrails live in config the user can define.
The daemon is the orchestrator; CLI and MCP are how a project talks to it.
A project does not embed the engine — it **declares policy** the daemon runs.

We already have the pieces of a "don't write everything from scratch" system:

- Atomic rules (`repeatRun`, `directDuplication`, `readClamp`, `eofOverflow`,
  `binaryBlock`) in `packages/core/src/bcb/rules/`.
- Named **rule classes** (`readSafety`, `readLoop`, `loopBreaker`) in
  `packages/core/src/bcb/rule-classes.ts` so one JSONL line can attach a group.
- AMPI recipes (e.g. `sweep-duplicates`) specified as a later *do*, not a
  detector (ADR-0088 / ADR-0101). Policy names recipes only, never CM cuts
  (ADR-0105).

What we do **not** have is a clean authoring model:

- Global out-of-the-box security is seeded as an **expanded**
  `tool-circuit-breakers.json` (inline `read_file` rules from
  `default-config.ts`). It does not use classes.
- Per-model `bcb.jsonl` / `tcb.jsonl` in the adapter tree are empty scaffolds.
- The config store (`config-store.ts`) is **global, not per-project**. Project
  overrides were deferred as a v2 merge layer.
- `POST /set_rules` replaces that expanded JSON. Humans are pushed to edit
  the huge form, so a "small policy file" has nowhere honest to live.

The user intent: **global state defines the playbooks** (rules, classes, AMPI
recipes). A special project writes a **small policy file that only assembles
those names** — watch these tools, use these classes, fire this recipe —
instead of copying every detector. Users can still **add** a playbook and
**reuse** it from other projects.

## Decision Drivers

- Out-of-the-box global security without requiring a project file.
- Project policy stays short: names and sparse overrides, not a second engine.
- Users can extend the playbook binder and reuse the new name elsewhere.
- YAML adapters stay dossiers (facts + bindings), not rule books.
- The daemon remains the only expander/runner (ADR-0092 / ADR-0101).
- AMPI recipe *bodies* stay catalog (programs with termination rules), not
  inlined into every policy file.
- Do not grow a fifth assembly axis; environment folders already overlay
  adapter bindings (ADR-0091).

## Considered Options

- **Option A — Keep expanded global JSON as the authoring format.** Classes
  remain a JSONL convenience only. Project policy, if any, would dump a full
  `ToolCircuitBreakerConfig`.
- **Option B — Catalog vs assembly.** Playbooks (rules, classes, recipes) are
  the catalog. Global default policy and per-project policy are assembly
  files that *reference* catalog names. Expansion happens at resolve time.
- **Option C — Project embeds BCB via npm.** Each repo imports the engine and
  runs it in-process. Rejected earlier: the daemon is the orchestrator;
  npm is CLI + MCP as the control plane.

## Decision Outcome

**Chosen option: Option B.**

### 1. Two kinds of file

**Catalog ("what exists") — the playbook binder.** Named, reusable, not
rewritten per project:

| Kind | Examples | Lives today / later |
| --- | --- | --- |
| Atomic rules | `repeatRun`, `directDuplication`, … | Code |
| Rule classes | `readSafety`, `readLoop`, `loopBreaker` | Code + optional user `rule-classes.json` |
| AMPI recipes | `sweep-duplicates`, … | Built-in registry (`packages/core/src/ampi/`) |

A class or recipe does not say *where* it runs. It is a playbook.

**Assembly ("what is on") — the sticky note:**

| Kind | Job |
| --- | --- |
| Global policy | Default security if the user never writes a project file |
| Project policy | This repo's work order: which playbooks, on which tools, which recipe |
| Model `tcb.jsonl` / `bcb.jsonl` | Optional *model* quirks only (this GGUF false-trips at 4), not the main UX |

If a project file has to redefine `repeatRun`, the catalog failed. If global
JSON inlines every member (current seed), the catalog is unused as the
out-of-box layer.

### 2. Project policy is assembly only

The file answers four questions:

1. **Watch** — which tools (or a wildcard / tool group)
2. **With** — which class names
3. **When it still fails, do** — optional AMPI recipe name at a ladder tier
4. **Tweaks** — sparse overrides (e.g. threshold), never a copy of the class

Illustrative shape (schema not frozen):

```yaml
# .MBA/policy.yaml
watch:
  read_file: [readSafety, readLoop]
  "*": [loopBreaker]

on:
  loopBreaker: { at: kill, recipe: sweep-duplicates }
  readLoop:    { at: kill, recipe: sweep-duplicates }

overrides:
  readLoop.repeatRun.threshold: 2
```

`readLoop` exists so `read_file` does not also take `directDuplication`
(double-guard, wrong message). Generic tools use `loopBreaker`.

### 3. Global out of the box uses the same shape

First-boot global policy should **attach classes**, not expand members into
`tools.read_file.repeatRun…`. Intended default:

- `read_file` → `readSafety` + `readLoop`
- other tools → `loopBreaker`
- `on kill → sweep-duplicates` when recipes exist (AMPI recipe name, not a CGC cut)

The expanded `ToolCircuitBreakerConfig` is a **resolve-time view** (debug /
engine input), not the source of truth. `POST /set_rules` should eventually
mutate assembly + catalog, not only replace expanded JSON.

### 4. Users can add playbooks and reuse them

The binder is not locked. A user may:

- Add a class (bundle of existing rules) or a recipe
- Save it once — machine-global catalog, or a repo-local catalog entry
- Reuse it — any policy file names it (`watch: { some_tool: [myApiLoop] }`)

A **new kind of detector** (not just a new bundle) still belongs in MBA core
or a shared catalog, not copied into five policy files.

AMPI recipe **bodies** stay in the catalog (ADR-0088: closed `act` set,
termination). Policy only **names** `sweep-duplicates`. A project may add
`./ampi/my-prune.yaml` and reference `my-prune`; that is still a catalog
entry, not inlined into `watch`.

### 5. Merge order

```text
built-in catalog
  ← user catalog (extra classes / recipes)
  ← global assembly          # out-of-box
  ← model jsonl              # rare GGUF quirks
  ← project policy           # this repo wins on watch / do / overrides
```

- **Project wins** for what is watched and which recipe fires.
- **Model jsonl** is only for weight-specific numbers that do not belong in a
  repo.
- If both set the same override, **project wins** so CI can pin behavior.

Four assembly/catalog layers is the maximum. Environment folders (ADR-0091)
overlay adapter bindings, not a second policy language.

### 6. Adapter YAML stays an index

`bindings.tcb` / `bindings.bcb` / `bindings.ruleClasses` point at files. Rule
*bodies* live in those files or in the catalog+policy model above. YAML holds
identity, profile, client, and pointers.

### 7. Control plane

The daemon expands names and runs BCB/TCB/AMPI. A project **imports npm** only
as CLI + MCP: declare or push policy to the daemon, do not embed the engine.

## Consequences

### Positive

- Out-of-box security is one default sticky note over shipped playbooks.
- Project files stay small and commitable.
- Extending MBA is "add a named playbook once," not "fork every policy."
- Matches the security-company picture: HQ owns playbooks; a site files a
  work order.
- Aligns AMPI with ADR-0088/0101: the ladder names a recipe; the recipe is
  catalog.

### Negative / migration

- Current `~/.config/mba/bcb/tool-circuit-breakers.json` and
  `default-config.ts` are the old expanded form. First-boot seed and
  `set_rules` must change or stay as a compatibility dump of the resolve view.
- Empty per-model jsonl stays valid (no model quirks).
- Project `on.recipe` assembly is still a stub at resolve time; the built-in
  recipe `sweep-duplicates` already runs when a ladder tier sets `action: ampi`.
- Two JSONL files (`bcb.jsonl` vs `tcb.jsonl`) still fold into one
  `ToolCircuitBreakerConfig` today; TCB remains the tool-shaped chapter of
  BCB, not a second engine.

## Explicit Deferrals

- Exact on-disk schema and filename for project policy (`.MBA/policy.yaml`
  vs JSON).
- Whether global assembly lives beside `rule-classes.json` as YAML or JSON.
- Tool groups / wildcards (`"*"`) semantics vs an explicit allowlist.
- MCP/CLI verbs to publish a project policy without `set_rules` clobbering
  the machine with expanded JSON.
- Recipe file format (still open in ADR-0088).
- Machine/host overlay (VRAM clamp) as a separate axis — discussed, not
  designed here.

## Links / References

- `packages/core/src/bcb/rule-classes.ts` — built-in classes
- `packages/core/src/bcb/default-config.ts` — current expanded global seed
- `packages/core/src/service/config-store.ts` — global store; project layer
  called out as v2
- `.Manual/model-behavioral-adapters.md` — JSONL `rule_class` authoring
- [ADR-0101](./0101-ampi-daemon-as-proxy-and-intervention-subsystem.md)
- [ADR-0088](./0088-ampi-automated-multi-process-intervention.md)
