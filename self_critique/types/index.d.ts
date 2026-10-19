export type Verdict = 'Strong' | 'Mixed' | 'Weak'
export type Flaw = { issue: string; fix: string }
export type Critique = { verdict: Verdict; summary: string; strengths: string[]; flaws: Flaw[] }
export type ModelChoice = 'session' | 'opus' | 'sonnet' | 'haiku'

declare module 'claude-code' {
  interface PluginState {
    'self-critique': {
      critique: Critique | null
      isRunning: boolean
      error: string | null
      isAuto: boolean
      model: ModelChoice
    }
  }
}
