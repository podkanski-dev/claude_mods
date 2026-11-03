import { expect, test } from 'claude-code/testing'

import { splitBlocks } from '../hooks/blocks'

const TABLE = '┌──────┬─────┐\n│ Name │ Fit │\n├──────┼─────┤\n│ A    │ yes │\n\n│ B    │ no  │\n└──────┴─────┘'

test('paragraphs split on blank lines', () => {
  expect(splitBlocks('One.\n\nTwo.\nStill two.').blocks).toEqual(['One.', 'Two.\nStill two.'])
})

test('a drawn table stays one block, blank rows included', () => {
  expect(splitBlocks(`Intro.\n\n${TABLE}\n\nAfter.`).blocks).toEqual(['Intro.', TABLE, 'After.'])
})

test('long input is cut at a block boundary', () => {
  const r = splitBlocks('a'.repeat(10) + '\n\n' + 'b'.repeat(10), 15)
  expect(r).toEqual({ blocks: ['a'.repeat(10)], isTruncated: true })
})

test('empty or whitespace-only input yields no blocks', () => {
  expect(splitBlocks('  \n\n ').blocks).toEqual([])
})
