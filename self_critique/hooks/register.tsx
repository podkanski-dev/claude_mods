import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Critique, ModelChoice } from '../types'
import { FORK_PROMPT, RUBRIC, fixPrompt, parseCritique, transcript } from './critique'

const PANE = 'self-critique'
const critique = atom({ plugin: 'self-critique', key: 'critique' } as const, null as Critique | null)
const isRunning = atom({ plugin: 'self-critique', key: 'isRunning' } as const, false)
const error = atom({ plugin: 'self-critique', key: 'error' } as const, null as string | null)
const isAuto = atom({ plugin: 'self-critique', key: 'isAuto' } as const, false)
const model = atom({ plugin: 'self-critique', key: 'model' } as const, 'session' as ModelChoice)

const MODELS: [ModelChoice, string][] = [
  ['session', 'Same as session'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
]
const VERDICT_COLOR = { Strong: 'success', Mixed: 'warning', Weak: 'error' } as const

let run = 0

async function critiqueNow($: EngineInterface) {
  const mine = ++run
  await update($, isRunning, () => true)
  await update($, error, () => null)
  const choice = await read($, model)

  let reply
  if (choice === 'session') {
    reply = await $.model.fork({ prompt: FORK_PROMPT })
  } else {
    const conversation = transcript(await $.session.messages())
    reply = conversation
      ? await $.model.complete({
          model: choice,
          system: `You review an AI coding assistant's work. You get the whole conversation; review only the assistant's final text reply (the last [assistant] message), using the earlier conversation as context.\n${RUBRIC}`,
          prompt: `<conversation>\n${conversation}\n</conversation>`,
        })
      : ({ isAnswered: false, reason: 'no response to review yet' } as const)
  }
  if (mine !== run) return

  const parsed = reply.isAnswered ? parseCritique(reply.text) : null
  if (parsed) await update($, critique, () => parsed)
  await update($, error, () =>
    parsed ? null : reply.isAnswered ? 'The reviewer did not return valid JSON.' : `No review: ${reply.reason}`,
  )
  await update($, isRunning, () => false)
}

// Off the calling dispatch, so a turn ending or a press settling doesn't cut the review.
function start($: EngineInterface) {
  $.clock.after(250, () => void critiqueNow($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'critique',
      description: "Review Claude's last response in a side panel",
    })

    return next(e)
  })

  on('command.run', { command: 'critique' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Self-Critique' })
    start($)

    return { text: 'Reviewing the last response…' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && (await read($, isAuto))) {
      void $.ui.open({ id: PANE, title: 'Self-Critique' })
      start($)
    }

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [result, running, failed, auto, picked] = await Promise.all([
      read($, critique),
      read($, isRunning),
      read($, error),
      read($, isAuto),
      read($, model),
    ])

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="rerun" label={running ? 'Reviewing…' : 'Rerun'} hotkey="r" onPress={() => void start($)} />
          <Button
            key="auto"
            label={`Auto: ${auto ? 'on' : 'off'}`}
            hotkey="a"
            onPress={() => update($, isAuto, v => !v)}
          />
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text dimColor>Model:</Text>
          {MODELS.map(([id, label]) => (
            <Button key={`model-${id}`} label={`${picked === id ? '●' : '○'} ${label}`} onPress={() => update($, model, () => id)} />
          ))}
        </Box>

        {failed && <Text color="error">{failed}</Text>}
        {!result && !running && !failed && <Text dimColor>No review yet. Press Rerun.</Text>}

        {result && (
          <Box flexDirection="column" gap={1}>
            <Text bold color={VERDICT_COLOR[result.verdict]}>
              {result.verdict}
            </Text>
            <Text>{result.summary}</Text>

            <Box flexDirection="column">
              <Text bold>Strengths</Text>
              {result.strengths.length === 0 && <Text dimColor>None noted.</Text>}
              {result.strengths.map(s => (
                <Text color="success">+ {s}</Text>
              ))}
            </Box>

            <Box flexDirection="column" gap={1}>
              <Text bold>Flaws</Text>
              {result.flaws.length === 0 && <Text dimColor>None found.</Text>}
              {result.flaws.map((f, i) => (
                <Box key={`flaw-${i}`} flexDirection="column">
                  <Text color="error">- {f.issue}</Text>
                  <Text dimColor>Fix: {f.fix}</Text>
                  <Button
                    key={`fix-${i}`}
                    label="Make this fix"
                    hotkey={i < 9 ? String(i + 1) : undefined}
                    onPress={async () => {
                      await $.prompt.submit({ text: fixPrompt(f.issue, f.fix), asUser: true })
                      $.ui.toast('Fix sent to Claude')
                    }}
                  />
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
