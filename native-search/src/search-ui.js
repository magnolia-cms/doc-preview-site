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
