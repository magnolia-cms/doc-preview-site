/**
 * Antora extension to export content for LLM ingestion.
 *
 * High-level behaviour:
 * - Runs once after navigation is built so we have:
 *   - Fully rendered HTML for each publishable page (`page.contents`).
 *   - Stable public URLs (`page.pub.url`).
 *   - Navigation trees per component version (for path breadcrumbs).
 * - Groups pages by Antora component+version.
 * - For each component version, emits a single `llms-<component>-<version>.txt` file
 *   containing all pages from that component version.
 *
 * NOTE: This is an initial skeleton focused on structure and Antora integration.
 * The HTML -> markdown conversion and table normalization will be refined next.
 */

const { parse: parseHTML } = require('node-html-parser')
const fs = require('fs')
const path = require('path')
const TurndownService = require('turndown')

module.exports.register = function () {
  // Use `once` so we do a single pass after navigation is built.
  this.once('navigationBuilt', ({ playbook, contentCatalog, siteCatalog }) => {
    const siteUrl = playbook.site && playbook.site.url ? playbook.site.url.replace(/\/+$/, '') : ''

    // Collect all publishable pages and group them by component+version
    const byComponentVersion = new Map()

    contentCatalog.getPages((page) => page.pub && page.contents).forEach((page) => {
      const { component: componentName, version = '' } = page.src
      if (!componentName) return

      const key = `${componentName}::${version}`
      if (!byComponentVersion.has(key)) {
        byComponentVersion.set(key, {
          component: componentName,
          version,
          pages: [],
        })
      }

      const bucket = byComponentVersion.get(key)
      const siteRelativeUrl = page.pub.url
      const html = page.contents.toString()

      bucket.pages.push({
        id: page.id || page.src?.path || page.out?.path || '',
        title: page.title,
        // store site-relative URL; environment can prepend its own base URL
        url: siteRelativeUrl,
        siteRelativeUrl,
        // navPath will be filled in a second pass once we have navigation
        navPath: [],
        html,
      })
    })

    // After we've grouped pages, build a navigation lookup per component-version
    const navByComponentVersion = buildNavLookupByComponentVersion(contentCatalog, byComponentVersion)

    // Enrich each page with its nav path (if available)
    for (const [key, bucket] of byComponentVersion.entries()) {
      const navLookup = navByComponentVersion[key] || {}
      bucket.pages.forEach((page) => {
        const navEntry = navLookup[page.siteRelativeUrl] || {}
        page.navPath = (navEntry.path || []).map((it) => it.content)
      })
    }

    // Emit one llms-*.txt file per component version
    const manifestEntries = []
    for (const [, bucket] of byComponentVersion.entries()) {
      const fileContents = renderComponentVersionToText(bucket)
      const safeComponent = sanitizeName(bucket.component)
      const safeVersion = sanitizeName(bucket.version || 'unversioned')
      const relPath = `llms/llms-${safeComponent}-${safeVersion}.txt`

      siteCatalog.addFile({
        contents: Buffer.from(fileContents, 'utf8'),
        out: { path: relPath },
      })

      manifestEntries.push({
        component: bucket.component,
        version: bucket.version || 'unversioned',
        path: relPath,
      })
    }

    // Emit root-level llms.txt manifest that points to component-version corpora
    if (manifestEntries.length) {
      const manifestContents = renderMasterManifest(manifestEntries)
      siteCatalog.addFile({
        contents: Buffer.from(manifestContents, 'utf8'),
        out: { path: 'llms.txt' },
      })
    }
  })
}

function buildNavLookupByComponentVersion (contentCatalog, byComponentVersion) {
  const result = {}

  for (const [key, bucket] of byComponentVersion.entries()) {
    const { component, version } = bucket
    const cv = contentCatalog.getComponentVersion(component, version || '')
    if (!cv || !cv.navigation) continue
    result[key] = getNavEntriesByUrl(cv.navigation)
  }

  return result
}

