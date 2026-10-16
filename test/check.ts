import assert from 'node:assert/strict'
import { createEmbedder, docInput, EmbedError, queryInput } from '../src/embed'
import { chunkNote, isSkipped, MAX_CHUNK_CHARS } from '../src/chunk'
import { VectorIndex } from '../src/index'
import { addRelatedLink, findHubs } from '../src/related'

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

// ---- chunk ----
{
  const md = '---\nid: 1\n---\n# Title\nintro text\n## Housing\nrent is high\n### Sub\nmore\n## Empty\n\n## Related\n[[A]] • [[B]]\n## References\nhttp://x'
  const c = chunkNote(md)
  assert.deepEqual(c.map((x) => x.heading), ['', 'Housing'])
  assert.equal(c[0].text, '# Title\nintro text')
  assert.equal(c[1].text, 'rent is high\n### Sub\nmore')

  const fenced = chunkNote('## Code\n```md\n## not a heading\n```\nafter')
  assert.deepEqual(fenced.map((x) => x.heading), ['Code'])
  assert.ok(fenced[0].text.includes('## not a heading'))

  assert.equal(chunkNote('## Big\n' + 'x'.repeat(30000))[0].text.length, MAX_CHUNK_CHARS)
  assert.deepEqual(chunkNote('---\na: 1\n---\n\n## Related\n[[A]]'), [])
  assert.deepEqual(chunkNote('---\r\nid: 1\r\n---\r\nbody\r\n').map((x) => x.text), ['body'])

  assert.ok(isSkipped('Templates/idea.md'))
  assert.ok(isSkipped('Attachments/a.md'))
  assert.ok(isSkipped('.trash/x.md'))
  assert.ok(isSkipped('tools/node_modules/pkg/README.md'))
  assert.ok(!isSkipped('notes/Example.md'))
}
console.log('chunk ok')

// ---- index ----
{
  const v = (...xs: number[]) => Float32Array.from(xs)
  const ix = new VectorIndex('m', 2)
  ix.setFile('a.md', 1, [{ heading: '', vector: v(1, 0) }, { heading: 'H', vector: v(0, 1) }])
  ix.setFile('b.md', 1, [{ heading: '', vector: v(0.6, 0.8) }])
  ix.setFile('c.md', 1, [{ heading: '', vector: v(-1, 0) }])
  ix.setFile('empty.md', 1, [])

  assert.deepEqual(ix.search(v(0, 1), 2).map((h) => [h.path, h.heading]), [['a.md', 'H'], ['b.md', '']])

  const r = ix.related('a.md', 10, new Set())
  assert.deepEqual(r.map((h) => h.path), ['b.md', 'c.md'])
  assert.deepEqual(ix.related('a.md', 10, new Set(['b.md'])).map((h) => h.path), ['c.md'])

  assert.ok(ix.has('empty.md'))
  assert.equal(ix.chunkCount('a.md'), 2)
  assert.equal(ix.chunkCount('empty.md'), 0)
  assert.equal(ix.chunkCount('missing.md'), 0)
  assert.deepEqual(ix.related('empty.md', 10, new Set()), [], 'note without chunks has no related notes')
  assert.deepEqual(
    ix.stalePaths([{ path: 'a.md', mtime: 1 }, { path: 'b.md', mtime: 2 }, { path: 'd.md', mtime: 1 }, { path: 'empty.md', mtime: 1 }]),
    ['b.md', 'd.md'],
  )

  ix.setFile('a.md', 2, [{ heading: '', vector: v(1, 0) }])
  assert.equal(ix.search(v(0, 1), 10).find((h) => h.path === 'a.md')!.heading, '')

  const back = VectorIndex.parse(ix.toJSON(), 'm', 2)
  assert.deepEqual(back.search(v(1, 0), 10), ix.search(v(1, 0), 10))
  assert.deepEqual(back.stalePaths([{ path: 'a.md', mtime: 2 }]), [])
  assert.ok(!VectorIndex.parse(ix.toJSON(), 'other', 2).has('a.md'))
  assert.ok(!VectorIndex.parse(ix.toJSON(), 'm', 3).has('a.md'))
  assert.ok(!VectorIndex.parse('{bad', 'm', 2).has('a.md'))
  assert.ok(!VectorIndex.parse(null, 'm', 2).has('a.md'))

  ix.rename('b.md', 'x/b.md')
  assert.ok(ix.has('x/b.md') && !ix.has('b.md'))
  assert.equal(ix.search(v(0.6, 0.8), 1)[0].path, 'x/b.md')
  ix.remove('c.md')
  assert.ok(!ix.has('c.md') && !ix.search(v(-1, 0), 10).some((h) => h.path === 'c.md'))
  ix.prune(new Set(['a.md']))
  assert.ok(ix.has('a.md') && !ix.has('x/b.md') && !ix.has('empty.md'))
}
// Centering: a direction every vector shares adds nothing, so a shared offset leaves results unchanged.
{
  const base = [[1, 0, 0], [0.9, 0.3, 0.1], [0, 1, 0.2], [0.1, 0.2, 1]]
  const offset = [5, 5, 5]
  const build = (shift: number) => {
    const ix = new VectorIndex('m', 3)
    base.forEach((b, i) => ix.setFile(`${i}.md`, 1, [{ heading: '', vector: Float32Array.from(b, (x, d) => x + shift * offset[d]) }]))
    return ix
  }
  const [plain, shifted] = [build(0), build(1)]
  const q = (shift: number) => Float32Array.from([0, 0.9, 0.3], (x, d) => x + shift * offset[d])
  const close = (a: { path: string; score: number }[], b: typeof a) =>
    a.length === b.length && a.every((h, i) => h.path === b[i].path && Math.abs(h.score - b[i].score) < 1e-5)
  assert.ok(close(shifted.related('0.md', 10, new Set()), plain.related('0.md', 10, new Set())), 'related ignores shared offset')
  assert.ok(close(shifted.search(q(1), 10), plain.search(q(0), 10)), 'search ignores shared offset')
}
// related() names the section of the open note behind each match.
{
  const ix = new VectorIndex('m', 3)
  ix.setFile('a.md', 1, [{ heading: 'X', vector: Float32Array.of(1, 0, 0) }, { heading: 'Y', vector: Float32Array.of(0, 1, 0) }])
  ix.setFile('b.md', 1, [{ heading: 'B', vector: Float32Array.of(0, 1, 0.1) }])
  ix.setFile('c.md', 1, [{ heading: '', vector: Float32Array.of(0, 0, 1) }])
  const b = ix.related('a.md', 10, new Set()).find((h) => h.path === 'b.md')!
  assert.deepEqual([b.from, b.heading], ['Y', 'B'])
}
console.log('index ok')

