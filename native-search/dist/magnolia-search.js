/**
 * Magnolia Docs Search Client
 * 
 * A lightweight client-side search library with:
 * - Fuzzy matching
 * - Version filtering
 * - Relevance scoring
 * - No external dependencies
 */

(function(global) {
  'use strict';

  class MagnoliaSearch {
    constructor(options = {}) {
      this.index = [];
      this.loaded = false;
      this.indexUrl = options.indexUrl || '/search-data/search-index.min.json';
      this.onReady = options.onReady || function() {};
      
      // Search configuration
      this.config = {
        minQueryLength: 2,
        maxResults: 20,
        fuzzyThreshold: 0.4,  // 0 = exact, 1 = very fuzzy
        fieldWeights: {
          title: 10,
          heading: 8,
          content: 3,
          breadcrumb: 2
        }
      };
    }

    /**
     * Load the search index
     */
    async load() {
      if (this.loaded) return;
      
      try {
        const response = await fetch(this.indexUrl);
        if (!response.ok) throw new Error('Failed to load search index');
        
        this.index = await response.json();
        this.loaded = true;
        
        // Build inverted index for faster lookups
        this._buildInvertedIndex();
        
        this.onReady();
      } catch (err) {
        console.error('MagnoliaSearch: Failed to load index', err);
        throw err;
      }
    }

    /**
     * Build inverted index for faster search
     */
    _buildInvertedIndex() {
      this.invertedIndex = {};
      
      this.index.forEach((doc, docIndex) => {
        const text = doc._searchText || '';
        const words = this._tokenize(text);
        
        words.forEach(word => {
          if (!this.invertedIndex[word]) {
            this.invertedIndex[word] = [];
          }
          if (!this.invertedIndex[word].includes(docIndex)) {
            this.invertedIndex[word].push(docIndex);
          }
        });
      });
    }

    /**
     * Tokenize text into searchable words
     */
    _tokenize(text) {
      return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length >= 2);
    }

    /**
     * Search the index
     */
    search(query, options = {}) {
      if (!this.loaded) {
        console.warn('MagnoliaSearch: Index not loaded yet');
        return [];
      }
      
      query = (query || '').trim().toLowerCase();
      
      if (query.length < this.config.minQueryLength) {
        return [];
      }
      
      const filters = {
        version: options.version || null,
        category: options.category || null
      };
      
      const maxResults = options.maxResults || this.config.maxResults;
      
      // Tokenize query
      const queryTerms = this._tokenize(query);
      
      if (queryTerms.length === 0) {
        return [];
      }
      
      // Find candidate documents
      const candidates = this._findCandidates(queryTerms);
      
      // Score and rank
      const scored = candidates.map(docIndex => {
        const doc = this.index[docIndex];
        
        // Apply filters
        if (filters.version && doc.version !== filters.version) {
          return null;
        }
        if (filters.category && doc.category !== filters.category) {
          return null;
        }
        
        const score = this._scoreDocument(doc, queryTerms, query);
        
        return { doc, score };
      }).filter(Boolean);
      
      // Sort by score (descending) and return top results
      scored.sort((a, b) => b.score - a.score);
      
      return scored.slice(0, maxResults).map(item => ({
        ...item.doc,
        _score: item.score
      }));
    }

    /**
     * Find candidate documents that might match
     */
    _findCandidates(queryTerms) {
      const candidates = new Set();
      
      queryTerms.forEach(term => {
        // Exact matches
        if (this.invertedIndex[term]) {
          this.invertedIndex[term].forEach(idx => candidates.add(idx));
        }
        
        // Prefix matches
        Object.keys(this.invertedIndex).forEach(indexedWord => {
          if (indexedWord.startsWith(term) || term.startsWith(indexedWord)) {
            this.invertedIndex[indexedWord].forEach(idx => candidates.add(idx));
          }
        });
        
        // Fuzzy matches for longer terms
        if (term.length >= 4) {
          Object.keys(this.invertedIndex).forEach(indexedWord => {
            if (this._fuzzyMatch(term, indexedWord)) {
              this.invertedIndex[indexedWord].forEach(idx => candidates.add(idx));
            }
          });
        }
      });
      
      return Array.from(candidates);
    }

    /**
     * Score a document against query terms
     */
    _scoreDocument(doc, queryTerms, fullQuery) {
      let score = 0;
      
      const title = (doc.title || '').toLowerCase();
      const heading = (doc.heading || '').toLowerCase();
      const content = (doc.fullContent || doc.content || '').toLowerCase();
      const breadcrumb = (doc.breadcrumb || []).join(' ').toLowerCase();
      
      // Exact phrase match bonus
      if (title.includes(fullQuery)) {
        score += 100;
      }
      if (heading.includes(fullQuery)) {
        score += 80;
      }
      
      // Per-term scoring
      queryTerms.forEach(term => {
        // Title matches
        if (title.includes(term)) {
          score += this.config.fieldWeights.title;
          // Bonus for title starting with term
          if (title.startsWith(term)) {
            score += 15;
          }
        }
        
        // Heading matches
        if (heading && heading.includes(term)) {
          score += this.config.fieldWeights.heading;
        }
        
        // Content matches
        if (content.includes(term)) {
          score += this.config.fieldWeights.content;
          // Bonus for multiple occurrences (diminishing returns)
          const count = (content.match(new RegExp(term, 'g')) || []).length;
          score += Math.min(count * 0.5, 5);
        }
        
        // Breadcrumb matches
        if (breadcrumb.includes(term)) {
          score += this.config.fieldWeights.breadcrumb;
        }
      });
      
      // Boost shorter titles (more specific)
      if (title.length < 30) {
        score *= 1.2;
      }
      
      // Boost heading level 1 & 2
      if (doc.headingLevel && doc.headingLevel <= 2) {
        score *= 1.1;
      }
      
      return score;
    }

    /**
     * Simple fuzzy matching using Levenshtein distance
     */
    _fuzzyMatch(a, b) {
      if (Math.abs(a.length - b.length) > 2) return false;
      
      const distance = this._levenshtein(a, b);
      const maxLength = Math.max(a.length, b.length);
      const similarity = 1 - (distance / maxLength);
      
      return similarity >= (1 - this.config.fuzzyThreshold);
    }

    /**
     * Levenshtein distance calculation
     */
    _levenshtein(a, b) {
      const matrix = [];
      
      for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
      }
      
      for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
      }
      
      for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
          if (b.charAt(i - 1) === a.charAt(j - 1)) {
            matrix[i][j] = matrix[i - 1][j - 1];
          } else {
            matrix[i][j] = Math.min(
              matrix[i - 1][j - 1] + 1,
              matrix[i][j - 1] + 1,
              matrix[i - 1][j] + 1
            );
          }
        }
      }
      
      return matrix[b.length][a.length];
    }

    /**
     * Get available categories
     */
    getCategories() {
      if (!this.loaded) return [];
      return [...new Set(this.index.map(doc => doc.category))].sort();
    }

    /**
     * Get available versions
     */
    getVersions() {
      if (!this.loaded) return [];
      return [...new Set(this.index.map(doc => doc.version))].sort();
    }

    /**
     * Highlight matching terms in text
     */
    highlight(text, query, tag = 'mark') {
      if (!text || !query) return text;
      
      const terms = this._tokenize(query);
      let result = text;
      
      terms.forEach(term => {
        const regex = new RegExp(`(${this._escapeRegex(term)})`, 'gi');
        result = result.replace(regex, `<${tag}>$1</${tag}>`);
      });
      
      return result;
    }

    /**
     * Escape regex special characters
     */
    _escapeRegex(str) {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MagnoliaSearch;
  } else {
    global.MagnoliaSearch = MagnoliaSearch;
  }

})(typeof window !== 'undefined' ? window : global);
/**
 * Magnolia Docs AI Assistant
 * 
 * Provides AI-powered answers using:
 * - Semantic search over LLM-optimized chunks
 * - Context retrieval for accurate responses
 * - Streaming responses
 */

