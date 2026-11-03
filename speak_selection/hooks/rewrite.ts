import type { EngineInterface } from 'claude-code'

export const REWRITE_SYSTEM = `You turn text copied from a terminal chat with an AI coding assistant into words that a text-to-speech voice will read aloud to the user. Output only the words to speak: no markdown, no symbols, no preamble, no closing remarks.

Rules:
- Plain text: keep it as close to the original as you can, rewording only what speech needs (drop markdown marks, expand abbreviations like "e.g."). Keep every point; never summarize and never drop content.
- Tables: the text comes from a terminal, so a table is drawn with box-drawing characters (│ ─ ┼ ┌ ┐ └ ┘ ├ ┤). Never read it cell by cell. Describe it the way a person sitting next to the user would: first say what is being compared, then walk through it naturally, row by row or point by point, in full sentences.
- Code blocks: give one short spoken description of what the code is or does, such as "a short Python function that retries the request". Never read code symbol by symbol.
- Lists, headings, links and alerts: turn them into natural speech. Say a link's text, not its address.
- Speak in English.`

const CONTINUATION = '\n\nThis text continues something already being read aloud, so do not open with a greeting or an introduction.'

export async function rewriteBlock(
  $: EngineInterface,
  block: string,
  isFirst: boolean,
): Promise<{ text: string } | { error: string }> {
  const r = await $.model.complete({
    model: 'haiku',
    system: isFirst ? REWRITE_SYSTEM : REWRITE_SYSTEM + CONTINUATION,
    prompt: block,
    effort: 'low',
    maxTokens: 4096,
  })
  if (r.isAnswered) {
    return { text: r.text }
  }
  return { error: r.reason === 'api-error' && r.status != null ? `api-error ${r.status}` : r.reason }
}
