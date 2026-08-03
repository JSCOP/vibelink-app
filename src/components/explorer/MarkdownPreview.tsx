import { invoke } from '@tauri-apps/api/core'
import MarkdownIt from 'markdown-it'
import { useEffect, useMemo, useRef } from 'react'
import { parentPath } from '../../state/explorer'
import { IMAGE_MIME_BY_EXTENSION } from './previewFileTypes'
import './MarkdownPreview.css'

const markdown = new MarkdownIt({ html: false, linkify: false })
const defaultLinkOpen = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const token = tokens[index]
  const href = token.attrGet('href')
  if (href !== null && !isSafeHref(String(href))) {
    const attributeIndex = token.attrIndex('href')
    if (attributeIndex >= 0) token.attrs?.splice(attributeIndex, 1)
  }
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, environment, renderer)
    : renderer.renderToken(tokens, index, options)
}

let mermaidRenderId = 0

export function MarkdownPreview({ content, workspaceFolder, relPath }: { content: string; workspaceFolder: string; relPath: string }) {
  const root = useRef<HTMLDivElement>(null)
  const html = useMemo(() => markdown.render(content), [content])

  useEffect(() => {
    let cancelled = false
    const images = [...(root.current?.querySelectorAll('img') ?? [])].slice(0, 20)
    for (const image of images) {
      const source = image.getAttribute('src')
      const imagePath = source ? resolveImagePath(parentPath(relPath), source) : null
      const extension = imagePath?.split('.').pop()?.toLowerCase() ?? ''
      const mime = IMAGE_MIME_BY_EXTENSION[extension]
      if (!imagePath || !mime) continue
      void invoke<string>('fs_read_image', { workspaceFolder, relPath: imagePath }).then((base64) => {
        if (!cancelled && root.current?.contains(image)) image.src = `data:${mime};base64,${base64}`
      }).catch(() => undefined)
    }
    return () => { cancelled = true }
  }, [html, relPath, workspaceFolder])

  // Mermaid is ~1MB of graph layout code, so it only loads for documents that
  // actually contain a mermaid fence. A failed diagram keeps its source block.
  useEffect(() => {
    const blocks = [...(root.current?.querySelectorAll('pre > code.language-mermaid') ?? [])]
    if (blocks.length === 0) return
    let cancelled = false
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', flowchart: { htmlLabels: false, useMaxWidth: true } })
      for (const block of blocks) {
        const host = block.parentElement
        if (cancelled || !host || !root.current?.contains(host)) return
        try {
          const { svg } = await mermaid.render(`markdown-mermaid-${mermaidRenderId += 1}`, block.textContent ?? '')
          if (cancelled || !root.current?.contains(host)) return
          const figure = document.createElement('div')
          figure.className = 'markdown-mermaid'
          figure.innerHTML = svg
          host.replaceWith(figure)
          fitDiagramToContent(figure.firstElementChild)
        } catch {
          // Keep the unrenderable diagram readable as its own source.
        }
      }
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [html])

  return <div ref={root} className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />
}

function isSafeHref(href: string): boolean {
  const value = href.trim()
  return /^(https?:|mailto:)/i.test(value)
    || (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('//'))
}

// Mermaid derives its canvas from its own text measurements, which overshoot by
// several times under software rendering. Refit the live SVG to the bounding box
// the browser actually laid out so the diagram fills the pane instead of sitting
// in one corner of a mostly empty box.
function fitDiagramToContent(element: Element | null): void {
  if (!(element instanceof SVGSVGElement)) return
  const box = element.getBBox()
  if (box.width <= 0 || box.height <= 0) return
  const margin = 8
  const width = box.width + margin * 2
  const height = box.height + margin * 2
  element.setAttribute('viewBox', `${box.x - margin} ${box.y - margin} ${width} ${height}`)
  element.setAttribute('width', String(width))
  element.setAttribute('height', String(height))
  element.style.maxWidth = `${width}px`
}

function resolveImagePath(base: string, source: string): string | null {
  const value = source.split(/[?#]/, 1)[0].replace(/\\/g, '/')
  if (!value || value.startsWith('/') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null
  const parts = base ? base.split('/') : []
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/')
}
