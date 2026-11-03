// processing: rewriting and starting the voice; speaking: audio is playing.
export type Phase = 'idle' | 'processing' | 'speaking'

declare module 'claude-code' {
  interface PluginState {
    'talk2me': {
      phase: Phase
    }
  }
}
