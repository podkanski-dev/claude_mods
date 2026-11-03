# kpodkanski-mods

Mods for [Claude Code](https://claude.com/claude-code): small plugins that change how Claude works and what you see beside the chat.

| Mod | What it does |
|---|---|
| [talk2me](talk2me/README.md) | Highlight part of the conversation (or nothing, for Claude's latest reply) and press `ctrl+x s` to hear it read aloud. Tables and code are described, not read symbol by symbol. The voice runs locally. |
| assumption-tracker | After each task, lists the assumptions Claude made. Mark them Right or Wrong and Claude fixes only the wrong ones. |
| self-critique | `/critique` opens a side panel reviewing Claude's last response, with one-press fixes. |

## Install

In Claude Code:

```text
/plugin marketplace add podkanski-dev/claude_mods
/plugin install talk2me@kpodkanski-mods
```

Install the other mods the same way: `assumption-tracker@kpodkanski-mods` and `self-critique@kpodkanski-mods`.

## License

[MIT](LICENSE)
