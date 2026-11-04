import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const PLUGIN = 'talk2me'
const BAND = { plugin: PLUGIN, component: 'AbovePrompt', props: { hasSurvey: false } as never } as const
const NOTHING = 'Nothing to read yet: highlight some text or wait for a reply'

type Fake = {
  selection?: string
  // The transcript, for when nothing is highlighted.
  messages?: { role: 'user' | 'assistant'; text: string; toolResults?: unknown[] }[]
  replies?: (block: string) => Promise<{ text: string } | { reason: 'api-error' | 'aborted' | 'empty-reply' }>
  states?: string[]
  // How the first spawned voice server behaves: keeps running (default),
  // exits at once with an error line, or runs until the promise settles.
  // Any later one keeps running.
  child?: 'exits' | Promise<void>
}

// Stands in for the engine: the selection, Haiku, the voice server on its
// local port, toasts. Records what the mod asked for.
function fake(on: On, { selection, messages = [], replies, states = [], child }: Fake) {
  const seen = {
    prompts: [] as { model: string; prompt: string }[],
    says: [] as string[],
    stops: 0,
    spawns: [] as { argv: string[]; env: Record<string, string> }[],
    requests: [] as { url: string; auth?: string }[],
    toasts: [] as string[],
  }
  on('ui.selection', () => ({ value: selection === undefined ? undefined : { text: selection } }))
  on('session.messages', () => ({ value: messages.map(m => ({ toolUses: [], ...m })) as never }))
  on('model.complete', async (_, e) => {
    seen.prompts.push({ model: e.model, prompt: e.prompt })
    const r = replies ? await replies(e.prompt) : { text: `spoken: ${e.prompt}` }
    return 'text' in r
      ? { value: { isAnswered: true as const, text: r.text, usage } }
      : { value: { isAnswered: false as const, reason: r.reason as 'aborted', usage } }
  })
  on('http.fetch', (_, e) => {
    seen.requests.push({ url: e.url, auth: e.init?.headers?.Authorization })
    if (e.url.endsWith('/status')) {
      const state = states.shift() ?? 'idle'
      if (state === 'down') throw new Error('ECONNREFUSED')
      // 'playing': the server is speaking and audio is coming out now.
      const body = state === 'playing' ? { state: 'speaking', isPlaying: true } : { state, isPlaying: false }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
    }
    if (e.url.endsWith('/say')) seen.says.push(JSON.parse(e.init?.body ?? '{}').text)
    if (e.url.endsWith('/stop')) seen.stops += 1
    return { value: { status: 202, ok: true, headers: {}, text: '{}' } }
  })
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[]; env?: Record<string, string> }) {
    seen.spawns.push({ argv: [...e.argv], env: { ...e.env } })
    const behaviour = seen.spawns.length === 1 ? child : undefined
    if (behaviour === 'exits') {
      yield { stream: 'stderr', text: 'error: uv: command not found\n' }
      return { value: { code: 127, signal: null } }
    }
    yield { stream: 'stdout', text: 'TALK2ME_PORT 4567\n' }
    await (behaviour ?? new Promise(() => {}))
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
  test(`nothing highlighted and no reply yet: a toast and no rewrite (${surface})`, async ($, on) => {
    mock.clock(on)
    const seen = fake(on, { messages: [{ role: 'user', text: 'hi' }] })
    const band = await $.ui.mount({ ...BAND, surface })
    await band.press({ key: 'speak' })

    expect(seen.toasts).toEqual([NOTHING])
    expect(seen.prompts).toEqual([])
  })

  test(`nothing highlighted: Claude's whole latest reply is read (${surface})`, async ($, on) => {
    mock.clock(on)
    const seen = fake(on, {
      messages: [
        { role: 'user', text: 'first question' },
        { role: 'assistant', text: 'Old answer.' },
        { role: 'user', text: 'second question' },
        { role: 'assistant', text: 'Checking.' },
        { role: 'user', text: '', toolResults: [{}] },
        { role: 'assistant', text: '' },
        { role: 'user', text: '', toolResults: [{}] },
        { role: 'assistant', text: 'Done.\n\nAll good.' },
      ],
    })
    const band = await $.ui.mount({ ...BAND, surface })
    await band.press({ key: 'speak' })

    expect(seen.prompts.map(p => p.prompt)).toEqual(['Checking.', 'Done.', 'All good.'])
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

test('the first press starts the voice server, with the first-run toast while it downloads', async ($, on) => {
  const clock = mock.clock(on)
  const seen = fake(on, { selection: 'Hello.', states: ['downloading', 'downloading', 'loading', 'idle'] })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pressed = band.press({ key: 'speak' })
  await clock.advance(5000)
  await pressed

  expect(seen.spawns.length).toBe(1)
  expect(seen.spawns[0]?.argv.slice(-2)).toEqual(['--idle', '600'])
  expect(seen.toasts).toEqual(['Downloading the voice model (first run, about 340 MB)…'])
  expect(seen.says).toEqual(['spoken: Hello.'])
})

test('every request goes to the port the server reported, with the secret it was started with', async ($, on) => {
  mock.clock(on)
  const seen = fake(on, { selection: 'Hi.' })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'speak' })

  const token = seen.spawns[0]?.env.TALK2ME_TOKEN ?? ''
  expect(token.length).toBeGreaterThanOrEqual(32)
  expect(seen.requests.length).toBeGreaterThan(0)
  for (const request of seen.requests) {
    expect(request.url.startsWith('http://127.0.0.1:4567/')).toBe(true)
    expect(request.auth).toBe(`Bearer ${token}`)
  }
})

test('a voice server that has exited is started again on the next press', async ($, on) => {
  const clock = mock.clock(on)
  let exit = () => {}
  const running = new Promise<void>(resolve => (exit = resolve))
  const seen = fake(on, { selection: 'Hi.', child: running })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'speak' })
  exit()
  await clock.advance(1000)
  await band.press({ key: 'speak' })

  expect(seen.spawns.length).toBe(2)
  expect(seen.says).toEqual(['spoken: Hi.', 'spoken: Hi.'])
})

