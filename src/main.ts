import { debounce, Notice, Plugin, requestUrl, TAbstractFile, TFile } from 'obsidian'
import { chunkNote, isSkipped } from './chunk'
import { createEmbedder, DIMS, docInput, EmbedError, MODEL, type Transport } from './embed'
import { VectorIndex } from './index'
import { RelatedView, SearchModal, VIEW_TYPE } from './views'

// requestUrl skips CORS, so fetch's origin restrictions don't apply here.
const transport: Transport = async (url, body) => {
  const r = await requestUrl({ url, method: 'POST', contentType: 'application/json', body, throw: false })
  return { status: r.status, text: r.text }
}

export default class EmbeddingsPlugin extends Plugin {
  index = new VectorIndex(MODEL, DIMS)
  embedder = createEmbedder(transport)
  error: string | null = null
  // Vault-specific folders to leave out (templates, attachments), from data.json: { "skipFolders": [...] }.
  skipFolders: string[] = []
  private queue = new Set<string>()
  private running = false
  private timers = new Map<string, number>()
  private dirty = false
  // index.json is ~15MB inside an iCloud-synced vault: small changes are batched into one write.
  private scheduleSave = debounce(() => void this.saveIndex(), 30000, true)

  private get indexPath() {
    return `${this.manifest.dir}/index.json`
  }

  async onload() {
    this.skipFolders = (await this.loadData())?.skipFolders ?? []
    this.registerView(VIEW_TYPE, (leaf) => new RelatedView(leaf, this))
    this.addCommand({ id: 'open-related', name: 'Open related notes', callback: () => void this.openRelated() })
    this.addCommand({ id: 'semantic-search', name: 'Semantic search', callback: () => new SearchModal(this.app, this).open() })
    this.addCommand({ id: 'rebuild-index', name: 'Rebuild index', callback: () => this.rebuild() })

    this.app.workspace.onLayoutReady(async () => {
      this.index = await this.loadIndex()
      const vault = this.app.vault
      this.registerEvent(vault.on('create', (f) => this.schedule(f)))
      this.registerEvent(vault.on('modify', (f) => this.schedule(f)))
      this.registerEvent(vault.on('delete', (f) => {
        this.index.remove(f.path)
        this.dirty = true
        this.scheduleSave()
      }))
      this.registerEvent(vault.on('rename', (f, old) => this.onRename(f, old)))
      this.registerEvent(this.app.workspace.on('file-open', () => this.refreshView()))
      this.enqueueStale()
    })
  }

  onunload() {
    for (const t of this.timers.values()) window.clearTimeout(t)
    this.scheduleSave.run()
  }

  refreshView() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as RelatedView).render()
  }

  private async openRelated() {
    const { workspace } = this.app
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0]
    if (!leaf) {
      const right = workspace.getRightLeaf(false)
      if (!right) return
      await right.setViewState({ type: VIEW_TYPE, active: true })
      leaf = right
    }
    workspace.revealLeaf(leaf)
  }

  // Debounced per path: re-embed 2 s after the last change.
  private schedule(f: TAbstractFile) {
    if (!(f instanceof TFile) || f.extension !== 'md' || isSkipped(f.path, this.skipFolders)) return
    window.clearTimeout(this.timers.get(f.path))
    this.timers.set(f.path, window.setTimeout(() => {
      this.timers.delete(f.path)
      this.queue.add(f.path)
      void this.run()
    }, 2000))
  }

  // Every chunk is embedded with the note's title, so a renamed note gets new vectors. Until they arrive,
  // the old ones move to the new path so the sidebar keeps working.
  private onRename(f: TAbstractFile, oldPath: string) {
    if (!(f instanceof TFile) || f.extension !== 'md') return
    if (!isSkipped(f.path, this.skipFolders)) {
      this.index.rename(oldPath, f.path)
      return this.schedule(f)
    }
    this.index.remove(oldPath)
    this.dirty = true
    this.scheduleSave()
  }

  // Also catches deletes and renames made while Obsidian was closed.
  private enqueueStale() {
    const files = this.app.vault.getMarkdownFiles().filter((f) => !isSkipped(f.path, this.skipFolders))
    this.index.prune(new Set(files.map((f) => f.path)))
    for (const p of this.index.stalePaths(files.map((f) => ({ path: f.path, mtime: f.stat.mtime })))) this.queue.add(p)
    void this.run()
  }

  private rebuild() {
    this.index = new VectorIndex(MODEL, DIMS)
    this.queue.clear()
    this.enqueueStale()
  }

  private async run() {
    if (this.running) return
    this.running = true
    const notice = this.queue.size > 20 ? new Notice('Indexing…', 0) : null
    let done = 0
    try {
      while (this.queue.size) {
        const path = this.queue.values().next().value as string
        this.queue.delete(path)
        const file = this.app.vault.getAbstractFileByPath(path)
        if (file instanceof TFile) {
          try {
            await this.indexFile(file)
          } catch (e) {
            if (e instanceof EmbedError && e.fatal) {
              // Keep the path queued. The next file event or "Rebuild index" retries.
              this.queue.add(path)
              if (this.error !== e.message) new Notice(e.message, 10000)
              this.error = e.message
              break
            }
            console.error('[embeddings]', path, e)
          }
        }
        done++
        notice?.setMessage(`Indexing ${done}/${done + this.queue.size}…`)
        if (done % 50 === 0) await this.saveIndex()
      }
    } finally {
      notice?.hide()
      this.running = false
      if (done > 50) await this.saveIndex()
      else this.scheduleSave()
      this.refreshView()
    }
  }

  private async indexFile(file: TFile) {
    const mtime = file.stat.mtime
    const chunks = chunkNote(await this.app.vault.read(file))
    const vectors = chunks.length ? await this.embedder.embed(chunks.map((c) => docInput(file.basename, c.text))) : []
    this.index.setFile(file.path, mtime, chunks.map((c, i) => ({ heading: c.heading, vector: vectors[i] })))
    this.dirty = true
    this.error = null
  }

  private async loadIndex() {
    const { adapter } = this.app.vault
    const json = (await adapter.exists(this.indexPath)) ? await adapter.read(this.indexPath) : null
    return VectorIndex.parse(json, MODEL, DIMS)
  }

  // Skips unchanged indexes, so a failed rebuild doesn't overwrite the saved one with an empty index.
  // ponytail: still rewrites the whole file (~15MB) per save; switch to int8 vectors if iCloud sync suffers.
  private async saveIndex() {
    if (!this.dirty) return
    this.dirty = false
    await this.app.vault.adapter.write(this.indexPath, this.index.toJSON())
  }
}
