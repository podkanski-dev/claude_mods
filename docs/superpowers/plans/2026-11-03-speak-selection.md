# Speak Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code mod. When the user highlights part of the conversation and presses `ctrl+x s`, it rewrites the selection for listening with Haiku and speaks it through a local Kokoro voice.

**Architecture:** The hooks module (`speak_selection/hooks/`) reads `$.ui.selection()` and splits it into blocks (a table never cut). It rewrites the blocks one after another with `$.model.complete` and posts each rewritten block to a per-session Python voice server over a Unix socket (`$.http.fetch` with `socketPath`). The server keeps Kokoro loaded and queues the text. It splits the text into sentences and plays each through `pw-play` as soon as it's made. It exits after 10 minutes idle and the mod respawns it on the next press. A band button above the prompt carries the key binding. `/speak` does the same thing.

**Tech Stack:** Claude Code mod API (TypeScript/TSX hooks module, `claude plugin validate|test`), Python 3.12 via `uv run --with kokoro-onnx --with soundfile`, Kokoro model files from the `thewh1teagle/kokoro-onnx` release `model-files-v1.0`, PipeWire `pw-play`.

**Spec:** `docs/superpowers/specs/2026-11-03-speak-selection-design.md`

## Global Constraints

- Mod folder `speak_selection/`, plugin name `speak-selection`, version `0.1.0`, same layout as `self_critique/`. Add an entry to the root `.claude-plugin/marketplace.json`.
- Mod API types: grep `/tmp/claude-1000/bundled-skills/2.1.305/ebdeb5e04beffe4009324c64ca19e729/plugin-authoring/types/claude-code.d.ts` (or `speak_selection/.claude-plugin/types/claude-code/index.d.ts` once the mod has loaded). Long-form reference: `reference.md` beside it.
- Fullscreen layout only. `$.ui.selection()` returns `undefined` otherwise.
- Rewrite model: `haiku`. Language: English.
- Rewrite rules (verbatim intent from the spec): plain text reworded only as much as speech needs, never summarized. Tables described the way a person would explain one aloud (what is compared, then a natural walk-through), never cell by cell. Code blocks get one short spoken description, never read symbol by symbol. Lists, headings, links and alerts become natural speech.
- Default voice `af_heart`, default speed `1.0`, both `userConfig` options.
- Model files are cached in `~/.cache/speak-selection/` and are never committed.
- Voice server: one per Claude Code session, exits after 600 s idle.
- Pressing the key (or `/speak`) while speaking stops completely. There is no pause.
- Toast copy: `Highlight some text first (speak-selection needs fullscreen)`.
- `$.audio.play` plays nothing on Linux, so the server plays audio itself.
- `$.process.spawn`'s `input` can't be streamed, so all talk to the server goes over the socket.

## Review Focus

1. **A table selected from the screen arrives as box-drawing characters (`│ ─ ┼ ┌`), not markdown.** It must be one block, and the prompt must tell Haiku what those characters mean. Test in Task 2 (`splitBlocks` keeps a drawn table whole, blank rows inside included) and Task 3 (system prompt mentions box-drawing tables).
2. **Pressing again while a rewrite is still pending (no sound yet) must stop.** No later block may be posted to the server. Test in Task 5.
3. **A voice server that exited from idle (or crashed) must not break the next press.** `ensureVoice` sees the dead socket and respawns. Test in Task 4.
4. **The first run downloads about 340 MB.** The user must see why nothing plays yet, and the press must not time out. Toast `Downloading the voice model (first run, about 340 MB)…` while the server reports `loading`. Test in Task 4 (status `loading` → toast shown once).
5. **A rewrite that fails (no network, refused model) must not fall back to reading raw box-drawing text.** Toast `Couldn't rewrite the selection: <reason>` and stop. Test in Task 5.

---

### Task 1: Scaffold the mod and settle the key binding

**Files:**
- Create: `speak_selection/.claude-plugin/plugin.json`, `speak_selection/hooks/hooks.json`, `speak_selection/hooks/register.tsx` (stub), `speak_selection/types/index.d.ts`, `speak_selection/tsconfig.json`, `speak_selection/.claude-plugin/types/.gitignore`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Produces: `KEY_ACTION: string` exported from `speak_selection/hooks/register.tsx`, the engine keybinding action the band button names. State contract `PluginState['speak-selection'] = { isSpeaking: boolean }`. Options `{ voice: string, speed: number }`.

