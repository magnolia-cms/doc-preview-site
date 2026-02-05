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
