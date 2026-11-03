# Speak Selection — design

A Claude Code mod that reads aloud whatever part of the conversation you highlight with the mouse. Before speaking, it rewrites the text so it sounds natural when heard.

## Why

Sometimes the user would rather hear Claude's replies than read them. Raw markdown read aloud is unpleasant: tables come out as a stream of cells, code as symbols. The mod turns the selection into what a person would say if they were describing it to you, then speaks it with a good-sounding local voice.

## How it behaves

1. The user highlights any stretch of the conversation (plain text, tables, lists, code, in any mix) with the mouse.
2. The user presses a key combo. `/speak` does the same thing as a fallback.
3. The mod reads the selection and sends it to a fast Claude model with instructions to rewrite it for listening:
   - **Plain text:** reworded only as much as speech needs (drop markdown symbols, expand things like "e.g."). Never summarized.
   - **Tables:** described the way a person would explain one aloud. Say what is being compared, then go through it naturally ("There are four options. Kokoro sounds very good and runs on your processor alone…"), not cell by cell.
   - **Code blocks:** one short spoken description ("a short Python function that retries the request"), never read symbol by symbol.
   - **Other markdown** (lists, headings, links, alerts): turned into natural speech.
   - **Language:** English.
4. The rewritten text is spoken through the speakers by Kokoro, running locally.
5. Pressing the key again (or running `/speak` again) while it is talking stops it.

## Goals

- Highlight, press a key, hear it, with nothing else to do.
- Speech sounds like a person explaining, especially for tables.
- Fully local voice: offline, free, and no text sent anywhere except the rewrite call to Claude.
- Speech starts quickly: it speaks the first sentence while the rest is still being made.

## Non-goals

- Automatically reading every reply aloud. Only what the user highlights gets spoken.
- Cloud voices (ElevenLabs etc.). Keep the voice step separate enough that one could be added later, but don't build it.
- Languages other than English.
- Working outside Claude Code's fullscreen layout (see Constraints).
- Speaking text from outside Claude Code.

## Anti-goals (would count as failure even if it technically works)

- Reading tables cell by cell, or reading out markdown or code symbols.
- Summarizing or dropping content from plain text.
- A long silent wait after the key press before any sound.
- Speech that can't be stopped.

## Decided by the user

- **Voice engine: Kokoro**, local. The user listened to samples and called it "perfect". Spike: `kokoro-onnx` package with model files `kokoro-v1.0.onnx` (310 MB) and `voices-v1.0.bin` (27 MB) from the `thewh1teagle/kokoro-onnx` GitHub release `model-files-v1.0`, run through `uv`.
- **Trigger: a key combo** (the user asked for a key; the exact chord is listed under "My calls" until they pick one).
- **Behaviour of the rewrite** for plain text, tables, code, and the language: as listed under "How it behaves".

## Constraints and facts found during exploration

- **The selection** comes from `$.ui.selection()`, which returns the last mouse selection in the transcript. It returns `undefined` when fullscreen is off, under `-p`, or when nothing is selected. Fullscreen is therefore required. Its `text` is the text as it appears on screen, not the markdown source, so tables arrive drawn with box characters (`│ ─ ┼`), and the rewrite prompt must expect that.
- **Keys:** a mod cannot register a key of its own. The way in is a `Button` (in the band above the prompt, or a pane) whose `action` names an **existing engine keybinding action**. The user's chord for that action presses the button from the prompt, as long as no engine handler for that action is mounted. A `hotkey` letter also works, but only after the band has focus (ctrl+x tab).
- **Audio:** `$.audio.play` plays nothing on Linux. The local voice process has to play the audio itself (for example by piping to `paplay` / `pw-play`, both installed).
- **Rewrite call:** `$.model.complete` with a small model (Haiku). It does not stream: the reply comes back whole. The mod gets no credential to call the API itself, so streaming has no workaround.
- **Processes:** `$.process.spawn` runs and streams a child process, but its `input` is one string written to stdin and then closed, so the mod can't keep sending lines to a running child. A long-lived process has to be reached over a local socket or HTTP (`$.http.fetch` accepts a `socketPath`). A spawned child is killed when the module unloads.
- **Machine:** Linux on Wayland, 16 cores, 32 GB RAM (often only about 6 GB free), 4 GB NVIDIA T550, `uv` and Python 3.12 installed. In the spike, Kokoro on CPU ran at about real time (25 s of audio in 22 s), which is why speaking sentence by sentence matters.
- **Repo conventions:** each mod is a folder in this repo (`assumption_tracker/`, `self_critique/`) with `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `tests/`, `types/index.d.ts` where it keeps state, and an entry in the root `.claude-plugin/marketplace.json`. Follow the same layout as `speak_selection/`.

## My calls (not discussed with the user; check these)

- **Key combo: `ctrl+x s`** ("s" for speak; the user asked me to pick). It's a chord on Claude Code's `ctrl+x` prefix, which mods already use (`ctrl+x tab`). The user has no `keybindings.json` yet, and their terminal multiplexer (herdr) binds only its own prefix keys, so nothing clashes. If no engine action can carry this chord, choose the nearest free chord and tell the user.
- **Voice settings:** default voice `af_heart`, changeable to any Kokoro voice (for example `am_michael`) through a `userConfig` option. A speed option too, default 1.0.
- **Kokoro stays loaded** in a long-lived local process, so a key press doesn't pay the model-load cost each time. The Python script ships inside the mod folder and runs via `uv`. Model files are downloaded on first use into a cache folder outside the repo (for example `~/.cache/speak-selection/`), not committed.
- **Visible control:** a small speaker button in the band above the prompt. It carries the key binding and shows "speaking…" while it plays. If the band feels like clutter, it may show only while speaking, as long as the key still works.
- **Feedback when nothing can be read:** a toast. "Highlight some text first" when the selection is empty. "Turn on fullscreen to use speak-selection" when fullscreen is off, if the mod can tell the two cases apart.
- **Stop** means stop entirely, not pause.
- **Getting to the first sound fast:** split the selection at block boundaries (paragraph, list, table, code block), never inside a block, so each table is still described as a whole. Rewrite the first block on its own and start speaking it while the remaining blocks are rewritten in order. Target: first sound within about 2–3 seconds for a typical selection.
- **One voice process per Claude Code session**, started on the first press, reached over a local socket, and shut down after 10 minutes idle so it doesn't hold memory (often only about 6 GB free). Two sessions talking at once is rare because speech is only ever user-triggered, so no cross-session lock.

## Left to the builder

- Which engine keybinding action to attach the button to, and what the user adds to `~/.claude/keybindings.json` for the chord they chose (check the chord reaches Claude Code through their terminal on Wayland, and doesn't clash with existing bindings). It must be an action that's safe to repurpose (no engine handler mounted while the button shows). If no action is usable, fall back to the band hotkey plus `/speak` and tell the user. **Check this first: it's the biggest risk to the "press a key" experience.**
- The protocol over the local socket, and how "stop" kills playback promptly.
- How the rewrite is split into sentences for streaming.
- The rewrite prompt wording, within the rules above.
- Handling very long selections (split into chunks, or cap and say so).
- Tests: the rewrite/split logic and the toggle-to-stop behaviour, using `claude plugin test`. The voice process itself can be checked by hand.
