import { expect, mock, test } from 'claude-code/testing'

const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PLUGIN = 'assumption-tracker'

test('review assumptions and send a fix for the wrong ones', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  const replies = ['```json\n["Used SQLite", "Named the table users"]\n```', '["used  sqlite", "Kept the old API"]']
  const prompts: string[] = []
  on('model.fork', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true as const, text: replies.shift() ?? '[]', usage } }
  })
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.close', () => ({ value: undefined }))

  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(await band.find({ type: 'Text', text: 'Claude made 2 assumptions' })).toBeDefined()

  await band.press({ key: 'review' })

  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'assumptions', props: {} as never })
  await pane.press({ key: 'right-t1-0' })
  await pane.press({ key: 'wrong-t1-1' })
  await pane.input({ key: 'note-t1-1', text: 'call it accounts' })
  expect(await pane.find({ type: 'Text', text: /note: call it accounts/ })).toBeDefined()
  await pane.input({ key: 'note-t1-0', text: 'sqlite is fine', kind: 'change' })
  await pane.press({ key: 'done' })

  expect(sent.length).toBe(1)
  const fix = sent[0] ?? ''
  expect(fix).toMatch(/WRONG[^]*Named the table users\n  My note: call it accounts/)
  expect(fix).toMatch(/RIGHT[^]*Used SQLite\n  My note: sqlite is fine/)
  expect(fix.indexOf('Used SQLite')).toBeGreaterThan(fix.indexOf('RIGHT'))

  await $.turn.complete({ answer: 'Fixed.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  expect(prompts[1]).toMatch(/Already recorded[^]*- Named the table users/)
  await pane.redraw()
  expect(await pane.find({ type: 'Text', text: /Kept the old API/ })).toBeDefined()
  expect(await pane.findAll({ type: 'Text', text: /Used SQLite/i })).toHaveLength(1)
  expect(await pane.find({ type: 'Text', text: /fix sent/ })).toBeDefined()

  await pane.press({ key: 'wrong-t2-0' })
  await pane.press({ key: 'done' })
  expect(sent.length).toBe(2)
  expect(sent[1]).toMatch(/WRONG[^]*Kept the old API/)
  expect(sent[1]?.split('RIGHT')[0]).not.toMatch(/Named the table users/)
})
