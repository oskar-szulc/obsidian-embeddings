// Vault convention: one "## Related" line of [[links]] separated by " • ".
export function addRelatedLink(markdown: string, target: string): string {
  const link = `[[${target}]]`
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => /^## Related\s*$/.test(l))

  if (start !== -1) {
    let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l))
    if (end === -1) end = lines.length
    const section = lines.slice(start + 1, end)
    const t = target.toLowerCase()
    // [[x]], [[x|alias]] and [[x#heading]] all count as already linked.
    const present = (l: string) => [']]', '|', '#'].some((end) => l.toLowerCase().includes(`[[${t}${end}`))
    if (section.some(present)) return markdown
    const first = section.findIndex((l) => l.trim() !== '')
    if (first !== -1 && section[first].includes('[[')) lines[start + 1 + first] = `${section[first].trimEnd()} • ${link}`
    else lines.splice(start + 1, 0, link)
    return lines.join('\n')
  }

  const refs = lines.findIndex((l) => /^## References\s*$/.test(l))
  if (refs !== -1) {
    lines.splice(refs, 0, '## Related', link, '')
    return lines.join('\n')
  }
  return `${markdown.replace(/\s*$/, '')}\n\n## Related\n${link}\n`
}