function getNavEntriesByUrl (items = [], accum = {}, path = []) {
  items.forEach((item) => {
    if (item.urlType === 'internal') accum[item.url.split('#')[0]] = { item, path: path.concat(item) }
    getNavEntriesByUrl(item.items, accum, item.content ? path.concat(item) : path)
  })
  return accum
}

function sanitizeName (value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default'
}

/**
 * Very early draft of the per-component-version text export.
 *
 * For now:
 * - Wraps each page in a clear delimiter.
 * - Exposes basic metadata (id, title, URL, nav path).
 * - Extracts markdown from the HTML using Turndown.
 *
 * Next iteration will:
 * - Replace `extractPlainText` with HTML -> markdown via Turndown.
 * - Add custom table handling to explode complex tables.
 */
function renderComponentVersionToText (bucket) {
  const lines = []

  lines.push(`# Component: ${bucket.component}`)
  lines.push(`# Version: ${bucket.version || 'unversioned'}`)
  lines.push('')

  bucket.pages.forEach((page) => {
    lines.push('--- PAGE START ---')
    lines.push(`ID: ${page.id}`)
    lines.push(`Title: ${page.title}`)
    lines.push(`URL: ${page.url}`)
    if (page.navPath && page.navPath.length) {
      lines.push(`NavPath: ${page.navPath.join(' > ')}`)
    }
    lines.push('')

    const textBody = htmlToMarkdown(page.html)
    lines.push(textBody)
    lines.push('--- PAGE END ---')
    lines.push('')
  })

  return lines.join('\n')
}

// Lazily-initialized singleton TurndownService
let turndownService

function getTurndown () {
  if (!turndownService) {
    turndownService = new TurndownService({
      headingStyle: 'atx',
      hr: '***',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**',
    })

    // Preserve code blocks with language (when present on <code> or a wrapping element)
    turndownService.addRule('codeBlocks', {
      filter: function (node) {
        return (
          node.nodeName === 'PRE' &&
          node.firstChild &&
          node.firstChild.nodeName === 'CODE'
        )
      },
      replacement: function (content, node) {
        const codeNode = node.firstChild
        const className = codeNode.getAttribute && codeNode.getAttribute('class')
        let lang = ''
        if (className) {
          const match = className.match(/language-([a-z0-9]+)/i)
          if (match) lang = match[1]
        }
        const code = codeNode.textContent || ''
        return '\n```' + (lang || '') + '\n' + code.replace(/\s+$/, '') + '\n```\n'
      },
    })

    // Flatten Asciidoctor admonition tables into blockquotes like "> NOTE: text"
    turndownService.addRule('admonitions', {
      filter: function (node) {
        return (
          node.nodeName === 'DIV' &&
          node.getAttribute &&
          /\badmonitionblock\b/.test(node.getAttribute('class') || '')
        )
      },
      replacement: function (content, node) {
        const titleNode =
          node.querySelector && node.querySelector('.title, .content .title')
        const textNode =
          node.querySelector && node.querySelector('.content')
        const title = titleNode && titleNode.textContent
        const body =
          (textNode && textNode.textContent) ||
          node.textContent ||
          content
        const label = title ? title.trim() : 'Note'
        const normalized = body.replace(/\s+\n/g, '\n').trim()
        return '\n> ' + label + ': ' + normalized + '\n\n'
      },
    })

    // Convert tables into key/value style lists for LLM clarity.
    turndownService.addRule('structuredTables', {
      filter: function (node) {
        return node.nodeName === 'TABLE'
      },
      replacement: function (content, node) {
        // Try to get headers from thead first, then fallback to first row.
        const headerCells = []
        const theadRows =
          (node.querySelectorAll && node.querySelectorAll('thead tr')) || []
        if (theadRows.length) {
          const cells = theadRows[0].children || theadRows[0].childNodes || []
          for (let i = 0; i < cells.length; i++) {
            const cell = cells[i]
            if (cell.textContent) headerCells.push(cell.textContent.trim())
          }
        } else {
          const firstRow =
            (node.querySelector && node.querySelector('tr')) || null
          if (firstRow && (firstRow.children || firstRow.childNodes)) {
            const cells = firstRow.children || firstRow.childNodes
            for (let i = 0; i < cells.length; i++) {
              const cell = cells[i]
              if (cell.textContent) headerCells.push(cell.textContent.trim())
            }
          }
        }

        const headers =
          headerCells.length > 0
            ? headerCells
            : [] // we'll synthesize generic column names if needed

        // Collect body rows (tbody tr). If no tbody, use all rows minus the first (header) row.
        let bodyRows =
          (node.querySelectorAll && node.querySelectorAll('tbody tr')) || []
        if (!bodyRows.length) {
          const allRows =
            (node.querySelectorAll && node.querySelectorAll('tr')) || []
          bodyRows = Array.prototype.slice.call(allRows, headers.length ? 1 : 0)
        }

        const lines = []

        // Optional: if table has a title in a preceding sibling with class "title"
        const titleNode =
          (node.previousSibling &&
            node.previousSibling.getAttribute &&
            /\btitle\b/.test(
              node.previousSibling.getAttribute('class') || ''
            ) &&
            node.previousSibling) ||
          null
        if (titleNode && titleNode.textContent) {
          lines.push('')
          lines.push('**Table**: ' + titleNode.textContent.trim())
        }

        for (let r = 0; r < bodyRows.length; r++) {
          const row = bodyRows[r]
          const cells = row.children || row.childNodes || []
          if (!cells.length) continue

          let rowLabel = ''
          const kvLines = []

          for (let c = 0; c < cells.length; c++) {
            const cell = cells[c]
            const value = (cell.textContent || '').trim()
            if (!value) continue

            const header =
              headers[c] && headers[c].length
                ? headers[c]
                : `Column ${c + 1}`

            if (c === 0) {
              rowLabel = value
            } else {
              kvLines.push(`  - **${header}**: ${value}`)
            }
          }

          if (!rowLabel && kvLines.length === 0) continue

          lines.push('')
          lines.push(
            `- **${rowLabel || 'Row ' + (r + 1)}**`
          )
          if (kvLines.length) lines.push(...kvLines)
        }

        if (!lines.length) return '\n'

        return '\n' + lines.join('\n') + '\n\n'
      },
    })
  }
  return turndownService
}

