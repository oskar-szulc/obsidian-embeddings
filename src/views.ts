import { App, ItemView, Notice, SuggestModal, TFile, WorkspaceLeaf } from 'obsidian'
import type EmbeddingsPlugin from './main'
import { EmbedError, queryInput } from './embed'
import type { Hit } from './index'
import { addRelatedLink, findHubs } from './related'

export const VIEW_TYPE = 'embeddings-related'
// 25th percentile of linked-note pair scores after mean-centering (2026-10-15; linked median 0.48, random
// median 0.13). Before centering it was 0.76, and random pairs at p95 scored above the linked median.
export const MIN_SCORE = 0.37
// Above this, notes are copies of each other (tailored versions of one document, daily snapshots), not
// suggestions. On my vault, tailored versions pair at 0.87-0.89; the closest real suggestion is 0.85.
export const NEAR_COPY = 0.86

export const label = (hit: Hit) =>
  hit.path.replace(/\.md$/, '').split('/').pop()! + (hit.heading ? ` › ${hit.heading}` : '')

export class RelatedView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: EmbeddingsPlugin) {
    super(leaf)
  }

  getViewType() {
    return VIEW_TYPE
  }

  getDisplayText() {
    return 'Related notes'
  }

  getIcon() {
    return 'sparkles'
  }

  async onOpen() {
    this.render()
  }

  // Debug ignores MIN_SCORE and dims rows below it. Lives as long as the view.
  private debug = false

  render() {
    const el = this.contentEl
    el.empty()
    const toggle = el.createEl('label', { cls: 'embeddings-debug' })
    const box = toggle.createEl('input', { type: 'checkbox' })
    box.checked = this.debug
    box.onchange = () => {
      this.debug = box.checked
      this.render()
    }
    toggle.appendText(' Debug')
    // Returns the most recently active note even while the sidebar has focus.
    const file = this.app.workspace.getActiveFile()
    const { index, error } = this.plugin
    if (!file) return void el.createEl('p', { text: 'No note open.' })
    // Related notes come from stored vectors, so they keep working while the server is down.
    if (error) el.createEl('p', { text: error, cls: 'embeddings-error' })
    if (!index.has(file.path)) return void el.createEl('p', { text: 'Not indexed yet.' })

    const linked = new Set(Object.keys(this.app.metadataCache.resolvedLinks[file.path] ?? {}))
    const chunks = index.chunkCount(file.path)
    if (this.debug)
      el.createEl('p', { text: `${chunks} chunks · ${linked.size} linked (hidden) · threshold ${MIN_SCORE}`, cls: 'embeddings-debug' })
    if (!chunks) return void el.createEl('p', { text: 'This note has no text to embed.' })

    const hubs = findHubs(this.app.metadataCache.resolvedLinks)
    const all = index.related(file.path, Infinity, linked)
    // Notes that link to no hub get the closest one as "where this belongs". Measured on my vault,
    // the closest hub above MIN_SCORE is a hub the note already links to 89% of the time.
    const hub = hubs.has(file.path) || [...linked].some((p) => hubs.has(p))
      ? undefined
      : all.find((h) => hubs.has(h.path) && h.score >= MIN_SCORE)
    const copies = all.filter((h) => h.score >= NEAR_COPY)
    const rest = all.filter((h) => h.score < NEAR_COPY && h !== hub).slice(0, 10)
    const hits = this.debug ? rest : rest.filter((h) => h.score >= MIN_SCORE)

    if (hub) {
      el.createDiv({ text: 'Belongs under', cls: 'embeddings-debug' })
      this.row(el, hub, file, chunks)
      el.createDiv({ text: 'Related', cls: 'embeddings-debug embeddings-divider' })
    }
    if (!hits.length && !copies.length)
      return void el.createEl('p', { text: `No related notes above ${MIN_SCORE}. Turn on Debug to see the closest ones.` })

    let divider = false
    for (const hit of hits) {
      const below = hit.score < MIN_SCORE
      if (below && !divider) {
        el.createDiv({ text: `— below ${MIN_SCORE} —`, cls: 'embeddings-debug embeddings-divider' })
        divider = true
      }
      this.row(el, hit, file, chunks, below)
    }

    if (copies.length) {
      const line = el.createDiv({ text: `Near-copies (${copies.length}): `, cls: 'embeddings-debug embeddings-copies' })
      copies.slice(0, 5).forEach((h, i) => {
        if (i) line.appendText(', ')
        this.link(line, h.path, label(h), file)
      })
      if (copies.length > 5) line.appendText(', …')
    }
  }

  private link(parent: HTMLElement, path: string, text: string, from: TFile) {
    const a = parent.createEl('a', { text, cls: 'embeddings-name', href: '#' })
    a.onclick = (e) => {
      e.preventDefault()
      void this.app.workspace.openLinkText(path, from.path)
    }
    return a
  }

  private row(el: HTMLElement, hit: Hit, file: TFile, chunks: number, below = false) {
    const row = el.createDiv({ cls: below ? 'embeddings-row embeddings-below' : 'embeddings-row' })
    const name = this.link(row, hit.path, label(hit), file)
    // Which part of the open note this match came from; the intro chunk has no heading.
    if (chunks > 1) name.createDiv({ text: `↳ from ${hit.from || 'intro'}`, cls: 'embeddings-from' })
    row.createSpan({ text: hit.score.toFixed(2), cls: 'embeddings-score' })
    const add = row.createEl('button', { text: '＋', attr: { 'aria-label': 'Add to Related' } })
    add.onclick = async () => {
      const target = this.app.vault.getAbstractFileByPath(hit.path)
      if (!(target instanceof TFile)) return
      const link = this.app.metadataCache.fileToLinktext(target, file.path, true)
      await this.app.vault.process(file, (md) => addRelatedLink(md, link))
      row.remove()
    }
  }
}

export class SearchModal extends SuggestModal<Hit> {
  private seq = 0
  private last: Hit[] = []

  constructor(app: App, private plugin: EmbeddingsPlugin) {
    super(app)
    this.setPlaceholder('Search notes by meaning…')
  }

  // Called on every keystroke. Only the newest query, 300 ms after typing stops, gets embedded.
  async getSuggestions(query: string): Promise<Hit[]> {
    const id = ++this.seq
    if (!query.trim()) return (this.last = [])
    await new Promise((r) => window.setTimeout(r, 300))
    if (id !== this.seq) return this.last
    try {
      const [v] = await this.plugin.embedder.embed([queryInput(query)])
      if (id === this.seq) this.last = this.plugin.index.search(v, 20)
    } catch (e) {
      if (id === this.seq) new Notice(e instanceof EmbedError ? e.message : String(e))
    }
    return this.last
  }

  renderSuggestion(hit: Hit, el: HTMLElement) {
    el.createDiv({ text: label(hit) })
    el.createEl('small', { text: hit.score.toFixed(2), cls: 'embeddings-score' })
  }

  onChooseSuggestion(hit: Hit) {
    const target = hit.path.replace(/\.md$/, '') + (hit.heading ? `#${hit.heading}` : '')
    void this.app.workspace.openLinkText(target, '')
  }
}
