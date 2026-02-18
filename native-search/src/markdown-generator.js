/**
 * Magnolia Docs Markdown Generator
 * 
 * Converts built Antora HTML pages into full-fidelity markdown .txt files
 * for LLM consumption (Ask AI, external agents). Also generates an
 * llms.txt manifest following the llms.txt convention.
 * 
 * These .txt files are referenced by pagePath in the search index.
 * The search index handles retrieval; these files provide the full
 * content that gets fed to the LLM.
 */

const fs = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');
const TurndownService = require('turndown');
const { gfm } = require('@joplin/turndown-plugin-gfm');
const { categorizeUrl, urlToPagePath, pathToUrl } = require('./utils');

class MagnoliaMarkdownGenerator {
  constructor(options = {}) {
    this.siteDir = options.siteDir || './build/site';
    this.outputDir = options.outputDir || './search-data';
    this.baseUrl = options.baseUrl || 'https://docs.magnolia-cms.com';

    // All generated pages (for manifest)
    this.pages = [];

    // Stats
    this.stats = {
      filesProcessed: 0,
      pagesGenerated: 0,
      pagesSkipped: 0,
      errors: []
    };

    // Configure turndown
    this.turndown = this.createTurndownService();
  }

  /**
   * Configure turndown for Antora HTML → clean markdown
   */
  createTurndownService() {
    const td = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined'
    });

    // Enable GFM (tables, strikethrough, task lists)
    td.use(gfm);

    // --- Custom rules for Antora HTML patterns ---

    // Antora wraps code blocks in <div class="listingblock"><div class="content"><pre class="highlight"><code>
    // We need to extract the language and produce a proper fenced block.
    td.addRule('antoraCodeBlock', {
      filter: function (node) {
        return (
          node.nodeName === 'PRE' &&
          node.querySelector('code')
        );
      },
      replacement: function (content, node) {
        const code = node.querySelector('code');
        if (!code) return content;

        // Extract language from class (e.g. "language-yaml", "language-java")
        const langMatch = (code.getAttribute('class') || '').match(/language-(\S+)/);
        const lang = langMatch ? langMatch[1] : '';

        // Get raw text content — no truncation
        const text = code.textContent || '';

        return '\n\n```' + lang + '\n' + text.replace(/\n$/, '') + '\n```\n\n';
      }
    });

    // Antora admonition blocks: <div class="admonitionblock note/tip/warning/caution/important">
    td.addRule('antoraAdmonition', {
      filter: function (node) {
        return (
          node.nodeName === 'DIV' &&
          node.classList &&
          node.classList.contains('admonitionblock')
        );
      },
      replacement: function (content, node) {
        // Determine type from class
        const classes = node.getAttribute('class') || '';
        let type = 'Note';
        if (classes.includes('tip')) type = 'Tip';
        else if (classes.includes('warning')) type = 'Warning';
        else if (classes.includes('caution')) type = 'Caution';
        else if (classes.includes('important')) type = 'Important';

        // Get the content from the .content cell (Antora uses a table layout)
        const contentCell = node.querySelector('.content, td.content');
        const text = contentCell ? contentCell.textContent.trim() : content.trim();

        // Format as blockquote with bold prefix
        const lines = text.split('\n').map(line => '> ' + line);
        return '\n\n> **' + type + ':** ' + lines.join('\n').replace(/^> /, '') + '\n\n';
      }
    });

    // Remove elements that shouldn't be in the markdown output.
    // Turndown's `remove` discards both the tag and its content.
    td.remove(['script', 'style', 'nav', 'noscript']);

    // Keep but simplify certain inline elements
    td.addRule('keepSpan', {
      filter: 'span',
      replacement: function (content) {
        return content;
      }
    });

    return td;
  }

  /**
   * Main entry point
   */
  async build() {
    console.log('📝 Magnolia Docs Markdown Generator');
    console.log('====================================\n');

    // Ensure output directories exist
    const pagesDir = path.join(this.outputDir, 'pages');
    await fs.mkdir(pagesDir, { recursive: true });

    // Find all HTML files
    console.log(`📂 Scanning ${this.siteDir}...`);
    const htmlFiles = await this.findHtmlFiles(this.siteDir);
    console.log(`   Found ${htmlFiles.length} HTML files\n`);

    // Process each file
    console.log('📄 Converting files...');
    for (const filePath of htmlFiles) {
      try {
        await this.processFile(filePath);
        this.stats.filesProcessed++;

        if (this.stats.filesProcessed % 100 === 0) {
          console.log(`   Converted ${this.stats.filesProcessed} files...`);
        }
      } catch (err) {
        this.stats.errors.push({ file: filePath, error: err.message });
      }
    }

    // Write the llms.txt manifest
    console.log('\n💾 Writing output files...');
    const pagesCount = this.pages.length;
    console.log(`   ✓ Pages: ${pagesDir} (${pagesCount} files)`);

    await this.writeManifest();
    console.log(`   ✓ Manifest: ${path.join(this.outputDir, 'llms.txt')}`);

    // Print summary
    this.printSummary();

    return {
      pages: this.pages,
      stats: this.stats
    };
  }

  /**
   * Recursively find all HTML files
   */
  async findHtmlFiles(dir, files = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!['_', 'node_modules', '.git', 'assets'].includes(entry.name)) {
          await this.findHtmlFiles(fullPath, files);
        }
      } else if (entry.name.endsWith('.html')) {
        files.push(fullPath);
      }
    }

    return files;
  }

  /**
   * Process a single HTML file
   */
  async processFile(filePath) {
    const html = await fs.readFile(filePath, 'utf-8');
    const $ = cheerio.load(html);

    // Extract URL from file path
    const relativePath = path.relative(this.siteDir, filePath);
    const url = pathToUrl(relativePath, this.baseUrl);

    // Skip non-content pages (same logic as indexer)
    if (this.shouldSkip($, url)) {
      this.stats.pagesSkipped++;
      return;
    }

    // Extract metadata
    const metadata = this.extractMetadata($, url);

    // Strip non-content elements from DOM before conversion
    this.stripNonContent($);

    // Get the content area
    const contentArea = $('.doc, .content, article').first();
    if (!contentArea.length) {
      this.stats.pagesSkipped++;
      return;
    }

    // Convert to markdown via turndown
    const contentHtml = contentArea.html();
    let markdown = this.turndown.turndown(contentHtml);

    // Post-process the markdown
    markdown = this.postProcess(markdown, url);

    // Build the full file with YAML frontmatter
    const output = this.buildOutput(metadata, markdown, url);

    // Derive the output filename from the shared utility
    const pagePath = urlToPagePath(url, this.baseUrl);
    const outputPath = path.join(this.outputDir, pagePath);

    // Ensure the parent directory exists (pagePath is always pages/...)
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    // Write the file
    await fs.writeFile(outputPath, output, 'utf-8');

    // Track for manifest
    this.pages.push({
      title: metadata.title,
      description: metadata.description,
      url,
      category: metadata.category,
      version: metadata.version,
      pagePath
    });

    this.stats.pagesGenerated++;
  }

  /**
   * Determine if page should be skipped (mirrors indexer logic)
   */
  shouldSkip($, url) {
    const title = $('title').text();
    if (!title || title.includes('404') || title.includes('Redirect')) {
      return true;
    }

    const content = $('.doc, .content, article, main').text().trim();
    if (content.length < 100) {
      return true;
    }

    return false;
  }

  /**
   * Extract page metadata (mirrors indexer logic)
   */
  extractMetadata($, url) {
    const title = $('h1.page').text().trim() ||
                  $('article h1').first().text().trim() ||
                  $('.doc h1').first().text().trim() ||
                  $('h1').first().text().trim() ||
                  $('title').text().split('::')[0].trim();

    const { category, version } = categorizeUrl(url);

    const breadcrumb = $('.breadcrumbs a, .breadcrumb a')
      .map((i, el) => $(el).text().trim())
      .get()
      .filter(Boolean);

    // Get description, but skip the generic site-wide meta description
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    const isGenericMeta = !metaDesc ||
      metaDesc.toLowerCase().includes('explore magnolia cms documentation') ||
      metaDesc.toLowerCase().includes('comprehensive guides and resources');

    const description = isGenericMeta
      ? $('.doc > p').first().text().trim().slice(0, 200)
      : metaDesc;

    return {
      title,
      category,
      version,
      breadcrumb,
      description
    };
  }

  /**
   * Remove non-content elements from the DOM before markdown conversion.
   * This ensures turndown only sees the actual page content.
   */
  stripNonContent($) {
    const selectorsToRemove = [
      '.navbar',
      '.sidebar',
      '.footer',
      'footer',
      '.breadcrumbs',
      '.breadcrumb',
      '.toc-sidebar',
      '.toc',
      'nav',
      '.pagination',
      '.feedback',
      '.edit-this-page',
      '.scroll-to-top',
      '.countdown',
      '.table-sort',
      '.banner',
      '.header',
      'header',
      'script',
      'style',
      'noscript',
      // Antora-specific
      '.toolbar',
      '.page-versions'
    ];

    selectorsToRemove.forEach(selector => {
      $(selector).remove();
    });
  }

  /**
   * Post-process converted markdown to clean up common artifacts
   */
  postProcess(markdown, pageUrl) {
    let md = markdown;

    // Collapse excessive blank lines (3+ → 2)
    md = md.replace(/\n{4,}/g, '\n\n\n');

    // Remove leading/trailing whitespace per line (but preserve code blocks)
    // We only trim outside of fenced code blocks
    const lines = md.split('\n');
    let inCodeBlock = false;
    const cleaned = lines.map(line => {
      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
      }
      if (inCodeBlock) return line;
      return line.trimEnd();
    });
    md = cleaned.join('\n');

    // Convert relative URLs to absolute
    // Matches markdown links: [text](url) where url starts with / or ../
    md = md.replace(/\[([^\]]*)\]\((\/([\w/.-]*?))\)/g, (match, text, relUrl) => {
      return `[${text}](${this.baseUrl}${relUrl})`;
    });

    // Convert relative image URLs to absolute
    md = md.replace(/!\[([^\]]*)\]\((\/([\w/.-]*?))\)/g, (match, alt, relUrl) => {
      return `![${alt}](${this.baseUrl}${relUrl})`;
    });

    // Trim leading/trailing whitespace from entire document
    md = md.trim();

    return md;
  }

  /**
   * Build the complete output file with YAML frontmatter
   */
  buildOutput(metadata, markdown, url) {
    const breadcrumbStr = metadata.breadcrumb.length
      ? metadata.breadcrumb.join(' > ')
      : '';

    const frontmatter = [
      '---',
      `title: "${metadata.title.replace(/"/g, '\\"')}"`,
      `url: ${url}`,
      `category: ${metadata.category}`,
      `version: ${metadata.version}`,
      breadcrumbStr ? `breadcrumb: ${breadcrumbStr}` : null,
      '---'
    ].filter(Boolean).join('\n');

    return frontmatter + '\n\n' + markdown + '\n';
  }

  /**
   * Write the llms.txt manifest grouped by category
   */
  async writeManifest() {
    // Group pages by category
    const grouped = {};
    for (const page of this.pages) {
      if (!grouped[page.category]) {
        grouped[page.category] = [];
      }
      grouped[page.category].push(page);
    }

    // Sort categories in a logical order
    const categoryOrder = [
      'Magnolia 6.4',
      'Magnolia 6.3',
      'Magnolia 6.2',
      'DX Cloud',
      'Headless',
      'CLI',
      'Modules',
      'Support'
    ];

    const sortedCategories = Object.keys(grouped).sort((a, b) => {
      const ai = categoryOrder.indexOf(a);
      const bi = categoryOrder.indexOf(b);
      // Known categories first in defined order, then alphabetical
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });

    // Build manifest content
    const lines = [
      '# Magnolia CMS Documentation',
      '',
      '> Magnolia is a composable digital experience platform (DXP). This documentation covers product setup, development, modules, cloud deployment, and more.',
      ''
    ];

    for (const category of sortedCategories) {
      const pages = grouped[category];

      // Sort pages by title within each category
      pages.sort((a, b) => a.title.localeCompare(b.title));

      lines.push(`## ${category}`);
      lines.push('');

      for (const page of pages) {
        // Build the URL to the .txt file
        const txtUrl = `${this.baseUrl}/${page.pagePath}`;
        const desc = page.description
          ? ': ' + page.description.slice(0, 120)
          : '';
        lines.push(`- [${page.title}](${txtUrl})${desc}`);
      }

      lines.push('');
    }

    const manifestPath = path.join(this.outputDir, 'llms.txt');
    await fs.writeFile(manifestPath, lines.join('\n'), 'utf-8');
  }

  /**
   * Print summary
   */
  printSummary() {
    console.log('\n====================================');
    console.log('📊 Summary');
    console.log('====================================');
    console.log(`   Files processed: ${this.stats.filesProcessed}`);
    console.log(`   Pages generated: ${this.stats.pagesGenerated}`);
    console.log(`   Pages skipped:   ${this.stats.pagesSkipped}`);

    if (this.stats.errors.length > 0) {
      console.log(`   Errors:          ${this.stats.errors.length}`);
      this.stats.errors.slice(0, 5).forEach(err => {
        console.log(`      - ${err.file}: ${err.error}`);
      });
    }

    console.log('\n✅ Done!\n');
  }
}

module.exports = MagnoliaMarkdownGenerator;

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  const siteDir = args[0] || './build/site';
  const outputDir = args[1] || './search-data';

  const generator = new MagnoliaMarkdownGenerator({ siteDir, outputDir });
  generator.build().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
