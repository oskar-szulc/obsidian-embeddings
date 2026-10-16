import { normalize } from './embed'

export interface Hit {
  path: string
  heading: string
  score: number
}

export interface FileStamp {
  path: string
  mtime: number
}

interface StoredChunk {
  path: string
  heading: string
  vector: Float32Array
}

// Scoring vectors are normalized, so the dot product is cosine similarity.
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

const encode = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
// Copy into a fresh buffer: Buffer.from(base64) can sit at an offset not aligned to 4 bytes.
const decode = (s: string) => new Float32Array(Uint8Array.from(Buffer.from(s, 'base64')).buffer)

// ponytail: brute-force scan, fine for a few thousand chunks; add an ANN index past ~100K.
export class VectorIndex {
  private files = new Map<string, number>()
  private chunks: StoredChunk[] = []
  // Embeddings share one large direction (mean vector length 0.79 on my vault), so raw cosine rates every
  // pair as similar. Scoring subtracts the mean of all chunks and renormalizes; disk keeps raw vectors.
  private mean = new Float32Array(0)
  private centered: Map<StoredChunk, Float32Array> | null = null

  constructor(readonly model: string, readonly dims: number) {}

  static parse(json: string | null, model: string, dims: number): VectorIndex {
    const ix = new VectorIndex(model, dims)
    if (!json) return ix
    try {
      const d = JSON.parse(json)
      if (d.model !== model || d.dims !== dims) return ix
      for (const [path, f] of Object.entries(d.files as Record<string, { mtime: number }>)) ix.files.set(path, f.mtime)
      ix.chunks = (d.chunks as { path: string; heading: string; vector: string }[]).map((c) => {
        const vector = decode(c.vector)
        if (vector.length !== dims) throw new Error('bad vector length')
        return { path: c.path, heading: c.heading, vector }
      })
      return ix
    } catch {
      return new VectorIndex(model, dims)
    }
  }

  toJSON(): string {
    return JSON.stringify({
      model: this.model,
      dims: this.dims,
      files: Object.fromEntries([...this.files].map(([path, mtime]) => [path, { mtime }])),
      chunks: this.chunks.map((c) => ({ path: c.path, heading: c.heading, vector: encode(c.vector) })),
    })
  }

  has(path: string) {
    return this.files.has(path)
  }

  chunkCount(path: string) {
    return this.chunks.filter((c) => c.path === path).length
  }

  setFile(path: string, mtime: number, chunks: { heading: string; vector: Float32Array }[]) {
    this.files.set(path, mtime)
    this.chunks = this.chunks.filter((c) => c.path !== path).concat(chunks.map((c) => ({ path, ...c })))
    this.centered = null
  }

  remove(path: string) {
    this.files.delete(path)
    this.chunks = this.chunks.filter((c) => c.path !== path)
    this.centered = null
  }

  rename(oldPath: string, newPath: string) {
    const mtime = this.files.get(oldPath)
    if (mtime === undefined) return
    this.files.delete(oldPath)
    this.files.set(newPath, mtime)
    for (const c of this.chunks) if (c.path === oldPath) c.path = newPath
  }

  prune(existing: Set<string>) {
    for (const path of [...this.files.keys()]) if (!existing.has(path)) this.remove(path)
  }

  stalePaths(files: FileStamp[]): string[] {
    return files.filter((f) => this.files.get(f.path) !== f.mtime).map((f) => f.path)
  }

  search(query: Float32Array, k: number): Hit[] {
    const cv = this.centeredVectors()
    const q = this.center(query)
    return this.rank(this.chunks, (c) => dot(q, cv.get(c)!), k)
  }

  related(path: string, k: number, exclude: Set<string>): Hit[] {
    const own = this.chunks.filter((c) => c.path === path)
    if (!own.length) return []
    const others = this.chunks.filter((c) => c.path !== path && !exclude.has(c.path))
    const cv = this.centeredVectors()
    return this.rank(others, (c) => Math.max(...own.map((o) => dot(cv.get(o)!, cv.get(c)!))), k)
  }

  private center(v: Float32Array) {
    return normalize(v.map((x, i) => x - this.mean[i]))
  }

  // ponytail: full recompute after any change, a few ms for a few thousand chunks; keep a running sum if that grows.
  private centeredVectors() {
    if (!this.centered) {
      this.mean = new Float32Array(this.dims)
      for (const c of this.chunks) for (let i = 0; i < this.dims; i++) this.mean[i] += c.vector[i] / this.chunks.length
      this.centered = new Map(this.chunks.map((c) => [c, this.center(c.vector)]))
    }
    return this.centered
  }

  // Best-scoring chunk per note, highest first.
  private rank(chunks: StoredChunk[], score: (c: StoredChunk) => number, k: number): Hit[] {
    const best = new Map<string, Hit>()
    for (const c of chunks) {
      const s = score(c)
      const b = best.get(c.path)
      if (!b || s > b.score) best.set(c.path, { path: c.path, heading: c.heading, score: s })
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k)
  }
}