class MagnoliaAI {
  constructor(options = {}) {
    this.chunksUrl = options.chunksUrl || '/search-data/llm-chunks.json';
    this.apiEndpoint = options.apiEndpoint || '/api/ask'; // Your backend endpoint
    this.apiKey = options.apiKey || null; // If calling provider directly (not recommended)
    this.provider = options.provider || 'anthropic'; // 'anthropic' | 'openai'
    
    this.chunks = [];
    this.loaded = false;
    
    // Configuration
    this.config = {
      maxContextChunks: 5,        // Max chunks to include in context
      maxContextTokens: 8000,     // Max tokens for context
      minRelevanceScore: 0.3,     // Minimum relevance to include
    };
    
    // Simple keyword-based embedding (for POC - use real embeddings in production)
    this.chunkKeywords = [];
  }

  /**
   * Load LLM chunks
   */
  async load() {
    if (this.loaded) return;
    
    try {
      const response = await fetch(this.chunksUrl);
      if (!response.ok) throw new Error('Failed to load LLM chunks');
      
      this.chunks = await response.json();
      this.loaded = true;
      
      // Pre-compute keywords for each chunk
      this._buildKeywordIndex();
      
      console.log(`MagnoliaAI: Loaded ${this.chunks.length} chunks`);
    } catch (err) {
      console.error('MagnoliaAI: Failed to load chunks', err);
      throw err;
    }
  }

