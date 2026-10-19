import type { SessionMessage } from 'claude-code'

import type { Critique } from '../types'

export const RUBRIC = `Judge the response on correctness, completeness against what the user asked, clarity, and risk (unverified claims, missed edge cases, unrequested changes). Be specific and terse.
Reply with JSON only, no prose and no code fences:
{"verdict":"Strong"|"Mixed"|"Weak","summary":"<1-2 sentences>","strengths":["..."],"flaws":[{"issue":"<what is wrong>","fix":"<concrete instruction that fixes it>"}]}
At most 5 strengths and 5 flaws. An empty flaws list is fine when there are none.`

export const FORK_PROMPT = `Step outside your role for this one message: as a strict reviewer, critique your own most recent response (everything you did and said since my last message). Do not fix anything now.
${RUBRIC}`

const VERDICTS = ['Strong', 'Mixed', 'Weak']
const strings = (v: unknown) => (Array.isArray(v) ? v.filter(s => typeof s === 'string') : [])

// Pulls the first {...} out of the reply, so stray prose or fences around it don't matter.
export function parseCritique(text: string): Critique | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: any
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!VERDICTS.includes(raw?.verdict) || typeof raw.summary !== 'string') return null

  return {
    verdict: raw.verdict,
    summary: raw.summary,
    strengths: strings(raw.strengths),
    flaws: (Array.isArray(raw.flaws) ? raw.flaws : [])
      .filter((f: any) => typeof f?.issue === 'string' && typeof f?.fix === 'string')
      .map((f: any) => ({ issue: f.issue, fix: f.fix })),
  }
}

const MAX_CHARS = 500_000

// The whole conversation as text, tool calls and their results included, for a model with no history.
// ponytail: past ~500k chars (~125k tokens) the oldest part is dropped to fit the reviewer's context.
export function transcript(messages: readonly SessionMessage[]): string | null {
  const lastPrompt = messages.findLastIndex(m => m.role === 'user' && m.text !== '' && !m.toolResults?.length)
  if (lastPrompt < 0 || !messages.slice(lastPrompt + 1).some(m => m.role === 'assistant')) return null

  const text = messages
    .flatMap(m =>
      m.role === 'user'
        ? m.text
          ? [`[user]\n${m.text}`]
          : []
        : [
            `[assistant]\n${m.text}`,
            ...m.toolUses.map(
              t => `[tool call: ${t.tool}${t.isError ? ' (errored)' : ''}] ${JSON.stringify(t.input)}\n[result]\n${t.text ?? ''}`,
            ),
          ],
    )
    .join('\n\n')

  return text.length > MAX_CHARS ? `[earlier conversation cut]\n${text.slice(-MAX_CHARS)}` : text
}

export const fixPrompt = (issue: string, fix: string) =>
  `Fix this flaw in your last response.\nFlaw: ${issue}\nFix: ${fix}`
