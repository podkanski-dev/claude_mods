export type IsSpeaking = boolean

declare module 'claude-code' {
  interface PluginState {
    'speak-selection': {
      isSpeaking: IsSpeaking
    }
  }
}
