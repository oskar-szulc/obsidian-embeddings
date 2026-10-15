import assert from 'node:assert/strict'
import { createEmbedder, docInput, EmbedError, queryInput } from '../src/embed'

// ---- embed ----
assert.equal(docInput('T', 'x'), 'title: T | text: x')
assert.equal(queryInput('q'), 'task: search result | query: q')

{
  const calls: string[][] = []
  // Fake server: vector [1, i, 0, ...] for input i, returned in reverse order to test sorting.
  const fake = (dims: number) => async (_url: string, body: string) => {
    const input = JSON.parse(body).input as string[]
    calls.push(input)
    const data = input.map((_, i) => ({ index: i, embedding: [1, i, ...Array(dims - 2).fill(0)] }))
    return { status: 200, text: JSON.stringify({ data: data.reverse() }) }
  }
  const vs = await createEmbedder(fake(768)).embed(Array.from({ length: 20 }, (_, i) => `doc ${i}`))
  assert.deepEqual(calls.map((c) => c.length), [16, 4])
  assert.equal(vs.length, 20)
  vs.forEach((v, i) => {
    assert.ok(Math.abs(v[1] / v[0] - (i % 16)) < 1e-4, `order ${i}`)
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-4, `normalized ${i}`)
  })

  await assert.rejects(createEmbedder(fake(512)).embed(['q']), (e: EmbedError) => e.fatal && /768/.test(e.message))
}

await assert.rejects(
  createEmbedder(async () => { throw new Error('ECONNREFUSED') }).embed(['q']),
  (e: EmbedError) => e.fatal && /not reachable/.test(e.message),
)
await assert.rejects(
  createEmbedder(async () => ({ status: 404, text: '{"error":"model not found"}' })).embed(['q']),
  (e: EmbedError) => e.fatal && /ollama create/.test(e.message),
)
await assert.rejects(
  createEmbedder(async () => ({ status: 500, text: 'boom' })).embed(['q']),
  (e: EmbedError) => !e.fatal,
)
await assert.rejects(
  createEmbedder(async () => ({ status: 200, text: '{"data":[]}' })).embed(['q']),
  (e: EmbedError) => !e.fatal && /1 inputs/.test(e.message),
)

console.log('embed ok')
