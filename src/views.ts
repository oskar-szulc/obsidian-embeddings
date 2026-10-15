import { ItemView, TFile, WorkspaceLeaf } from 'obsidian'
import type EmbeddingsPlugin from './main'
import type { Hit } from './index'
import { addRelatedLink } from './related'

export const VIEW_TYPE = 'embeddings-related'
// Starting guess. Task 8 replaces it with a value measured on the vault.
export const MIN_SCORE = 0.5

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

  render() {
    const el = this.contentEl
    el.empty()
    // Returns the most recently active note even while the sidebar has focus.
    const file = this.app.workspace.getActiveFile()
    const { index, error } = this.plugin
    if (error) return void el.createEl('p', { text: error })
    if (!file) return void el.createEl('p', { text: 'No note open.' })
    if (!index.has(file.path)) return void el.createEl('p', { text: 'Not indexed yet.' })

    const linked = new Set(Object.keys(this.app.metadataCache.resolvedLinks[file.path] ?? {}))
    const hits = index.related(file.path, 10, linked).filter((h) => h.score >= MIN_SCORE)
    if (!hits.length) return void el.createEl('p', { text: 'No related notes found.' })

    for (const hit of hits) {
      const row = el.createDiv({ cls: 'embeddings-row' })
      const name = row.createEl('a', { text: label(hit), cls: 'embeddings-name', href: '#' })
      name.onclick = (e) => {
        e.preventDefault()
        void this.app.workspace.openLinkText(hit.path, file.path)
      }
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
}
