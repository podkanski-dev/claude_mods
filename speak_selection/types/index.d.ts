// processing: rewriting and starting the voice; speaking: audio is playing.
export type Phase = 'idle' | 'processing' | 'speaking'

declare module 'claude-code' {
  interface PluginState {
    'speak-selection': {
      phase: Phase
    }
  }
}
