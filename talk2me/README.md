# talk2me

Have Claude Code read its replies to you. Highlight any part of the conversation, press `ctrl+x s`, and you hear it.

It doesn't just read the raw text aloud. Before speaking, the selection is rewritten for listening:

- **Plain text** is kept as close to the original as possible. Markdown symbols are dropped and abbreviations are expanded. Nothing is summarized.
- **Tables** are described the way a person next to you would explain them ("There are four options. Kokoro sounds very good and runs on your processor alone…"), not read cell by cell.
- **Code** gets one short spoken description ("a short Python function that retries the request"), not symbol-by-symbol reading.
- **Lists, headings and links** become natural speech.

The voice is [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), a small text-to-speech model that runs locally on your CPU. It's free, works offline, and no audio leaves your machine.

## Requirements

- **Claude Code in fullscreen layout.** The mod reads your mouse selection, and Claude Code only exposes it in fullscreen. Set `"tui": "fullscreen"` in your Claude Code `settings.json`.
- **Linux** with PipeWire (`pw-play`) or PulseAudio (`paplay`) for playback.
- **[uv](https://docs.astral.sh/uv/).** The voice server runs as a small Python process that `uv` sets up on first use.
- **About 340 MB of disk space** for the voice model. It downloads to `~/.cache/talk2me/` the first time you use the mod.

## Install

In Claude Code:

```text
/plugin marketplace add podkanski-dev/claude_mods
/plugin install talk2me@kpodkanski-mods
```

From a local clone, add the folder instead:

```text
/plugin marketplace add /path/to/claude_mods
/plugin install talk2me@kpodkanski-mods
```

### Set up the key

Plugins can't register keys of their own. The mod's button borrows an engine action that does nothing unless the diff panel is open. Add this to `~/.claude/keybindings.json` (or `$CLAUDE_CONFIG_DIR/keybindings.json` if you use one), merging it with any bindings you already have:

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "bindings": [
    { "context": "Global", "bindings": { "ctrl+x s": "app:toggleDiffNoiseFilter" } }
  ]
}
```

Restart Claude Code if the key doesn't work straight away.

## Use

1. Highlight any part of the conversation with the mouse.
2. Press `ctrl+x s`. You can also click the 🔊 button above the prompt, or type `/speak`.
3. The button shows **◌ processing…** while the text is rewritten and the voice starts, then **■ speaking…** once you hear it.
4. Press `ctrl+x s` again (or the button) to stop.

The very first press downloads the voice model, and you'll see a toast while that happens. After that, speech starts within a few seconds.

## Settings

Run `/plugin configure talk2me@kpodkanski-mods`:

| Setting | Default | What it does |
|---|---|---|
| `voice` | `af_heart` | The Kokoro voice: `af_heart`, `af_bella`, `af_nicole`, `af_sarah`, `am_michael`, `am_adam`, `am_fenrir`, `bf_emma`, `bm_george` |
| `speed` | `1.0` | Speaking speed, from 0.5 to 2.0 |

## Privacy

Two things happen to your selection:

- The **rewrite** sends it to Claude (Haiku), like any message you'd send in the session.
- The **speech** is made entirely on your machine. The only outside download is the model files from GitHub on first use.

## How it works

The mod splits the selection into blocks, keeping each table and piece of code whole. It rewrites the first block with Haiku and starts speaking it while the rest are still being rewritten. A small Python server (`voice/server.py`) keeps Kokoro loaded and plays the audio sentence by sentence. Each Claude Code session runs its own server, reached over a Unix socket, and the server shuts down after 10 minutes without use.

## Troubleshooting

| You see | What to do |
|---|---|
| "Highlight some text first (talk2me needs fullscreen)" | Turn on fullscreen layout, then highlight text before pressing the key. |
| The key does nothing | Check `keybindings.json`, restart Claude Code, or use the 🔊 button or `/speak`. The key doesn't work while the diff panel is open. |
| "the voice stopped: …" | The voice server couldn't start. Check that `uv` and `pw-play` or `paplay` are installed. The message shows the server's last line. |
| "the voice could not load: …" | The model download failed. Press again to retry: the server restarts by itself after a failure. |

For more detail, start Claude Code with `claude --debug`. The voice server's output goes to the debug log.

## Development

```bash
claude plugin test talk2me            # mod tests
python3 -I talk2me/voice/test_server.py  # voice server checks
claude plugin validate talk2me
```