  /**
   * Build keyword index for similarity matching
   */
  _buildKeywordIndex() {
    this.chunkKeywords = this.chunks.map(chunk => {
      const text = `${chunk.title} ${chunk.content}`.toLowerCase();
      return this._extractKeywords(text);
    });
  }

  /**
   * Extract keywords from text
   */
  _extractKeywords(text) {
    // Remove common words and extract meaningful terms
    const stopwords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that',
      'these', 'those', 'it', 'its', 'you', 'your', 'we', 'our', 'they',
      'their', 'which', 'what', 'who', 'when', 'where', 'how', 'all',
      'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
      'such', 'no', 'not', 'only', 'same', 'so', 'than', 'too', 'very'
    ]);
    
    const words = text
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length >= 3 && !stopwords.has(word));
    
    // Count frequency
    const freq = {};
    words.forEach(word => {
      freq[word] = (freq[word] || 0) + 1;
    });
    
    // Return unique keywords sorted by frequency
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([word]) => word);
  }

  /**
   * Find relevant chunks for a question
   */
  findRelevantChunks(question, options = {}) {
    if (!this.loaded) {
      throw new Error('MagnoliaAI: Chunks not loaded');
    }
    
    const maxChunks = options.maxChunks || this.config.maxContextChunks;
    const filter = options.filter || {};
    
    const queryKeywords = this._extractKeywords(question.toLowerCase());
    
    // Score each chunk
    const scored = this.chunks.map((chunk, index) => {
      // Apply filters
      if (filter.version && chunk.version !== filter.version) {
        return null;
      }
      if (filter.category && chunk.category !== filter.category) {
        return null;
      }
      
      // Calculate similarity score
      const chunkKw = this.chunkKeywords[index];
      const score = this._calculateSimilarity(queryKeywords, chunkKw, chunk, question);
      
      return { chunk, score };
    }).filter(Boolean);
    
    // Sort by score and return top chunks
    scored.sort((a, b) => b.score - a.score);
    
    const results = scored
      .filter(item => item.score >= this.config.minRelevanceScore)
      .slice(0, maxChunks);
    
    return results;
  }

  /**
   * Calculate similarity between query and chunk
   */
  _calculateSimilarity(queryKeywords, chunkKeywords, chunk, question) {
    const questionLower = question.toLowerCase();
    const titleLower = chunk.title.toLowerCase();
    const contentLower = chunk.content.toLowerCase();
    
    let score = 0;
    
    // Title exact match
    if (titleLower.includes(questionLower)) {
      score += 50;
    }
    
    // Keyword overlap
    const chunkSet = new Set(chunkKeywords);
    let matchCount = 0;
    
    queryKeywords.forEach(keyword => {
      if (chunkSet.has(keyword)) {
        matchCount++;
        // Bonus for title keyword match
        if (titleLower.includes(keyword)) {
          score += 5;
        }
      }
      // Partial/prefix match
      chunkKeywords.forEach(ck => {
        if (ck.startsWith(keyword) || keyword.startsWith(ck)) {
          matchCount += 0.5;
        }
      });
    });
    
    // Jaccard-like similarity
    const union = new Set([...queryKeywords, ...chunkKeywords]).size;
    score += (matchCount / union) * 100;
    
    // Boost for shorter chunks (more specific)
    if (chunk.tokenEstimate < 500) {
      score *= 1.1;
    }
    
    return score;
  }

  /**
   * Build context from relevant chunks
   */
  buildContext(relevantChunks) {
    let context = '';
    let totalTokens = 0;
    
    const chunks = relevantChunks.map(r => r.chunk);
    
    for (const chunk of chunks) {
      if (totalTokens + chunk.tokenEstimate > this.config.maxContextTokens) {
        break;
      }
      
      context += `\n\n---\n\n${chunk.content}`;
      totalTokens += chunk.tokenEstimate;
    }
    
    return {
      context: context.trim(),
      tokenEstimate: totalTokens,
      sources: chunks.map(c => ({ title: c.title, url: c.url }))
    };
  }

  /**
   * Ask a question (requires backend or direct API access)
   */
  async ask(question, options = {}) {
    if (!this.loaded) {
      await this.load();
    }
    
    // Find relevant context
    const relevantChunks = this.findRelevantChunks(question, {
      maxChunks: options.maxChunks || this.config.maxContextChunks,
      filter: options.filter || {}
    });
    
    if (relevantChunks.length === 0) {
      return {
        answer: "I couldn't find relevant documentation to answer your question. Try rephrasing or being more specific.",
        sources: [],
        context: null
      };
    }
    
    const { context, sources } = this.buildContext(relevantChunks);
    
    // Build prompt
    const systemPrompt = `You are a helpful assistant for Magnolia CMS documentation. 
Answer questions based ONLY on the provided documentation context.
If the context doesn't contain enough information to fully answer, say so.
Always cite specific pages when possible.
Be concise but thorough.`;
    
    const userPrompt = `Documentation Context:
${context}

---

Question: ${question}

Please answer based on the documentation above. Cite relevant pages.`;

    // If using backend endpoint
    if (this.apiEndpoint && !this.apiKey) {
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          context,
          sources,
          systemPrompt,
          userPrompt
        })
      });
      
      if (!response.ok) {
        throw new Error('Failed to get AI response');
      }
      
      const data = await response.json();
      return {
        answer: data.answer,
        sources,
        context
      };
    }
    
    // Direct API call (for testing only - don't expose API keys in frontend!)
    if (this.apiKey) {
      const answer = await this._callLLMDirect(systemPrompt, userPrompt);
      return {
        answer,
        sources,
        context
      };
    }
    
    // No API configured - return context for manual use
    return {
      answer: null,
      sources,
      context,
      prompt: userPrompt,
      systemPrompt
    };
  }

  /**
   * Direct LLM call (for development/testing only)
   */
  async _callLLMDirect(systemPrompt, userPrompt) {
    if (this.provider === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
      
      const data = await response.json();
      return data.content[0].text;
    }
    
    if (this.provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4-turbo-preview',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 1024
        })
      });
      
      const data = await response.json();
      return data.choices[0].message.content;
    }
    
    throw new Error(`Unknown provider: ${this.provider}`);
  }

  /**
   * Stream a response (if using backend with streaming support)
   */
  async *askStream(question, options = {}) {
    if (!this.loaded) {
      await this.load();
    }
    
    const relevantChunks = this.findRelevantChunks(question, {
      filter: options.filter || {}
    });
    
    const { context, sources } = this.buildContext(relevantChunks);
    
    // Yield sources first
    yield { type: 'sources', sources };
    
    const response = await fetch(this.apiEndpoint + '/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, context })
    });
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value);
      yield { type: 'text', text };
    }
    
    yield { type: 'done' };
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MagnoliaAI;
} else if (typeof window !== 'undefined') {
  window.MagnoliaAI = MagnoliaAI;
}
/**
 * Magnolia Docs Search UI
 * 
 * A drop-in search interface with:
 * - Modal search dialog
 * - Version filtering
 * - AI assistant integration
 * - Keyboard shortcuts
 */