test('/speak does what the button does', async ($, on) => {
  const clock = mock.clock(on)
  const seen = fake(on, { selection: 'Hi.' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'speak', args: '' } as never)
  await clock.settle()

  expect(seen.says).toEqual(['spoken: Hi.'])
})

test('/speak returns at once and speaks in the background', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  let rewriting = () => {}
  const isRewriting = new Promise<void>(resolve => (rewriting = resolve))
  const seen = fake(on, {
    selection: 'Hi.',
    replies: block => {
      rewriting()
      return new Promise(resolve => (release = () => resolve({ text: block })))
    },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'speak', args: '' } as never)

  expect(seen.says).toEqual([])
  await isRewriting
  release()
  for (let i = 0; i < 50 && seen.says.length === 0; i++) await clock.advance(100)
  expect(seen.says).toEqual(['Hi.'])
})

test('a model call that is refused says why, and the next press speaks again', async ($, on) => {
  mock.clock(on)
  let isRefused = true
  const seen = fake(on, {
    selection: 'Hi.',
    replies: async block => {
      if (isRefused) throw new Error('model blocked')
      return { text: block }
    },
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'speak' })
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]).toContain("Couldn't rewrite the selection")

  isRefused = false
  await band.press({ key: 'speak' })
  expect(seen.says).toEqual(['Hi.'])
})

test('stopping while the voice starts, then pressing again, starts only one server', async ($, on) => {
  const clock = mock.clock(on)
  let end = () => {}
  const running = new Promise<void>(resolve => (end = resolve))
  const seen = fake(on, { selection: 'Hi.', states: ['down', 'down', 'down', 'down', 'down', 'idle'], child: running })
  // 'down': the server has said its port but does not answer yet.
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  const first = band.press({ key: 'speak' })
  await clock.advance(600)
  await band.press({ key: 'speak' })
  await first
  const second = band.press({ key: 'speak' })
  await clock.advance(5000)
  await second

  expect(seen.spawns.length).toBe(1)
  expect(seen.says).toEqual(['spoken: Hi.'])
  end()
})

test('a voice server that exits at once is reported, not waited on', async ($, on) => {
  const clock = mock.clock(on)
  const seen = fake(on, { selection: 'Hi.', states: Array(20).fill('down'), child: 'exits' })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pressed = band.press({ key: 'speak' })
  await clock.advance(2000)
  await pressed

  expect(seen.toasts).toEqual(['talk2me: the voice stopped: error: uv: command not found'])
})

test('a block the model has no words for is skipped, the rest is read', async ($, on) => {
  mock.clock(on)
  const seen = fake(on, {
    selection: 'One.\n\n────\n\nTwo.',
    replies: async block => (block === '────' ? { reason: 'empty-reply' } : { text: block }),
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'speak' })

  expect(seen.toasts).toEqual([])
  expect(seen.says).toEqual(['One.', 'Two.'])
})

test('the button says processing until audio plays, then speaking', async ($, on) => {
  const clock = mock.clock(on)
  let release = () => {}
  let rewriting = () => {}
  const isRewriting = new Promise<void>(resolve => (rewriting = resolve))
  const states = ['idle']
  const seen = fake(on, {
    selection: 'Hi.',
    states,
    replies: block => {
      rewriting()
      return new Promise(resolve => (release = () => resolve({ text: block })))
    },
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const label = async () => (await band.find({ key: 'speak' }))?.text

  expect(await label()).toBe('\u{1F50A} talk2me')
  const pressed = band.press({ key: 'speak' })
  await isRewriting
  expect(await label()).toBe('◌ processing…')

  states.push('speaking', 'playing', 'playing', 'idle')
  release()
  for (let i = 0; i < 20 && (await label()) !== '■ speaking…'; i++) await clock.advance(300)
  expect(await label()).toBe('■ speaking…')

  await clock.advance(3000)
  await pressed
  expect(await label()).toBe('\u{1F50A} talk2me')
  expect(seen.says).toEqual(['Hi.'])
})

test("another mod's band beneath keeps its place beside the button, and both press", async ($, on) => {
  mock.clock(on)
  let reviewed = 0
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Button key="review" label="Review" onPress={() => void (reviewed += 1)} />
      </Box>
    )
  })
  const seen = fake(on, { selection: 'Hello.' })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await band.press({ key: 'review', plugin: 'test' })
  await band.press({ key: 'speak' })

  expect(reviewed).toBe(1)
  expect(seen.says).toEqual(['spoken: Hello.'])
})
