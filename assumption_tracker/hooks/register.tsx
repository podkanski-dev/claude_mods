import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Assumption, Verdict } from '../types'

const PANE = 'assumptions'
const items = atom({ plugin: 'assumption-tracker', key: 'items' } as const, [] as Assumption[])
// Typed but not yet saved with Enter. Kept out of `items`: the terminal refills a field only when its `value` changes.
const drafts = new Map<string, string>()

const EXTRACT = `Look back at the task you just finished. List the assumptions you filled in where my request was silent or ambiguous and where a different guess would have given me a noticeably different result: what it does, what it covers, how it behaves, what I get. Phrase each as the guess, not as a step you took ("Assumed only admins may delete", not "Added a delete check").
Leave out anything I stated, anything I'd never notice in the outcome (internal names, file layout, refactors, routine implementation choices), and anything that was the only sensible option. Fewer is better: an empty list beats padding.
Answer with a JSON array of short strings and nothing else. If there were none, answer [].`

export function parse(reply: string): string[] {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start < 0 || end < start) return []
  try {
    const list: unknown = JSON.parse(reply.slice(start, end + 1))
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => s.trim()) : []
  } catch {
    return []
  }
}

export function fixPrompt(list: Assumption[]): string {
  const line = (a: Assumption) => `- ${a.text}${a.note ? `\n  My note: ${a.note}` : ''}`
  const of = (v: Verdict) => list.filter(a => a.verdict === v).map(line).join('\n')
  const right = of('right')
  const open = of(null)
  return [
    'I reviewed the assumptions you made in the last task.',
    `These were WRONG. Fix only the parts of your work that rest on them:\n${of('wrong')}`,
    right && `These were RIGHT. Keep everything that rests on them exactly as it is:\n${right}`,
    open && `I did not review these; leave them as they are unless a fix above forces a change:\n${open}`,
    'Change nothing else.',
  ].filter(Boolean).join('\n\n')
}

// Sends the fix when anything is marked Wrong; clears the list once it is fully dealt with.
async function finish($: EngineInterface) {
  const list = (await read($, items)).map(a => ({ ...a, note: drafts.get(a.id) ?? a.note }))
  drafts.clear()
  const hasWrong = list.some(a => a.verdict === 'wrong')
  if (hasWrong) await $.prompt.submit({ text: fixPrompt(list), asUser: true })
  if (hasWrong || list.every(a => a.verdict !== null)) await update($, items, () => [])
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Assumptions', focus: true, closeOnEscape: true, holdToasts: true })
}

export const register: Register = on => {
  let latest = ''

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return result

    const turnId = (latest = e.turnId)
    // ponytail: one forked request per finished turn (cached prefix); add a per-turn opt-out if cost bites
    $.clock.after(0, async () => {
      const reply = await $.model.fork({ prompt: `Your final reply was:\n${e.answer}\n\n${EXTRACT}` })
      if (!reply.isAnswered || turnId !== latest) return
      const found = parse(reply.text).map((text, i) => ({ id: `${turnId}-${i}`, text, verdict: null, note: '' }))
      await update($, items, () => found)
    })
    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await finish($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, items)
    if (list.length === 0 || e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const done = list.filter(a => a.verdict !== null).length
    return (
      <Box>
        <Text color="warning">
          Claude made {list.length} assumption{list.length === 1 ? '' : 's'}
        </Text>
        <Text dimColor>
          {done > 0 ? ` (${done} reviewed)` : ''}{' '}
        </Text>
        {/* a bare digit in an empty prompt box presses a band Button's hotkey */}
        <Button key="review" hotkey="0" label="Review" onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const list = await read($, items)
    const set = (id: string, change: Partial<Assumption>) =>
      update($, items, all => all.map(a => (a.id === id ? { ...a, ...change } : a)))
    const wrong = list.filter(a => a.verdict === 'wrong').length

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No assumptions to review.</Text>}
        {list.map((a, i) => (
          <Box key={a.id} flexDirection="column" marginBottom={1}>
            <Text>
              <Text color={a.verdict === 'right' ? 'success' : a.verdict === 'wrong' ? 'error' : 'subtle'}>
                {a.verdict === 'right' ? '✓' : a.verdict === 'wrong' ? '✗' : '·'}
              </Text>{' '}
              {i + 1}. {a.text}
            </Text>
            <Box>
              <Button
                key={`right-${a.id}`}
                label="Right"
                variant={a.verdict === 'right' ? 'primary' : undefined}
                autoFocus={i === 0 ? true : undefined}
                onPress={() => set(a.id, { verdict: 'right' })}
              />
              <Text> </Text>
              <Button
                key={`wrong-${a.id}`}
                label="Wrong"
                variant={a.verdict === 'wrong' ? 'primary' : undefined}
                onPress={() => set(a.id, { verdict: 'wrong' })}
              />
              <Text> </Text>
              {e.surface !== 'mobile' && 'Input' in ui && (
                <ui.Input
                  key={`note-${a.id}`}
                  placeholder="note (optional)"
                  submitLabel="save"
                  value={a.note}
                  onInput={note => void drafts.set(a.id, note)}
                  onSubmit={note => {
                    drafts.delete(a.id)
                    void set(a.id, { note })
                  }}
                />
              )}
            </Box>
            {a.note !== '' && <Text dimColor>  note: {a.note}</Text>}
          </Box>
        ))}
        <Box>
          <Button
            key="done"
            variant="primary"
            label={wrong > 0 ? `Send ${wrong} fix${wrong === 1 ? '' : 'es'} to Claude` : 'Done'}
            onPress={async () => {
              await finish($)
              await $.ui.close({ id: PANE })
            }}
          />
          <Text dimColor> Esc also sends anything marked Wrong</Text>
        </Box>
      </Box>
    )
  })
}
