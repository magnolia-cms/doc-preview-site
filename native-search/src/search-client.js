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

    _buildInvertedIndex() {
      // Use Object.create(null) to avoid prototype property conflicts
      this.invertedIndex = Object.create(null);
      
      for (var docIndex = 0; docIndex < this.index.length; docIndex++) {
        var doc = this.index[docIndex];
        var text = doc._searchText || '';
        var words = this._tokenize(text);
        
        for (var i = 0; i < words.length; i++) {
          var word = words[i];
          // Skip words that could conflict with object properties
          if (word === 'constructor' || word === '__proto__' || word === 'prototype') {
            continue;
          }
          if (!(word in this.invertedIndex)) {
            this.invertedIndex[word] = [];
          }
          var arr = this.invertedIndex[word];
          if (arr.indexOf(docIndex) === -1) {
            arr.push(docIndex);
          }
        }
      }
      
      console.log('MagnoliaSearch: Built inverted index with', Object.keys(this.invertedIndex).length, 'terms from', this.index.length, 'documents');
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
