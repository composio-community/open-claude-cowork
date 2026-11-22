/**
 * Environment and secret validation helpers.
 * Filters out empty values and template placeholders (e.g., "your-...-here").
 */

const PLACEHOLDER_PATTERNS = [
  /^your-[a-z0-9_-]+-here$/i,
  /^(placeholder|changeme|replace_me|tu_api_key|<[^>]+>)$/i
];

export function isConfiguredSecret(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}
