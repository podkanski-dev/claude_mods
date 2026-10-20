export type Verdict = 'right' | 'wrong' | null
export type Assumption = { id: string; text: string; verdict: Verdict; note: string; sent?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'assumption-tracker': { items: Assumption[] }
  }
}
