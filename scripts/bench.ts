// Brute-force search timing on synthetic vectors (numbers for the post).
import { normalize } from '../src/embed'
import { VectorIndex } from '../src/index'

const rand = () => normalize(Array.from({ length: 768 }, () => Math.random() - 0.5))
const ix = new VectorIndex('bench', 768)
for (let n = 0; n < 700; n++) ix.setFile(`n${n}.md`, 0, Array.from({ length: 5 }, (_, i) => ({ heading: `h${i}`, vector: rand() })))
const q = rand()
for (let i = 0; i < 20; i++) ix.search(q, 20)
let t = performance.now()
for (let i = 0; i < 100; i++) ix.search(q, 20)
console.log(`search over 3500 chunks: ${((performance.now() - t) / 100).toFixed(2)} ms`)
t = performance.now()
for (let i = 0; i < 20; i++) ix.related('n0.md', 10, new Set())
console.log(`related (5 chunks vs 3500): ${((performance.now() - t) / 20).toFixed(2)} ms`)
const json = ix.toJSON()
console.log(`index.json: ${(json.length / 1e6).toFixed(1)} MB base64 vs ${(JSON.stringify(Array.from({ length: 3500 }, () => Array.from(rand()))).length / 1e6).toFixed(1)} MB as JSON numbers`)
