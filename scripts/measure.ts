// Usage: npx tsx scripts/measure.ts "<vault path>" [queries.json]   (BASE_URL env overrides the server)
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { chunkNote, isSkipped } from '../src/chunk'
import { BASE_URL, createEmbedder, docInput, MODEL, normalize, queryInput } from '../src/embed'
import { dot, VectorIndex } from '../src/index'

const vault = process.argv[2]
// Extra folders to leave out, comma-separated, like the plugin's skipFolders.
const SKIP = process.env.SKIP?.split(',') ?? []
if (!vault) throw new Error('usage: npx tsx scripts/measure.ts "<vault path>"')

const embedder = createEmbedder(async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  return { status: r.status, text: await r.text() }
}, process.env.BASE_URL ?? BASE_URL)

// Queries written without the target note's keywords. Any listed note in the top 5 counts as a hit.
// Format: [["query", ["Target note title", ...]], ...]. See scripts/queries.example.json.
const QUERIES: [string, string[]][] = JSON.parse(readFileSync(process.argv[3] ?? 'scripts/queries.json', 'utf8'))

const paths = (readdirSync(vault, { recursive: true }) as string[])
  .filter((p) => p.endsWith('.md') && !p.split('/').some((s) => s.startsWith('.')) && !isSkipped(p, SKIP))
const notes = paths.map((p) => ({ path: p, title: basename(p, '.md'), md: readFileSync(join(vault, p), 'utf8') }))

// A target that doesn't exist or has no text would make a miss meaningless.
const embeddable = new Set(notes.filter((n) => chunkNote(n.md).length).map((n) => n.title))
for (const [q, targets] of QUERIES)
  for (const t of targets) if (!embeddable.has(t)) console.warn(`warning: target "${t}" for "${q}" missing or empty`)

async function build(prefixed: boolean) {
  const ix768 = new VectorIndex(MODEL, 768)
  const ix256 = new VectorIndex(MODEL, 256)
  const byNote = new Map<string, Float32Array[]>()
  const t0 = Date.now()
  let chunks = 0
  let failed = 0
  for (const note of notes) {
    const cs = chunkNote(note.md)
    if (!cs.length) continue
    try {
      const vs = await embedder.embed(cs.map((c) => (prefixed ? docInput(note.title, c.text) : c.text)))
      ix768.setFile(note.path, 0, cs.map((c, i) => ({ heading: c.heading, vector: vs[i] })))
      ix256.setFile(note.path, 0, cs.map((c, i) => ({ heading: c.heading, vector: normalize(vs[i].subarray(0, 256)) })))
      byNote.set(note.path, vs)
      chunks += cs.length
    } catch (e) {
      failed++
      console.error('failed', note.path, (e as Error).message)
    }
  }
  const seconds = (Date.now() - t0) / 1000
  console.log(`\n[${prefixed ? 'prefixed' : 'no prefix'}] ${notes.length} notes, ${chunks} chunks, ${failed} failed, ${seconds.toFixed(0)}s, index.json ≈ ${(ix768.toJSON().length / 1e6).toFixed(1)}MB`)
  return { ix768, ix256, byNote }
}

async function hitAt5(name: string, ix: VectorIndex, prefixed: boolean, dims: number) {
  let hits = 0
  console.log(`\n${name}`)
  for (const [q, targets] of QUERIES) {
    const [full] = await embedder.embed([prefixed ? queryInput(q) : q])
    const v = dims < 768 ? normalize(full.subarray(0, dims)) : full
    // macOS can store accented filenames decomposed (NFD); compare in NFC.
    const top = ix.search(v, 5).map((h) => basename(h.path, '.md').normalize('NFC'))
    const ok = top.some((t) => targets.some((x) => x.normalize('NFC') === t))
    hits += Number(ok)
    console.log(`  ${ok ? '✓' : '✗'} ${q}\n      ${top.join(' | ')}`)
  }
  console.log(`  hit@5 = ${hits}/${QUERIES.length}`)
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)]
const pairScore = (a: Float32Array[], b: Float32Array[]) => Math.max(...a.flatMap((x) => b.map((y) => dot(x, y))))

// Same scoring as VectorIndex: subtract the mean of all chunks, then renormalize.
function centered(byNote: Map<string, Float32Array[]>) {
  const all = [...byNote.values()].flat()
  const mean = new Float32Array(all[0].length)
  for (const v of all) for (let i = 0; i < v.length; i++) mean[i] += v[i] / all.length
  return new Map([...byNote].map(([p, vs]) => [p, vs.map((v) => normalize(v.map((x, i) => x - mean[i])))]))
}

function scoreSpread(raw: Map<string, Float32Array[]>) {
  const byNote = centered(raw)
  const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n.path]))
  const linked: number[] = []
  for (const n of notes) {
    const a = byNote.get(n.path)
    if (!a) continue
    for (const m of n.md.matchAll(/\[\[([^\]|#]+)/g)) {
      const dest = byTitle.get(basename(m[1].trim()).toLowerCase())
      const b = dest && dest !== n.path ? byNote.get(dest) : undefined
      if (b) linked.push(pairScore(a, b))
    }
  }
  const keys = [...byNote.keys()]
  const random: number[] = []
  while (random.length < 500) {
    const a = keys[Math.floor(Math.random() * keys.length)]
    const b = keys[Math.floor(Math.random() * keys.length)]
    if (a !== b) random.push(pairScore(byNote.get(a)!, byNote.get(b)!))
  }
  const row = (name: string, xs: number[]) =>
    console.log(`  ${name.padEnd(8)} n=${String(xs.length).padEnd(5)} p10=${pct(xs, 0.1).toFixed(2)} p25=${pct(xs, 0.25).toFixed(2)} p50=${pct(xs, 0.5).toFixed(2)} p90=${pct(xs, 0.9).toFixed(2)} p95=${pct(xs, 0.95).toFixed(2)}`)
  console.log('\nnote-pair scores (best chunk pair, mean-centered)')
  row('linked', linked)
  row('random', random)
  console.log(`  suggested MIN_SCORE (linked p25) = ${pct(linked, 0.25).toFixed(2)}`)
}

const pre = await build(true)
await hitAt5('prefixed, 768 dims', pre.ix768, true, 768)
await hitAt5('prefixed, 256 dims', pre.ix256, true, 256)
scoreSpread(pre.byNote)
const raw = await build(false)
await hitAt5('no prefix, 768 dims', raw.ix768, false, 768)