// ---- related ----
assert.equal(addRelatedLink('# T\nbody', 'X'), '# T\nbody\n\n## Related\n[[X]]\n')
assert.equal(addRelatedLink('# T\nbody\n\n', 'X'), '# T\nbody\n\n## Related\n[[X]]\n')
assert.equal(addRelatedLink('# T\n\n## References\nhttp://a', 'X'), '# T\n\n## Related\n[[X]]\n\n## References\nhttp://a')
assert.equal(addRelatedLink('## Related\n[[A]] • [[B]]\n', 'X'), '## Related\n[[A]] • [[B]] • [[X]]\n')
assert.equal(addRelatedLink('## Related\n\n## References\nr', 'X'), '## Related\n[[X]]\n\n## References\nr')
assert.equal(addRelatedLink('## Related\nSee also:\n', 'X'), '## Related\n[[X]]\nSee also:\n')
for (const md of ['## Related\n[[X]]', '## Related\n[[x|alias]]', '## Related\n[[X#Part]]'])
  assert.equal(addRelatedLink(md, 'X'), md, `duplicate: ${md}`)
assert.equal(addRelatedLink('## Related\n[[A]]\n## Other\n[[X]]', 'X'), '## Related\n[[A]] • [[X]]\n## Other\n[[X]]')
{
  const notes = Array.from({ length: 10 }, (_, i) => `n${i}.md`)
  const to = (ps: string[]) => Object.fromEntries(ps.map((p) => [p, 1]))
  const links: Record<string, Record<string, number>> = {
    'hub.md': to(notes),
    'busy.md': to([...notes, 'a.png', 'b.png']),
    'wide.md': to(notes.slice(0, 9).concat('img.png')),
  }
  for (const n of notes.slice(0, 5)) links[n] = to(['hub.md', 'wide.md'])
  links['n5.md'] = to(['busy.md', 'busy.png'])
  // hub: 10 out, 5 in. busy: 10 notes out (images don't count) but 1 in. wide: 5 in but only 9 notes out.
  assert.deepEqual([...findHubs(links)], ['hub.md'])
}
console.log('related ok')
