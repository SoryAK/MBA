# Workflow: Add Interactive CLI Prompt

**Workflow Type:** `add-interactive-cli-prompt` — adding a new interactive prompt to the `mba` CLI

**Stack Context:** TypeScript, raw-mode stdin (`process.stdin.setRawMode`), Vitest

**Last Updated:** 2026-08-29

---

## Successful Sequence

1. **Add the prompt function to `packages/core/src/cli/interactive.ts`**
   - Follow the existing pattern: `askPortInteractive`, `pickModelInteractive`, `askYesNo`
   - Use `process.stdin.setRawMode(true)` + `process.stdin.resume()`
   - Handle escape sequences via `tokenizeKeys`
   - Return `Promise<T | null>` (null = cancelled)

2. **Write tests in `packages/core/src/cli/interactive.test.ts`**
   - Mock `process.stdin` with a fake stream
   - Test: default value, typed input, invalid input re-prompt, Esc cancel, Ctrl-C reject, backspace

3. **Wire the prompt into the command flow in `packages/core/src/cli/mba.ts`**
   - Add TTY detection: `process.stdin.isTTY`
   - If TTY and no args → interactive flow
   - If non-TTY and no args → error with usage hint

4. **Build and verify**
   - `npm run build -w @mba-ai/core`
   - `npx vitest run packages/core/src/cli/interactive.test.ts`
   - Smoke test: `mba servers boot` (should show picker)

---

## First-Attempt Failures

- **Type error TS2345:** `chunk[i]` returns `string | undefined` in strict mode.
  - **Fix:** Use `chunk.charAt(i)` instead of `chunk[i]`.

- **Arrow keys showing as literal text (`[C`):** `tokenizeKeys` wasn't consuming the `[` byte in escape sequences.
  - **Fix:** Consume `[` as part of the escape sequence:
    ```typescript
    while (j < chunk.length && (chunk.charCodeAt(j) < 0x20 || chunk.charAt(j) === "[")) {
      j++;
    }
    if (j < chunk.length) {
      j++; // include the final letter (e.g. 'C' in ESC [ C)
    }
    ```

- **`mba` command not showing interactive boot:** The `mba` command points to compiled `dist/`, not source.
  - **Fix:** Run `npm run build -w @mba-ai/core` after changes.

---

## Gotchas

- **Raw mode must be restored:** Always call `process.stdin.setRawMode(false)` in a `finally` block.
- **TTY detection is critical:** Interactive prompts only work when `process.stdin.isTTY` is true. Non-TTY (piped input) must fall back to error/usage.
- **Escape sequence parsing:** Terminal escape sequences are `ESC [ <modifier> <letter>`. The `[` byte must be consumed as part of the sequence, not treated as a literal character.
- **Build before testing:** The `mba` command uses `dist/` output. Always rebuild after source changes.

---

## Reference Implementation

See `packages/core/src/cli/interactive.ts` for the full implementation of:
- `tokenizeKeys` — escape sequence parser
- `askPortInteractive` — numeric input with validation
- `pickModelInteractive` — arrow-key navigation + type-to-filter
