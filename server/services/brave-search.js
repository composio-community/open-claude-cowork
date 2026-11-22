/**
 * Brave Search API Service
 * Endpoint: https://api.search.brave.com/res/v1/llm/context
 * Uses the X-Subscription-Token header for authentication.
 * Returns LLM-optimized grounding and sources.
 */

import { isConfiguredSecret } from './env-utils.js';

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/llm/context';
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Perform a web search using Brave Search LLM Context API
 *
 * @param {Object} options
 * @param {string} options.query - Search query string
 * @param {string} [options.searchLang='es'] - Language code (e.g., 'es', 'en')
 * @param {number} [options.count=10] - Number of results to return (1..20)
 * @param {string} [options.apiKey] - Optional override for BRAVE_API_KEY
 * @returns {Promise<Object>} Search results with grounding and sources
 */
export async function searchBraveContext({
  query,
  searchLang = 'es',
  count = 10,
  apiKey = process.env.BRAVE_API_KEY
}) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('Query parameter "q" is required');
  }

  if (!isConfiguredSecret(apiKey)) {
    throw new Error('BRAVE_API_KEY is not configured in environment');
  }

  const parsedCount = Number.parseInt(count, 10);
  const safeCount = Number.isFinite(parsedCount)
    ? Math.min(20, Math.max(1, parsedCount))
    : 10;
  const safeLang = typeof searchLang === 'string' && searchLang.trim()
    ? searchLang.trim()
    : 'es';

  const url = new URL(BRAVE_API_URL);
  url.searchParams.set('q', query.trim());
  url.searchParams.set('search_lang', safeLang);
  url.searchParams.set('count', String(safeCount));

  // Always log to stderr so MCP stdio JSON-RPC on stdout stays uncorrupted
  console.error(`[BraveSearch] Requesting context for query: "${query.trim()}" (lang: ${safeLang}, count: ${safeCount})`);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey.trim()
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[BraveSearch] Error ${response.status}: ${errorText}`);
    throw new Error(`Brave Search API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  const grounding = data.grounding || {};
  const sources = data.sources ?? {};

  return {
    query: query.trim(),
    grounding,
    sources,
    raw: data
  };
}

/**
 * Format search results into a clean markdown string for LLM prompting / tool result
 */
export function formatBraveContextForLLM(result) {
  const { query, grounding = {}, sources } = result;
  let formatted = `### Brave Search Context for: "${query}"\n\n`;

  if (Array.isArray(grounding.generic) && grounding.generic.length > 0) {
    formatted += `#### Grounding Content:\n`;
    for (const item of grounding.generic) {
      formatted += `**[${item.title || 'Source'}](${item.url})**\n`;
      if (Array.isArray(item.snippets)) {
        for (const snippet of item.snippets) {
          formatted += `${snippet}\n\n`;
        }
      }
    }
  }

  if (Array.isArray(grounding.map) && grounding.map.length > 0) {
    formatted += `#### Location / Map Grounding:\n`;
    for (const place of grounding.map) {
      const label = place.title || place.name || 'Place';
      formatted += place.url ? `- **[${label}](${place.url})**` : `- **${label}**`;
      if (place.address) formatted += ` — ${place.address}`;
      formatted += '\n';
      if (Array.isArray(place.snippets)) {
        for (const snippet of place.snippets) {
          formatted += `  ${snippet}\n`;
        }
      }
    }
    formatted += '\n';
  }

  // Brave /res/v1/llm/context returns `sources` as an object keyed by URL
  const sourceEntries = Array.isArray(sources)
    ? sources.map((s) => [s.url, s])
    : sources && typeof sources === 'object'
      ? Object.entries(sources)
      : [];

  if (sourceEntries.length > 0) {
    formatted += `\n#### Sources:\n`;
    for (const [url, meta] of sourceEntries) {
      const label = meta?.title || meta?.name || meta?.hostname || url;
      const age = Array.isArray(meta?.age) && meta.age.length > 0 ? ` (${meta.age[0]})` : '';
      formatted += `- [${label}](${url})${age}\n`;
    }
  }

  return formatted.trim();
}
