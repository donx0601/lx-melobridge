import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSearchQuery } from '../src/search-query.mjs'

test('plain search keeps aggregate mode', () => {
  assert.deepEqual(parseSearchQuery('七里香'), { query: '七里香', source: null, provider: null })
})

test('platform shorthand selects all five LX platform codes', () => {
  const cases = {
    'kw:七里香': ['七里香', 'kw'],
    '酷狗 七里香': ['七里香', 'kg'],
    '网易云: 七里香': ['七里香', 'wy'],
    'QQ:七里香': ['七里香', 'tx'],
    '咪咕 七里香': ['七里香', 'mg'],
  }
  for (const [input, expected] of Object.entries(cases)) {
    const result = parseSearchQuery(input)
    assert.equal(result.query, expected[0])
    assert.equal(result.source, expected[1])
  }
})

test('provider selector can choose a resolver adapter', () => {
  assert.deepEqual(parseSearchQuery('provider:sixyin kg:七里香'), {
    query: '七里香', source: 'kg', provider: 'sixyin',
  })
})
