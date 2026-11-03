// The band button carries this engine action, so its chord presses the button
// from the prompt. Bind it in ~/.claude/keybindings.json:
//   { "context": "Global", "bindings": { "ctrl+x s": "app:toggleDiffNoiseFilter" } }
// The action has no default key and its engine handler only mounts with the
// diff panel, so the chord reaches the button everywhere else.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Phase } from '../types'
import { splitBlocks } from './blocks'
import { rewriteBlock } from './rewrite'
import { ensureVoice, isAudible, isBusy, say, socketPath, stopVoice } from './voice'

export const KEY_ACTION = 'app:toggleDiffNoiseFilter'

const phase = atom({ plugin: 'talk2me', key: 'phase' } as const, 'idle' as Phase)

// Each press starts a new run; a run whose number is no longer current has
// been stopped and must not post anything more to the voice. `active` is
// checked and set before any await, so two quick presses can't both start.
let run = 0
let active = 0
let stopRun = new AbortController()

export async function toggleSpeak($: EngineInterface, options: PluginOptions): Promise<void> {
  if (active !== 0) {
    run += 1
    active = 0
    stopRun.abort()
    await stopVoice($, await socketPath($))
    await update($, phase, () => 'idle')
    return
  }
  const mine = ++run
  active = mine
  stopRun = new AbortController()
  const signal = stopRun.signal
  const isCurrent = () => mine === run
  const finish = async () => {
    if (!isCurrent()) return
    stopRun.abort() // ends this run's audio watcher
    active = 0
    await update($, phase, () => 'idle')
  }

  try {
    await speak($, options, mine, signal)
  } finally {
    await finish()
  }
}

async function speak($: EngineInterface, options: PluginOptions, mine: number, signal: AbortSignal): Promise<void> {
  const isCurrent = () => mine === run
  const socket = await socketPath($)
  const selection = await $.ui.selection()
  const { blocks, isTruncated } = splitBlocks(selection?.text ?? '')
  if (blocks.length === 0) {
    $.ui.toast('Highlight some text first (talk2me needs fullscreen)')
    return
  }
  await update($, phase, () => 'processing')

  try {
    await ensureVoice($, socket, signal)
  } catch (error) {
    if (isCurrent()) $.ui.toast(`talk2me: ${(error as Error).message}`)
    return
  }
  if (isTruncated) $.ui.toast('Reading the first part only')

  const voice = String(options.voice ?? 'af_heart')
  const speed = Number(options.speed ?? 1)
  let isWatching = false
  for (const [i, block] of blocks.entries()) {
    const r = await rewriteBlock($, block, i === 0)
    if (!isCurrent()) return
    if ('error' in r) {
      $.ui.toast(`Couldn't rewrite the selection: ${r.error}`)
      await stopVoice($, socket)
      return
    }
    if (!r.text.trim()) continue
    await say($, socket, r.text, voice, speed)
    if (!isWatching) {
      isWatching = true
      void watchForAudio($, socket, isCurrent, signal).catch(() => undefined)
    }
  }

  while (isCurrent() && (await isBusy($, socket))) {
    await $.clock.sleep(500, { signal }).catch(() => undefined)
  }
}

// Flips the label from processing to speaking once sound actually comes out,
// while later blocks may still be rewriting.
async function watchForAudio($: EngineInterface, socket: string, isCurrent: () => boolean, signal: AbortSignal) {
  while (isCurrent() && !signal.aborted && (await read($, phase)) === 'processing') {
    if (await isAudible($, socket)) {
      if (isCurrent()) await update($, phase, () => 'speaking')
      return
    }
    await $.clock.sleep(300, { signal }).catch(() => undefined)
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'speak', description: 'Read the highlighted text aloud' })
    return started
  })

  // Not awaited: speaking outlasts a hook's time budget.
  on('command.run', { command: 'speak' }, $ => {
    void toggleSpeak($, options)
    return { text: '' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button } = $.ui.resolve(e)
    const now = await read($, phase)
    return (
      <Box>
        <Button
          key="speak"
          plain
          action={KEY_ACTION}
          label={now === 'speaking' ? '■ speaking…' : now === 'processing' ? '◌ processing…' : '▶ read aloud'}
          onPress={() => void toggleSpeak($, options)}
        />
      </Box>
    )
  })
}