- [ ] **Step 1: Find the engine keybinding action.** Load the `keybindings-help` skill and list the engine's keybinding actions. Pick one that (a) can be bound to `ctrl+x s` in context `Global` or `Chat`, and (b) has no engine handler mounted while the prompt is idle (see `Button.action`'s doc in the types). If none qualifies, use the band button's `hotkey: "s"` (pressed after `ctrl+x tab`) plus `/speak`, and record that in the final report to the user. Write the choice and the `~/.claude/keybindings.json` snippet into a comment at the top of `register.tsx`.
- [ ] **Step 2: Write the manifest.** Write `plugin.json` with `name`, `version`, `description` ("Highlight part of the conversation and press ctrl+x s to hear it read aloud"), `"types": "./types/index.d.ts"`, and `userConfig` holding `voice` (string, default `af_heart`, `options` set to Kokoro v1.0's English voices: `af_heart`, `af_bella`, `af_nicole`, `af_sarah`, `am_michael`, `am_adam`, `am_fenrir`, `bf_emma`, `bm_george`) and `speed` (number, default `1.0`). Copy `hooks.json`, `tsconfig.json` and `.claude-plugin/types/.gitignore` from `self_critique/`. Declare `isSpeaking` in `types/index.d.ts` the way `self_critique/types/index.d.ts` does.
- [ ] **Step 3: Write the stub register.** It exports `register` and `KEY_ACTION` and does nothing else yet.
- [ ] **Step 4: Validate.** Run `claude plugin validate speak_selection`. Expected: no errors.
- [ ] **Step 5: Commit** with message `speak-selection: scaffold mod`.

### Task 2: Split a selection into blocks

**Files:**
- Create: `speak_selection/hooks/blocks.ts`
- Test: `speak_selection/tests/blocks.test.ts`

**Interfaces:**
- Produces: `splitBlocks(text: string, maxChars = 12000): { blocks: string[]; isTruncated: boolean }`. Blocks are separated by blank lines. Consecutive lines drawn with box-drawing characters (`U+2500–U+257F`) stay in one block, even across blank lines inside the table. Text past `maxChars` is dropped at a block boundary, and `isTruncated` reports that.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'claude-code/testing'
import { splitBlocks } from '../hooks/blocks'

const TABLE = '┌──────┬─────┐\n│ Name │ Fit │\n├──────┼─────┤\n│ A    │ yes │\n\n│ B    │ no  │\n└──────┴─────┘'

test('paragraphs split on blank lines', () => {
  expect(splitBlocks('One.\n\nTwo.\nStill two.').blocks).toEqual(['One.', 'Two.\nStill two.'])
})
test('a drawn table stays one block, blank rows included', () => {
  expect(splitBlocks(`Intro.\n\n${TABLE}\n\nAfter.`).blocks).toEqual(['Intro.', TABLE, 'After.'])
})
test('long input is cut at a block boundary', () => {
  const r = splitBlocks('a'.repeat(10) + '\n\n' + 'b'.repeat(10), 15)
  expect(r).toEqual({ blocks: ['a'.repeat(10)], isTruncated: true })
})
test('empty or whitespace-only input yields no blocks', () => {
  expect(splitBlocks('  \n\n ').blocks).toEqual([])
})
```

- [ ] **Step 2: Run them and see them fail.** Run `claude plugin test speak_selection`. Expected: FAIL, `splitBlocks` not found.
- [ ] **Step 3: Implement `splitBlocks` in `blocks.ts`.**
- [ ] **Step 4: Run them and see them pass.** Run `claude plugin test speak_selection`. Expected: PASS.
- [ ] **Step 5: Commit** with message `speak-selection: split selection into blocks`.

### Task 3: Rewrite a block for listening

**Files:**
- Create: `speak_selection/hooks/rewrite.ts`
- Test: `speak_selection/tests/rewrite.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `REWRITE_SYSTEM: string`. `rewriteBlock($: EngineInterface, block: string, isFirst: boolean): Promise<{ text: string } | { error: string }>` calls `$.model.complete({ model: 'haiku', system: REWRITE_SYSTEM, prompt: block, effort: 'low' })`. On `isAnswered: false` it returns `{ error: reason }`. `isFirst` tells the prompt whether this is the opening block (no "and next…" connective).

- [ ] **Step 1: Write the failing tests.** `REWRITE_SYSTEM` mentions each rule from Global Constraints. Assert it contains `never summar`, `box-drawing`, `table`, `code`, `English`. `rewriteBlock` with a `model.complete` hook answering `{ isAnswered: true, text: 'Spoken.' }` returns `{ text: 'Spoken.' }`, and the hook saw `model: 'haiku'` and the block as the prompt. With a hook answering `{ isAnswered: false, reason: 'offline' }` it returns `{ error: 'offline' }`. Mock the way `self_critique/tests/critique.test.tsx` mocks `model.fork`.
- [ ] **Step 2: Run them and see them fail.** Run `claude plugin test speak_selection`. Expected: FAIL.
- [ ] **Step 3: Implement `REWRITE_SYSTEM` and `rewriteBlock`.** The prompt says: output only the words to speak, no markdown, no preamble. The input is terminal text, so tables are drawn with box-drawing characters.
- [ ] **Step 4: Run them and see them pass.** Run `claude plugin test speak_selection`. Expected: PASS.
- [ ] **Step 5: Commit** with message `speak-selection: rewrite blocks for speech`.

### Task 4: Local Kokoro voice server and its client

**Files:**
- Create: `speak_selection/voice/server.py`, `speak_selection/hooks/voice.ts`
- Test: `speak_selection/tests/voice.test.ts`

**Interfaces:**
- Server, started as `uv run -q --no-project --with kokoro-onnx --with soundfile python -I <root>/voice/server.py --socket <path> --cache ~/.cache/speak-selection --idle 600`. It serves HTTP on the Unix socket:
  - `GET /status` returns `{"state": "loading" | "idle" | "speaking"}`. The state is `loading` while it downloads the model files (if missing) and loads Kokoro.
  - `POST /say` with body `{"text": str, "voice": str, "speed": float}` returns 202. The text is appended to the queue. A worker thread splits it into sentences, synthesizes each with `Kokoro.create(..., lang="en-us")`, and pipes the WAV to `pw-play -` (fall back to `paplay`), so playback overlaps with making the next sentence.
  - `POST /stop` returns 200. It clears the queue and kills the current player process at once.
  - It exits after `--idle` seconds with no request while idle, and removes its socket file.
- Client in `voice.ts`:
  - `ensureVoice($: EngineInterface, socket: string, signal: AbortSignal): Promise<void>` runs `GET /status`. If that fails, it starts the server with `$.process.spawn` in a detached loop (as in the "child for the session's life" example under `$.process.spawn`) and polls `/status` every 500 ms. While the state is `loading` it shows the first-run toast once. It resolves at `idle` or `speaking` and throws after 300 s.
  - `say($, socket, text, voice, speed): Promise<void>`
  - `stopVoice($, socket): Promise<void>`
  - `isPlaying($, socket): Promise<boolean>`
  - `socketPath($): Promise<string>` returns `${XDG_RUNTIME_DIR ?? '/tmp'}/speak-selection-<random id made once per register>.sock`.

- [ ] **Step 1: Write the failing client tests.** Mock `http.fetch` and `process.spawn` with hooks. (a) When `/status` answers `idle`, `ensureVoice` spawns nothing. (b) When the first `/status` rejects, it spawns once with an argv that ends `--idle`, `600`, then resolves once `/status` answers `idle` (advance a mocked clock). (c) When `/status` answers `loading` twice and then `idle`, exactly one toast with the first-run copy appears. (d) `say` POSTs `/say` with the JSON body over `socketPath`.
- [ ] **Step 2: Run them and see them fail.** Run `claude plugin test speak_selection`. Expected: FAIL.
- [ ] **Step 3: Implement `voice.ts`.**
- [ ] **Step 4: Implement `server.py`.** Use stdlib only besides `kokoro_onnx` and `soundfile`: `http.server` on a `socketserver.UnixStreamServer` subclass, a worker thread, and `subprocess` for the player. Download the two model files from the release URLs (`https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx` and `.../voices-v1.0.bin`) into the cache folder when missing. Download to a `.part` file and rename it when done, so an interrupted download isn't treated as finished.
- [ ] **Step 5: Run the tests and see them pass.** Run `claude plugin test speak_selection`. Expected: PASS.
- [ ] **Step 6: Check the server by hand.** Start it with a socket under the scratchpad, then send `curl --unix-socket <sock> -d '{"text":"One sentence. Two sentences.","voice":"af_heart","speed":1}' http://x/say`. Expected: speech plays. A `POST /stop` sent mid-sentence silences it within half a second.
- [ ] **Step 7: Commit** with message `speak-selection: local Kokoro voice server`.

### Task 5: Press to speak, press to stop

**Files:**
- Modify: `speak_selection/hooks/register.tsx`
- Test: `speak_selection/tests/speak.test.tsx`

**Interfaces:**
- Consumes: `splitBlocks` (Task 2), `rewriteBlock` (Task 3), `ensureVoice`, `say`, `stopVoice`, `isPlaying`, `socketPath` (Task 4), `KEY_ACTION` and the `isSpeaking` atom (Task 1).
- Produces: `toggleSpeak($: EngineInterface, options: PluginOptions): Promise<void>`, the one entry point for the band button and `/speak`.

`toggleSpeak` behaves like this:
- If `isSpeaking` is set, bump the run token, `stopVoice`, clear `isSpeaking`, and return.
- Otherwise read `$.ui.selection()`. If the selection is missing or blank, show the toast `Highlight some text first (speak-selection needs fullscreen)` and return.
- Set `isSpeaking`, then `ensureVoice`. If `isTruncated`, show the toast `Reading the first part only`.
- For each block in order: `rewriteBlock`, then return if the run token changed. On error, show `Couldn't rewrite the selection: <reason>`, `stopVoice`, clear `isSpeaking` and return. Otherwise `say`.
- After the last block, poll `isPlaying` every 500 ms until false, then clear `isSpeaking` (only if the run token is unchanged).

The band (`ui.render` on `AbovePrompt`, skipping when `e.props.hasSurvey`) draws one plain `Button` with `key="speak"`, `action={KEY_ACTION}`, `label` `🔊` when idle and `■ speaking…` while `isSpeaking`, and `onPress` set to `toggleSpeak`. `session.start` registers `/speak` ("Read the highlighted text aloud"), answered by a `command.run` hook that calls `toggleSpeak` and returns `{ text: '' }`.

- [ ] **Step 1: Write the failing tests.** Loop over `['terminal', 'desktop'] as const` and mount `AbovePrompt`. (a) With `ui.selection` answering `undefined`, pressing `speak` shows the highlight toast and no `model.complete` call is made. (b) With a selection of two paragraphs, pressing posts two `/say` bodies in order. (c) While the first `model.complete` is still pending, pressing `speak` again means no `/say` is ever posted and `/stop` is posted. (d) When `model.complete` answers `isAnswered: false, reason: 'offline'`, the toast is `Couldn't rewrite the selection: offline` and no `/say` is posted. (e) Running `/speak` posts `/say` the same as the button.
- [ ] **Step 2: Run them and see them fail.** Run `claude plugin test speak_selection`. Expected: FAIL.
- [ ] **Step 3: Implement `toggleSpeak`, the band and the command in `register.tsx`.**
- [ ] **Step 4: Run them and see them pass.** Run `claude plugin test speak_selection`. Expected: all tests PASS.
- [ ] **Step 5: Type-check and validate.** Run `tsc -p speak_selection` and `claude plugin validate speak_selection`. Expected: no errors.
- [ ] **Step 6: Commit** with message `speak-selection: press to speak, press to stop`.

### Task 6: Try it for real and hand over

**Files:**
- Modify: `~/.claude/keybindings.json` (with the user's OK: it's their config), using the snippet from Task 1.

- [ ] **Step 1: Load the mod.** Load it in this session (`plugin-authoring` hot reload, or `claude --plugin-dir speak_selection`).
- [ ] **Step 2: Test it on real text.** Ask the user to highlight a reply holding a table, then press `ctrl+x s`. Expected: sound within about 2–3 s (after the first-run download), and the table is described, not read cell by cell. A second press stops it.
- [ ] **Step 3: Report.** Tell the user the key binding that was added, the fallback if Task 1 found no usable action, and how to change the voice in `/config`.
