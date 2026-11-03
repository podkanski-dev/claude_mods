import { expect, test } from 'claude-code/testing'

import { REWRITE_SYSTEM } from '../hooks/rewrite'

test('the system prompt carries every rewrite rule', () => {
  for (const part of ['never summar', 'box-drawing', 'table', 'code', 'English']) {
    expect(REWRITE_SYSTEM).toContain(part)
  }
})
