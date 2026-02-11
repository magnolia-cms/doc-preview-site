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
      pagesSplit: 0,
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
    
    // Create LLM chunks (may split large pages)
    const llmChunks = this.createLlmChunks(metadata, sections, url);
    if (llmChunks.length > 1) {
      this.stats.pagesSplit++;
    }
    for (const chunk of llmChunks) {
      this.llmChunks.push(chunk);
      this.stats.llmChunks++;
    }
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
   * Create LLM-optimized chunks (splits large pages intelligently)
   */
  createLlmChunks(metadata, sections, url) {
    const MAX_CHUNK_TOKENS = 1500; // Target max tokens per chunk
    const chunks = [];
    
    // Build header (reused for all chunks from this page)
    const header = this.buildChunkHeader(metadata, url);
    const headerTokens = this.estimateTokens(header);
    
    // If page is small enough, return single chunk
    let totalTokens = headerTokens;
    for (const section of sections) {
      totalTokens += this.estimateSectionTokens(section);
    }
    
    if (totalTokens <= MAX_CHUNK_TOKENS) {
      return [this.buildSingleChunk(header, sections, url, metadata, 0, 1)];
    }
    
    // Split into multiple chunks
    let currentChunk = {
      sections: [],
      tokens: headerTokens,
      startIndex: 0
    };
    
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const sectionTokens = this.estimateSectionTokens(section);
      
      // If adding this section would exceed limit AND we already have content
      if (currentChunk.tokens + sectionTokens > MAX_CHUNK_TOKENS && currentChunk.sections.length > 0) {
        // Finalize current chunk
        const chunkIndex = chunks.length;
        chunks.push(this.buildChunkFromSections(
          header,
          currentChunk.sections,
          url,
          metadata,
          chunkIndex,
          currentChunk.startIndex,
          i - 1
        ));
        
        // Start new chunk (include header tokens)
        currentChunk = {
          sections: [section],
          tokens: headerTokens + sectionTokens,
          startIndex: i
        };
      } else {
        // Add section to current chunk
        currentChunk.sections.push(section);
        currentChunk.tokens += sectionTokens;
      }
    }
    
    // Don't forget last chunk
    if (currentChunk.sections.length > 0) {
      const chunkIndex = chunks.length;
      chunks.push(this.buildChunkFromSections(
        header,
        currentChunk.sections,
        url,
        metadata,
        chunkIndex,
        currentChunk.startIndex,
        sections.length - 1
      ));
    }
    
    // Update chunkTotal for all chunks
    const totalChunks = chunks.length;
    chunks.forEach(chunk => {
      chunk.chunkTotal = totalChunks;
    });
    
    return chunks;
  }

  /**
   * Build chunk header (metadata section)
   */
  buildChunkHeader(metadata, url) {
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
    return lines.join('\n');
  }

  /**
   * Build a single chunk (for small pages)
   */
  buildSingleChunk(header, sections, url, metadata, chunkIndex, chunkTotal) {
    const content = this.buildChunkContent(header, sections);
    const baseId = crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
    
    return {
      id: chunkTotal === 1 ? baseId : `${baseId}-${chunkIndex}`,
      url,
      title: metadata.title,
      category: metadata.category,
      version: metadata.version,
      content,
      tokenEstimate: this.estimateTokens(content),
      chunkIndex: chunkTotal === 1 ? undefined : chunkIndex,
      chunkTotal: chunkTotal === 1 ? undefined : chunkTotal
    };
  }

  /**
   * Build chunk from sections (for split pages)
   */
  buildChunkFromSections(header, sections, url, metadata, chunkIndex, startSectionIndex, endSectionIndex) {
    const content = this.buildChunkContent(header, sections);
    const baseId = crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
    
    // Build section range description
    const sectionRange = sections.length === 1
      ? sections[0].heading || 'Introduction'
      : `${sections[0].heading || 'Introduction'} ... ${sections[sections.length - 1].heading || 'End'}`;
    
    return {
      id: `${baseId}-${chunkIndex}`,
      url,
      title: metadata.title,
      category: metadata.category,
      version: metadata.version,
      content,
      tokenEstimate: this.estimateTokens(content),
      chunkIndex,
      chunkTotal: undefined, // Will be set after all chunks created
      sectionRange,
      sectionStartIndex: startSectionIndex,
      sectionEndIndex: endSectionIndex
    };
  }

  /**
   * Build chunk content from header and sections
   */
  buildChunkContent(header, sections) {
    const lines = [header];
    
    // Add sections with hierarchy
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
    
    return lines.join('\n').trim();
  }

  /**
   * Estimate tokens for text (improved accuracy)
   */
  estimateTokens(text) {
    if (!text) return 0;
    
    // More accurate token estimation
    // Average: ~4 characters per token, but markdown/code increases this
    let tokens = 0;
    
    // Count words (base tokens)
    const words = text.split(/\s+/).filter(w => w.length > 0);
    tokens += words.length;
    
    // Add overhead for markdown formatting (~10%)
    const markdownChars = (text.match(/[#*_`\[\]()]/g) || []).length;
    tokens += Math.ceil(markdownChars * 0.1);
    
    // Code blocks are more token-dense (~1.5x)
    const codeBlocks = (text.match(/\[Code\]/g) || []).length;
    tokens += Math.ceil(codeBlocks * 50); // Rough estimate for code content
    
    // Tables have overhead
    const tables = (text.match(/\[Table\]/g) || []).length;
    tokens += Math.ceil(tables * 20);
    
    // Apply multiplier for general overhead (markdown, formatting, etc.)
    return Math.ceil(tokens * 1.3);
  }

  /**
   * Estimate tokens for a section
   */
  estimateSectionTokens(section) {
    let tokens = 0;
    
    // Heading tokens
    if (section.heading) {
      tokens += this.estimateTokens(section.heading);
    }
    
    // Content tokens
    if (section.content) {
      tokens += this.estimateTokens(section.content);
    }
    
    return tokens;
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
    console.log(`   Pages split:     ${this.stats.pagesSplit}`);
    
    // Calculate chunk size stats
    if (this.llmChunks.length > 0) {
      const sizes = this.llmChunks.map(c => c.tokenEstimate).sort((a, b) => b - a);
      const maxTokens = sizes[0];
      const avgTokens = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
      const largeChunks = sizes.filter(s => s > 2000).length;
      const veryLargeChunks = sizes.filter(s => s > 3000).length;
      
      console.log(`   Max chunk size:  ${maxTokens} tokens`);
      console.log(`   Avg chunk size:  ${avgTokens} tokens`);
      if (largeChunks > 0) {
        console.log(`   Large chunks (>2000): ${largeChunks}`);
      }
      if (veryLargeChunks > 0) {
        console.log(`   Very large (>3000):   ${veryLargeChunks}`);
      }
    }
    
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
