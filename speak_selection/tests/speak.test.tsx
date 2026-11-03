import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PLUGIN = 'speak-selection'
const BAND = { plugin: PLUGIN, component: 'AbovePrompt', props: { hasSurvey: false } as never } as const
const HIGHLIGHT = 'Highlight some text first (speak-selection needs fullscreen)'

type Fake = {
  selection?: string
  replies?: (block: string) => Promise<{ text: string } | { reason: 'api-error' | 'aborted' }>
  states?: string[]
}

// Stands in for the engine: the selection, Haiku, the voice server's socket,
// toasts. Records what the mod asked for.
function fake(on: On, { selection, replies, states = [] }: Fake) {
  const seen = { prompts: [] as { model: string; prompt: string }[], says: [] as string[], stops: 0, spawns: [] as string[][], toasts: [] as string[] }
  on('ui.selection', () => ({ value: selection === undefined ? undefined : { text: selection } }))
  on('model.complete', async (_, e) => {
    seen.prompts.push({ model: e.model, prompt: e.prompt })
    const r = replies ? await replies(e.prompt) : { text: `spoken: ${e.prompt}` }
    return 'text' in r
      ? { value: { isAnswered: true as const, text: r.text, usage } }
      : { value: { isAnswered: false as const, reason: r.reason as 'aborted', usage } }
  })
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/status')) {
      const state = states.shift() ?? 'idle'
      if (state === 'down') throw new Error('ECONNREFUSED')
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ state }) } }
    }
    if (e.url.endsWith('/say')) seen.says.push(JSON.parse(e.init?.body ?? '{}').text)
    if (e.url.endsWith('/stop')) seen.stops += 1
    return { value: { status: 202, ok: true, headers: {}, text: '{}' } }
  })
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[] }) {
    seen.spawns.push([...e.argv])
    return { value: { code: 0, signal: null } }
  } as never)
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'speak' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return seen
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`nothing highlighted: a toast and no rewrite (${surface})`, async ($, on) => {
    mock.clock(on)
    const seen = fake(on, {})
    const band = await $.ui.mount({ ...BAND, surface })
    await band.press({ key: 'speak' })

    expect(seen.toasts).toEqual([HIGHLIGHT])
    expect(seen.prompts).toEqual([])
  })

  test(`each block is rewritten by haiku and spoken in order (${surface})`, async ($, on) => {
    mock.clock(on)
    const seen = fake(on, { selection: 'First **part**.\n\nSecond part.' })
    const band = await $.ui.mount({ ...BAND, surface })
    await band.press({ key: 'speak' })

    expect(seen.prompts).toEqual([
      { model: 'haiku', prompt: 'First **part**.' },
      { model: 'haiku', prompt: 'Second part.' },
    ])
    expect(seen.says).toEqual(['spoken: First **part**.', 'spoken: Second part.'])
  })
}

test('pressing again before any sound stops, and nothing is spoken', async ($, on) => {
  mock.clock(on)
  let release = () => {}
  let rewriting = () => {}
  const isRewriting = new Promise<void>(resolve => (rewriting = resolve))
  const seen = fake(on, {
    selection: 'One.\n\nTwo.',
    replies: block => {
      rewriting()
      return new Promise(resolve => (release = () => resolve({ text: block })))
    },
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  const first = band.press({ key: 'speak' })
  await isRewriting
  await band.press({ key: 'speak' })
  release()
  await first

  expect(seen.stops).toBe(1)
  expect(seen.says).toEqual([])
})

test('a failed rewrite says why and never reads the raw text', async ($, on) => {
  mock.clock(on)
  const seen = fake(on, { selection: '│ a │ b │', replies: async () => ({ reason: 'api-error' }) })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'speak' })

  expect(seen.toasts).toEqual(["Couldn't rewrite the selection: api-error"])
  expect(seen.says).toEqual([])
})

test('a voice server that is gone is started again, with the first-run toast while it downloads', async ($, on) => {
  const clock = mock.clock(on)
  const seen = fake(on, { selection: 'Hello.', states: ['down', 'downloading', 'downloading', 'loading', 'idle'] })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pressed = band.press({ key: 'speak' })
  await clock.advance(5000)
  await pressed

  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0]?.slice(-2)).toEqual(['--idle', '600'])
  expect(seen.toasts).toEqual(['Downloading the voice model (first run, about 340 MB)…'])
  expect(seen.says).toEqual(['spoken: Hello.'])
})

test('/speak does what the button does', async ($, on) => {
  mock.clock(on)
  const seen = fake(on, { selection: 'Hi.' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'speak', args: '' } as never)

  expect(seen.says).toEqual(['spoken: Hi.'])
})
