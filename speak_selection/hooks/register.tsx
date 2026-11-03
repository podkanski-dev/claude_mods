// The band button carries this engine action, so its chord presses the button
// from the prompt. Bind it in ~/.claude/keybindings.json:
//   { "context": "Global", "bindings": { "ctrl+x s": "app:toggleDiffNoiseFilter" } }
// The action has no default key and its engine handler only mounts with the
// diff panel, so the chord reaches the button everywhere else.
import type { Register } from 'claude-code'

export const KEY_ACTION = 'app:toggleDiffNoiseFilter'

export const register: Register = () => {}
