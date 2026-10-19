import { expect, mock, test } from 'claude-code/testing'

import { parseCritique, transcript } from '../hooks/critique'

const CRITIQUE = {
  verdict: 'Mixed',
  summary: 'Works, misses a case.',
  strengths: ['Small diff'],
  flaws: [{ issue: 'No null check', fix: 'Guard against null input' }],
}

test('parseCritique reads JSON wrapped in prose and rejects junk', () => {
  expect(parseCritique('Sure:\n```json\n' + JSON.stringify(CRITIQUE) + '\n```')).toEqual(CRITIQUE)
  expect(parseCritique('{"verdict":"Great","summary":"x"}')).toBe(null)
  expect(parseCritique('no json here')).toBe(null)
  expect(parseCritique('{"verdict":"Weak","summary":"s","flaws":[{"issue":1}]}')?.flaws).toEqual([])
})

test('transcript keeps the whole conversation, tool results included', () => {
  const text = transcript([
    { role: 'user', text: 'first ask', toolUses: [] },
    { role: 'assistant', text: 'first answer', toolUses: [] },
    { role: 'user', text: 'second ask', toolUses: [] },
    {
      role: 'assistant',
      text: 'reading',
      toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' }, text: 'file body' }],
    },
    { role: 'user', text: '', toolUses: [], toolResults: [] },
    { role: 'assistant', text: 'done', toolUses: [] },
  ])
  for (const part of ['first ask', 'first answer', 'second ask', '[tool call: Read]', 'file body', 'done']) {
    expect(text).toContain(part)
  }
  expect(transcript([{ role: 'user', text: 'only a question', toolUses: [] }])).toBe(null)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Rerun shows the review and Make this fix sends it (${surface})`, async ($, on) => {
    const clock = mock.clock(on)
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    on('model.fork', () => ({ value: { isAnswered: true as const, text: JSON.stringify(CRITIQUE), usage } }))
    const sent: string[] = []
    on('prompt.submit', (_, e) => {
      sent.push(e.text)
      return { text: e.text }
    })

    const ui = await $.ui.mount({
      plugin: 'self-critique',
      surface,
      component: 'Pane',
      requestId: 'self-critique',
      props: {
        title: 'Self-Critique',
        isFocused: true,
        bodyColumns: 80,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    await ui.press({ key: 'rerun' })
    await clock.advance(300)
    expect(await ui.find({ text: 'Mixed' })).toBeTruthy()
    await ui.press({ key: 'fix-0' })

    expect(sent).toEqual(['Fix this flaw in your last response.\nFlaw: No null check\nFix: Guard against null input'])
  })
}
