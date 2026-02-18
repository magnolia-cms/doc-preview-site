/**
 * Shared utilities for Magnolia Docs native search tools.
 * 
 * Used by both the search indexer and the markdown generator
 * to ensure consistent URL categorization, page path derivation,
 * and skip logic.
 */

/**
 * Categorize a URL by documentation area and version.
 * 
 * @param {string} url - Full page URL
 * @returns {{ category: string, version: string }}
 */
function categorizeUrl(url) {
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
   * Convert a full page URL to a relative path for the corresponding
   * LLM-friendly .txt file under search-data/pages/.
   * 
   * Example:
   *   https://docs.magnolia-cms.com/product-docs/6.3/content-types/
   *   → pages/product-docs--6-3--content-types.txt
   * 
   * @param {string} url - Full page URL
   * @param {string} baseUrl - Site base URL to strip
   * @returns {string} Relative path like "pages/some--page--path.txt"
   */
  function urlToPagePath(url, baseUrl) {
    // Strip the base URL to get the path portion
    let pagePath = url.replace(baseUrl, '');
  
    // Remove leading/trailing slashes
    pagePath = pagePath.replace(/^\/+/, '').replace(/\/+$/, '');
  
    // Replace path separators and dots with double dashes
    pagePath = pagePath.replace(/\//g, '--').replace(/\./g, '-');
  
    // Clean up any triple+ dashes from edge cases
    pagePath = pagePath.replace(/-{3,}/g, '--');
  
    return 'pages/' + pagePath + '.txt';
  }
  
  /**
   * Create a URL-safe slug from text.
   * 
   * @param {string} text
   * @returns {string}
   */
  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
  
  /**
   * Convert a relative file path to a full URL.
   * 
   * @param {string} relativePath - Path relative to site root
   * @param {string} baseUrl - Site base URL
   * @returns {string} Full URL
   */
  function pathToUrl(relativePath, baseUrl) {
    let url = relativePath
      .replace(/\\/g, '/')
      .replace(/index\.html$/, '')
      .replace(/\.html$/, '/');
  
    if (!url.endsWith('/')) url += '/';
    if (!url.startsWith('/')) url = '/' + url;
  
    return baseUrl + url;
  }
  
  module.exports = {
    categorizeUrl,
    urlToPagePath,
    slugify,
    pathToUrl
  };