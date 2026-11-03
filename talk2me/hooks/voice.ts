import type { EngineInterface } from 'claude-code'

const LOAD_LIMIT_MS = 300_000
const FIRST_RUN = 'Downloading the voice model (first run, about 340 MB)…'

const id = Math.random().toString(36).slice(2)

export async function socketPath($: EngineInterface): Promise<string> {
  const dir = (await $.env.get('XDG_RUNTIME_DIR')) ?? '/tmp'
  return `${dir}/talk2me-${id}.sock`
}

type Status = { state: 'downloading' | 'loading' | 'idle' | 'speaking' | 'failed'; isPlaying?: boolean; error?: string | null }

async function status($: EngineInterface, socket: string): Promise<Status | null> {
  try {
    const r = await $.http.fetch('http://voice/status', { socketPath: socket })
    return r.ok ? (JSON.parse(r.text) as Status) : null
  } catch {
    return null
  }
}

// The voice server this module started, while it runs. `uv` can take tens
// of seconds to set up before the socket answers, so a press in that time
// must wait for this one rather than start a second.
type Child = { lastLine: string; hasExited: boolean }
let child: Child | null = null

// Starts the session's voice server when none answers (first press, or it
// exited after idling) and waits until Kokoro is loaded.
export async function ensureVoice($: EngineInterface, socket: string, signal: AbortSignal): Promise<void> {
  let s = await status($, socket)
  if (s === null && child === null) {
    const started: Child = { lastLine: '', hasExited: false }
    child = started
    const home = await $.env.get('HOME')
    const argv = [
      'uv', 'run', '-q', '--no-project', '--with', 'kokoro-onnx', '--with', 'soundfile',
      'python', '-I', `${$.plugin.root}/voice/server.py`,
      '--socket', socket, '--cache', `${home}/.cache/talk2me`, '--idle', '600',
    ]
    // The loop is the server's life: it runs on after this press and ends with
    // the server or with the module.
    void (async () => {
      for await (const { text } of $.process.spawn({ argv })) {
        $.ui.log(text, { to: 'debug' })
        started.lastLine = text.trim().split('\n').at(-1) ?? started.lastLine
      }
    })()
      .catch(error => (started.lastLine = String(error)))
      .finally(() => {
        started.hasExited = true
        if (child === started) child = null
      })
  }
  const waitingOn = child

  let isToldDownloading = false
  const deadline = (await $.clock.now()) + LOAD_LIMIT_MS
  while (s === null || s.state === 'downloading' || s.state === 'loading') {
    if (s?.state === 'downloading' && !isToldDownloading) {
      isToldDownloading = true
      $.ui.toast(FIRST_RUN)
    }
    if (s === null && waitingOn?.hasExited) throw new Error(`the voice stopped: ${waitingOn.lastLine}`)
    if ((await $.clock.now()) > deadline) throw new Error('the voice did not start within 5 minutes')
    await $.clock.sleep(500, { signal })
    s = await status($, socket)
  }
  if (s.state === 'failed') throw new Error(`the voice could not load: ${s.error}`)
}

export async function say($: EngineInterface, socket: string, text: string, voice: string, speed: number): Promise<void> {
  await $.http.fetch('http://voice/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speed }),
    socketPath: socket,
  })
}

export async function stopVoice($: EngineInterface, socket: string): Promise<void> {
  await $.http.fetch('http://voice/stop', { method: 'POST', socketPath: socket }).catch(() => undefined)
}

// Busy: sentences are still queued, being made or playing.
export async function isBusy($: EngineInterface, socket: string): Promise<boolean> {
  return (await status($, socket))?.state === 'speaking'
}

// Audible: a sentence is playing right now.
export async function isAudible($: EngineInterface, socket: string): Promise<boolean> {
  return (await status($, socket))?.isPlaying === true
}
