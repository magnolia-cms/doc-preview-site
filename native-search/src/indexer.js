/**
 * Magnolia Docs Search Indexer
 * 
 * Crawls a static site build folder and creates:
 * 1. A search index (JSON) for client-side search
 * 2. LLM-optimized chunks for AI-powered answers
 */

const fs = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');
const crypto = require('crypto');

class MagnoliaDocsIndexer {
  constructor(options = {}) {
    this.siteDir = options.siteDir || './build/site';
    this.outputDir = options.outputDir || './search-data';
    this.baseUrl = options.baseUrl || 'https://docs.magnolia-cms.com';
    
    // Search index
    this.searchIndex = [];
    
    // LLM chunks (larger, context-rich)
    this.llmChunks = [];
    
    // Stats
    this.stats = {
      filesProcessed: 0,
      searchRecords: 0,
      llmChunks: 0,
      errors: []
    };
  }

  /**
   * Main entry point
   */
  async build() {
    console.log('🔍 Magnolia Docs Search Indexer');
    console.log('================================\n');
    
    // Ensure output directory exists
    await fs.mkdir(this.outputDir, { recursive: true });
    
    // Find all HTML files
    console.log(`📂 Scanning ${this.siteDir}...`);
    const htmlFiles = await this.findHtmlFiles(this.siteDir);
    console.log(`   Found ${htmlFiles.length} HTML files\n`);
    
    // Process each file
    console.log('📄 Processing files...');
    for (const filePath of htmlFiles) {
      try {
        await this.processFile(filePath);
        this.stats.filesProcessed++;
        
        // Progress indicator
        if (this.stats.filesProcessed % 100 === 0) {
          console.log(`   Processed ${this.stats.filesProcessed} files...`);
        }
      } catch (err) {
        this.stats.errors.push({ file: filePath, error: err.message });
      }
    }
    
    // Write outputs
    console.log('\n💾 Writing output files...');
    await this.writeOutputs();
    
    // Print summary
    this.printSummary();
    
    return {
      searchIndex: this.searchIndex,
      llmChunks: this.llmChunks,
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
        // Skip common non-content directories
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
    const url = this.pathToUrl(relativePath);
    
    // Skip non-content pages
    if (this.shouldSkip($, url)) {
      return;
    }
    
    // Extract metadata
    const metadata = this.extractMetadata($, url);
    
    // Extract content sections
    const sections = this.extractSections($);
    
    // Create search records (one per section for granular results)
    for (const section of sections) {
      const searchRecord = this.createSearchRecord(metadata, section, url);
      this.searchIndex.push(searchRecord);
      this.stats.searchRecords++;
    }
    
    // Create LLM chunk (full page context)
    const llmChunk = this.createLlmChunk(metadata, sections, url);
    this.llmChunks.push(llmChunk);
    this.stats.llmChunks++;
  }

  /**
   * Convert file path to URL
   */
  pathToUrl(relativePath) {
    let url = relativePath
      .replace(/\\/g, '/')
      .replace(/index\.html$/, '')
      .replace(/\.html$/, '/');
    
    if (!url.endsWith('/')) url += '/';
    if (!url.startsWith('/')) url = '/' + url;
    
    return this.baseUrl + url;
  }

  /**
   * Determine if page should be skipped
   */
  shouldSkip($, url) {
    // Skip 404, redirects, empty pages
    const title = $('title').text();
    if (!title || title.includes('404') || title.includes('Redirect')) {
      return true;
    }
    
    // Skip if no main content
    const content = $('.doc, .content, article, main').text().trim();
    if (content.length < 100) {
      return true;
    }
    
    return false;
  }

  /**
   * Extract page metadata
   */
  extractMetadata($, url) {
    // Get title (try multiple selectors)
    const title = $('h1.page').text().trim() ||
                  $('article h1').first().text().trim() ||
                  $('.doc h1').first().text().trim() ||
                  $('h1').first().text().trim() ||
                  $('title').text().split('::')[0].trim();
    
    // Determine category/version from URL
    const { category, version } = this.categorizeUrl(url);
    
    // Get breadcrumb for context
    const breadcrumb = $('.breadcrumbs a, .breadcrumb a')
      .map((i, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    
    // Get description
    const description = $('meta[name="description"]').attr('content') ||
                        $('.doc > p').first().text().trim().slice(0, 200);
    
    return {
      title,
      category,
      version,
      breadcrumb,
      description
    };
  }

  /**
   * Categorize URL by version/type
   */
  categorizeUrl(url) {
    if (url.includes('/product-docs/6.2/')) {
      return { category: 'Magnolia 6.2', version: '6.2' };
    }
    if (url.includes('/product-docs/6.3/')) {
      return { category: 'Magnolia 6.3', version: '6.3' };
    }
    if (url.includes('/product-docs/')) {
      return { category: 'Magnolia 6.4', version: 'latest' };
    }
    if (url.includes('/paas/') || url.includes('/cockpit/')) {
      return { category: 'DX Cloud', version: 'cloud' };
    }
    if (url.includes('/support/')) {
      return { category: 'Support', version: 'general' };
    }
    if (url.includes('/magnolia-cli/')) {
      return { category: 'CLI', version: 'general' };
    }
    if (url.includes('/headless/')) {
      return { category: 'Headless', version: 'general' };
    }
    
    // Module docs
    return { category: 'Modules', version: 'modules' };
  }

  /**
   * Extract content sections with hierarchy
   */
  extractSections($) {
    const sections = [];
    const contentArea = $('.doc, .content, article').first();
    
    if (!contentArea.length) {
      return sections;
    }
    
    let currentSection = {
      heading: null,
      headingLevel: 0,
      anchor: '',
      content: []
    };
    
    // Walk through content elements
    contentArea.find('h1, h2, h3, h4, p, li, dt, dd, pre, table').each((i, el) => {
      const $el = $(el);
      const tagName = el.tagName.toLowerCase();
      
      // New heading = new section
      if (['h1', 'h2', 'h3', 'h4'].includes(tagName)) {
        // Save previous section if it has content
        if (currentSection.content.length > 0) {
          sections.push(this.finalizeSection(currentSection));
        }
        
        // Start new section
        const headingText = $el.text().trim();
        const anchor = $el.attr('id') || this.slugify(headingText);
        
        currentSection = {
          heading: headingText,
          headingLevel: parseInt(tagName.charAt(1)),
          anchor,
          content: []
        };
      } else {
        // Add content to current section
        let text = '';
        
        if (tagName === 'pre') {
          // Code block - preserve but truncate
          text = '[Code] ' + $el.text().trim().slice(0, 200);
        } else if (tagName === 'table') {
          // Table - extract text content
          text = '[Table] ' + $el.find('th, td').map((i, cell) => $(cell).text().trim()).get().join(' | ').slice(0, 300);
        } else {
          text = $el.text().trim();
        }
        
        if (text.length > 10) {
          currentSection.content.push(text);
        }
      }
    });
    
    // Don't forget last section
    if (currentSection.content.length > 0) {
      sections.push(this.finalizeSection(currentSection));
    }
    
    return sections;
  }

  /**
   * Finalize a section for indexing
   */
  finalizeSection(section) {
    const contentText = section.content.join(' ').trim();
    
    return {
      heading: section.heading,
      headingLevel: section.headingLevel,
      anchor: section.anchor,
      content: contentText,
      contentPreview: contentText.slice(0, 150) + (contentText.length > 150 ? '...' : '')
    };
  }

  /**
   * Create a search record
   */
  createSearchRecord(metadata, section, url) {
    const fullUrl = section.anchor ? `${url}#${section.anchor}` : url;
    
    // Create a unique ID
    const id = crypto.createHash('md5').update(fullUrl).digest('hex').slice(0, 12);
    
    // Combine searchable text
    const searchableText = [
      metadata.title,
      section.heading,
      section.content
    ].filter(Boolean).join(' ').toLowerCase();
    
    return {
      id,
      url: fullUrl,
      title: metadata.title,
      heading: section.heading,
      headingLevel: section.headingLevel,
      content: section.contentPreview,
      fullContent: section.content,
      category: metadata.category,
      version: metadata.version,
      breadcrumb: metadata.breadcrumb,
      // Pre-computed for faster search
      _searchText: searchableText
    };
  }

  /**
   * Create an LLM-optimized chunk
   */
  createLlmChunk(metadata, sections, url) {
    // Build a rich, contextual document for LLM consumption
    const lines = [
      `# ${metadata.title}`,
      '',
      `URL: ${url}`,
      `Category: ${metadata.category}`,
      `Version: ${metadata.version}`,
      metadata.breadcrumb.length ? `Path: ${metadata.breadcrumb.join(' > ')}` : '',
      '',
      metadata.description ? `Summary: ${metadata.description}` : '',
      '',
      '---',
      ''
    ];
    
    // Add all sections with hierarchy
    for (const section of sections) {
      if (section.heading) {
        const prefix = '#'.repeat(Math.min(section.headingLevel + 1, 4));
        lines.push(`${prefix} ${section.heading}`);
        lines.push('');
      }
      
      if (section.content) {
        lines.push(section.content);
        lines.push('');
      }
    }
    
    const content = lines.join('\n').trim();
    
    return {
      id: crypto.createHash('md5').update(url).digest('hex').slice(0, 12),
      url,
      title: metadata.title,
      category: metadata.category,
      version: metadata.version,
      content,
      tokenEstimate: Math.ceil(content.split(/\s+/).length * 1.3) // Rough token estimate
    };
  }

  /**
   * Write output files
   */
  async writeOutputs() {
    // Search index (optimized for client-side)
    const searchIndexPath = path.join(this.outputDir, 'search-index.json');
    await fs.writeFile(
      searchIndexPath,
      JSON.stringify(this.searchIndex, null, 2)
    );
    console.log(`   ✓ Search index: ${searchIndexPath}`);
    
    // Compact search index (minified for production)
    const compactIndexPath = path.join(this.outputDir, 'search-index.min.json');
    await fs.writeFile(
      compactIndexPath,
      JSON.stringify(this.searchIndex)
    );
    console.log(`   ✓ Compact index: ${compactIndexPath}`);
    
    // LLM chunks
    const llmChunksPath = path.join(this.outputDir, 'llm-chunks.json');
    await fs.writeFile(
      llmChunksPath,
      JSON.stringify(this.llmChunks, null, 2)
    );
    console.log(`   ✓ LLM chunks: ${llmChunksPath}`);
    
    // Metadata file
    const metadataPath = path.join(this.outputDir, 'metadata.json');
    await fs.writeFile(
      metadataPath,
      JSON.stringify({
        generated: new Date().toISOString(),
        baseUrl: this.baseUrl,
        stats: this.stats,
        categories: [...new Set(this.searchIndex.map(r => r.category))],
        versions: [...new Set(this.searchIndex.map(r => r.version))]
      }, null, 2)
    );
    console.log(`   ✓ Metadata: ${metadataPath}`);
  }

  /**
   * Print summary
   */
  printSummary() {
    console.log('\n================================');
    console.log('📊 Summary');
    console.log('================================');
    console.log(`   Files processed: ${this.stats.filesProcessed}`);
    console.log(`   Search records:  ${this.stats.searchRecords}`);
    console.log(`   LLM chunks:      ${this.stats.llmChunks}`);
    
    if (this.stats.errors.length > 0) {
      console.log(`   Errors:          ${this.stats.errors.length}`);
      this.stats.errors.slice(0, 5).forEach(err => {
        console.log(`      - ${err.file}: ${err.error}`);
      });
    }
    
    console.log('\n✅ Done!\n');
  }

  /**
   * Utility: Create URL-safe slug
   */
  slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}

module.exports = MagnoliaDocsIndexer;

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  const siteDir = args[0] || './build/site';
  const outputDir = args[1] || './search-data';
  
  const indexer = new MagnoliaDocsIndexer({ siteDir, outputDir });
  indexer.build().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