function htmlToMarkdown (html) {
  if (!html) return ''

  // Many pages already give us the article fragment, but if we
  // ever get a full page, wrap and extract the <article> only.
  const root = parseHTML(`<div>${html}</div>`)
  const article =
    root.querySelector('article') ||
    root

  const td = getTurndown()
  const md = td.turndown(article.toString())

  return md.trim()
}

/**
 * Build the root-level llms.txt manifest.
 *
 * Structure:
 * - Intro text loaded from native-search/config/llms-intro.md (if present)
 * - Then a list of components and their versioned corpora with links to the llms/ files.
 */
function renderMasterManifest (entries) {
  const lines = getManifestIntroLines()

  // Group entries by component
  const byComponent = {}
  entries.forEach((entry) => {
    if (!byComponent[entry.component]) byComponent[entry.component] = []
    byComponent[entry.component].push(entry)
  })

  const componentNames = Object.keys(byComponent).sort((a, b) => a.localeCompare(b))

  componentNames.forEach((name) => {
    lines.push(`## ${name}`)
    lines.push('')
    const versions = byComponent[name].sort((a, b) => a.version.localeCompare(b.version))
    versions.forEach((v) => {
      const label = v.version && v.version !== 'unversioned' ? `${name} ${v.version}` : name
      const url = `/${v.path}`
      lines.push(`- [${label}](${url})`)
    })
    lines.push('')
  })

  return lines.join('\n')
}

function getManifestIntroLines () {
  const configPath = path.join(__dirname, '..', 'native-search', 'config', 'llms-intro.md')
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const lines = raw.split(/\r?\n/)
    // Ensure a blank line at the end so subsequent sections start cleanly
    if (lines[lines.length - 1] !== '') lines.push('')
    return lines
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return [
      '# Magnolia CMS Documentation',
      '',
      '> Root manifest for LLM corpora (components and versions).',
      '',
      '## Components',
      '',
    ]
  }
}

