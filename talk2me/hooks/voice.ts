import type { EngineInterface } from 'claude-code'

const LOAD_LIMIT_MS = 300_000
const FIRST_RUN = 'Downloading the voice model (first run, about 340 MB)…'

type Status = { state: 'downloading' | 'loading' | 'idle' | 'speaking' | 'failed'; isPlaying?: boolean; error?: string | null }

// The voice server this module started, while it runs. It listens on a port
// of 127.0.0.1 it picks and prints, and answers only requests carrying the
// secret it was started with. `uv` can take tens of seconds to set up before
// it answers, so a press in that time waits for this one rather than start a
// second.
type Server = { port?: number; token: string; lastLine: string; hasExited: boolean; ready: Promise<void> }
let server: Server | null = null

async function call($: EngineInterface, s: Server, path: string, init: { method?: string; body?: string } = {}) {
  return $.http.fetch(`http://127.0.0.1:${s.port}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
  })
}

async function status($: EngineInterface, s: Server | null): Promise<Status | null> {
  if (s?.port === undefined) return null
  try {
    const r = await call($, s, '/status')
    return r.ok ? (JSON.parse(r.text) as Status) : null
  } catch {
    return null
  }
}

function start($: EngineInterface): Server {
  let isReady = () => {}
  const ready = new Promise<void>(resolve => (isReady = resolve))
  const started: Server = { token: crypto.randomUUID().replaceAll('-', ''), lastLine: '', hasExited: false, ready }
  server = started
  const argv = [
    'uv', 'run', '-q', '--no-project', '--with', 'kokoro-onnx', '--with', 'soundfile',
    'python', '-I', `${$.plugin.root}/voice/server.py`, '--idle', '600',
  ]
  // The loop is the server's life: it runs on after this press and ends with
  // the server or with the module. The secret goes in the environment, where
  // other users can't read it the way they can read a command line.
  void (async () => {
    for await (const { text } of $.process.spawn({ argv, env: { TALK2ME_TOKEN: started.token } })) {
      $.ui.log(text, { to: 'debug' })
      const port = /TALK2ME_PORT (\d+)/.exec(text)
      if (port) {
        started.port = Number(port[1])
        isReady()
      }
      started.lastLine = text.trim().split('\n').at(-1) ?? started.lastLine
    }
  })()
    .catch(error => (started.lastLine = String(error)))
    .finally(() => {
      started.hasExited = true
      isReady()
      if (server === started) server = null
    })
  return started
}

// Starts the session's voice server when none runs (first press, or it
// exited after idling) and waits until Kokoro is loaded.
export async function ensureVoice($: EngineInterface, signal: AbortSignal): Promise<void> {
  const waitingOn = server ?? start($)
  await waitingOn.ready // its port is known, or it exited
  let s = await status($, waitingOn)

  let isToldDownloading = false
  const deadline = (await $.clock.now()) + LOAD_LIMIT_MS
  while (s === null || s.state === 'downloading' || s.state === 'loading') {
    if (s?.state === 'downloading' && !isToldDownloading) {
      isToldDownloading = true
      $.ui.toast(FIRST_RUN)
    }
    if (s === null && waitingOn.hasExited) throw new Error(`the voice stopped: ${waitingOn.lastLine}`)
    if ((await $.clock.now()) > deadline) throw new Error('the voice did not start within 5 minutes')
    await $.clock.sleep(500, { signal })
    s = await status($, waitingOn)
  }
  if (s.state === 'failed') throw new Error(`the voice could not load: ${s.error}`)
}

export async function say($: EngineInterface, text: string, voice: string, speed: number): Promise<void> {
  if (server) await call($, server, '/say', { method: 'POST', body: JSON.stringify({ text, voice, speed }) })
}

export async function stopVoice($: EngineInterface): Promise<void> {
  if (server?.port !== undefined) await call($, server, '/stop', { method: 'POST' }).catch(() => undefined)
}

// Busy: sentences are still queued, being made or playing.
export async function isBusy($: EngineInterface): Promise<boolean> {
  return (await status($, server))?.state === 'speaking'
}

// Audible: a sentence is playing right now.
export async function isAudible($: EngineInterface): Promise<boolean> {
  return (await status($, server))?.isPlaying === true
}