(function(global) {
  'use strict';

  class MagnoliaSearchUI {
    constructor(options = {}) {
      this.options = {
        container: options.container || '#searchBar',
        indexUrl: options.indexUrl || '/search-data/search-index.min.json',
        chunksUrl: options.chunksUrl || '/search-data/llm-chunks.json',
        aiEndpoint: options.aiEndpoint || null,
        placeholder: options.placeholder || 'Search documentation...',
        hotkey: options.hotkey || '/',
        enableAI: options.enableAI !== false,
        ...options
      };
      
      this.search = null;
      this.ai = null;
      this.modal = null;
      this.currentFilter = '';
      this.isOpen = false;
      
      this.init();
    }

    async init() {
      // Initialize search
      this.search = new MagnoliaSearch({
        indexUrl: this.options.indexUrl,
        onReady: () => console.log('Search ready')
      });
      
      // Initialize AI if enabled
      if (this.options.enableAI) {
        this.ai = new MagnoliaAI({
          chunksUrl: this.options.chunksUrl,
          apiEndpoint: this.options.aiEndpoint
        });
      }
      
      // Create UI elements
      this.createTrigger();
      this.createModal();
      this.bindEvents();
      
      // Load search index in background
      this.search.load().catch(err => console.warn('Search load failed:', err));
    }

    createTrigger() {
      const container = document.querySelector(this.options.container);
      if (!container) {
        console.warn('MagnoliaSearchUI: Container not found');
        return;
      }
      
      container.innerHTML = `
        <button type="button" class="mgnl-search-trigger" aria-label="Search">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/>
            <path d="M21 21l-4.35-4.35"/>
          </svg>
          <span class="mgnl-search-trigger__text">${this.options.placeholder}</span>
          <kbd class="mgnl-search-trigger__kbd">${this.options.hotkey}</kbd>
        </button>
      `;
      
      container.querySelector('.mgnl-search-trigger').addEventListener('click', () => this.open());
    }

    createModal() {
      // Remove existing modal if any
      const existing = document.querySelector('.mgnl-search-modal');
      if (existing) existing.remove();
      
      const modal = document.createElement('div');
      modal.className = 'mgnl-search-modal';
      modal.innerHTML = `
        <div class="mgnl-search-modal__backdrop"></div>
        <div class="mgnl-search-modal__container">
          <div class="mgnl-search-modal__header">
            <div class="mgnl-search-modal__input-wrap">
              <svg class="mgnl-search-modal__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/>
                <path d="M21 21l-4.35-4.35"/>
              </svg>
              <input 
                type="text" 
                class="mgnl-search-modal__input" 
                placeholder="${this.options.placeholder}"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
              />
              <button type="button" class="mgnl-search-modal__close" aria-label="Close">
                <kbd>esc</kbd>
              </button>
            </div>
            <div class="mgnl-search-modal__filters">
              <button type="button" class="mgnl-search-filter active" data-filter="">All</button>
              <button type="button" class="mgnl-search-filter" data-filter="latest">6.4</button>
              <button type="button" class="mgnl-search-filter" data-filter="6.3">6.3</button>
              <button type="button" class="mgnl-search-filter" data-filter="6.2">6.2</button>
              <button type="button" class="mgnl-search-filter" data-filter="cloud">Cloud</button>
              <button type="button" class="mgnl-search-filter" data-filter="modules">Modules</button>
            </div>
          </div>
          <div class="mgnl-search-modal__body">
            <div class="mgnl-search-results"></div>
            ${this.options.enableAI ? `
            <div class="mgnl-search-ai">
              <button type="button" class="mgnl-search-ai__trigger">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2a10 10 0 1 0 10 10H12V2z"/>
                  <path d="M12 2a10 10 0 0 1 10 10"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
                Ask AI about this
              </button>
              <div class="mgnl-search-ai__response"></div>
            </div>
            ` : ''}
          </div>
          <div class="mgnl-search-modal__footer">
            <div class="mgnl-search-modal__hints">
              <span><kbd>↵</kbd> to select</span>
              <span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span>
              <span><kbd>esc</kbd> to close</span>
            </div>
            <div class="mgnl-search-modal__branding">
              Powered by Magnolia Search
            </div>
          </div>
        </div>
      `;
      
      document.body.appendChild(modal);
      this.modal = modal;
    }

    bindEvents() {
      // Backdrop click
      this.modal.querySelector('.mgnl-search-modal__backdrop').addEventListener('click', () => this.close());
      
      // Close button
      this.modal.querySelector('.mgnl-search-modal__close').addEventListener('click', () => this.close());
      
      // Input
      const input = this.modal.querySelector('.mgnl-search-modal__input');
      let debounceTimer;
      
      input.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.performSearch(e.target.value);
        }, 150);
      });
      
      // Filter buttons
      this.modal.querySelectorAll('.mgnl-search-filter').forEach(btn => {
        btn.addEventListener('click', (e) => {
          this.modal.querySelectorAll('.mgnl-search-filter').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.currentFilter = btn.dataset.filter;
          this.performSearch(input.value);
        });
      });
      
      // Keyboard navigation
      input.addEventListener('keydown', (e) => this.handleKeydown(e));
      
      // Global hotkey
      document.addEventListener('keydown', (e) => {
        if (e.key === this.options.hotkey && !this.isInputFocused()) {
          e.preventDefault();
          this.open();
        }
        if (e.key === 'Escape' && this.isOpen) {
          this.close();
        }
      });
      
      // AI trigger
      if (this.options.enableAI) {
        const aiTrigger = this.modal.querySelector('.mgnl-search-ai__trigger');
        if (aiTrigger) {
          aiTrigger.addEventListener('click', () => {
            const query = this.modal.querySelector('.mgnl-search-modal__input').value;
            this.askAI(query);
          });
        }
      }
    }

    isInputFocused() {
      const active = document.activeElement;
      return active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    }

    open() {
      this.modal.classList.add('is-open');
      this.isOpen = true;
      
      const input = this.modal.querySelector('.mgnl-search-modal__input');
      setTimeout(() => input.focus(), 50);
      
      document.body.style.overflow = 'hidden';
    }

    close() {
      this.modal.classList.remove('is-open');
      this.isOpen = false;
      
      document.body.style.overflow = '';
      
      // Clear results
      this.modal.querySelector('.mgnl-search-results').innerHTML = '';
      this.modal.querySelector('.mgnl-search-modal__input').value = '';
    }

    performSearch(query) {
      const resultsContainer = this.modal.querySelector('.mgnl-search-results');
      
      if (!query || query.length < 2) {
        resultsContainer.innerHTML = '<div class="mgnl-search-empty">Type to search...</div>';
        return;
      }
      
      const results = this.search.search(query, {
        version: this.currentFilter || null,
        maxResults: 15
      });
      
      if (results.length === 0) {
        resultsContainer.innerHTML = '<div class="mgnl-search-empty">No results found</div>';
        return;
      }
      
      resultsContainer.innerHTML = results.map((result, index) => `
        <a href="${result.url}" class="mgnl-search-result${index === 0 ? ' is-selected' : ''}">
          <div class="mgnl-search-result__category">${result.category}</div>
          <div class="mgnl-search-result__title">${this.search.highlight(result.title, query)}</div>
          ${result.heading && result.heading !== result.title ? `
            <div class="mgnl-search-result__heading">${this.search.highlight(result.heading, query)}</div>
          ` : ''}
          <div class="mgnl-search-result__content">${this.search.highlight(result.content, query)}</div>
        </a>
      `).join('');
      
      // Add click handlers
      resultsContainer.querySelectorAll('.mgnl-search-result').forEach(el => {
        el.addEventListener('click', () => this.close());
      });
    }

    handleKeydown(e) {
      const results = this.modal.querySelectorAll('.mgnl-search-result');
      if (results.length === 0) return;
      
      const selected = this.modal.querySelector('.mgnl-search-result.is-selected');
      let index = Array.from(results).indexOf(selected);
      
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        index = Math.min(index + 1, results.length - 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        index = Math.max(index - 1, 0);
      } else if (e.key === 'Enter' && selected) {
        e.preventDefault();
        selected.click();
        return;
      } else {
        return;
      }
      
      results.forEach(r => r.classList.remove('is-selected'));
      results[index].classList.add('is-selected');
      results[index].scrollIntoView({ block: 'nearest' });
    }

    async askAI(query) {
      if (!this.ai || !query) return;
      
      const responseContainer = this.modal.querySelector('.mgnl-search-ai__response');
      responseContainer.innerHTML = '<div class="mgnl-search-ai__loading">Thinking...</div>';
      responseContainer.style.display = 'block';
      
      try {
        await this.ai.load();
        
        const result = await this.ai.ask(query, {
          filter: this.currentFilter ? { version: this.currentFilter } : {}
        });
        
        if (result.answer) {
          responseContainer.innerHTML = `
            <div class="mgnl-search-ai__answer">${this.formatMarkdown(result.answer)}</div>
            <div class="mgnl-search-ai__sources">
              <strong>Sources:</strong>
              ${result.sources.map(s => `<a href="${s.url}">${s.title}</a>`).join(', ')}
            </div>
          `;
        } else {
          responseContainer.innerHTML = `
            <div class="mgnl-search-ai__notice">
              AI backend not configured. Relevant context found:
            </div>
            <div class="mgnl-search-ai__sources">
              ${result.sources.map(s => `<a href="${s.url}">${s.title}</a>`).join('<br>')}
            </div>
          `;
        }
      } catch (err) {
        responseContainer.innerHTML = `<div class="mgnl-search-ai__error">Error: ${err.message}</div>`;
      }
    }

    formatMarkdown(text) {
      // Simple markdown formatting
      return text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
    }
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MagnoliaSearchUI;
  } else {
    global.MagnoliaSearchUI = MagnoliaSearchUI;
  }

})(typeof window !== 'undefined' ? window : global);
