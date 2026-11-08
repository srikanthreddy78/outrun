/**
 * Scrubs card numbers, national ids and secret-shaped tokens from anything a crew tool
 * returns. Ported from caseloop's scrub_pii, plus API-key shapes so a result never
 * carries a secret.
 */
const PATTERNS: [RegExp, string][] = [
  [/\b(?:\d[ -]?){13,19}\b/g, "[card number removed]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[id number removed]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, "[secret removed]"],
  [/\b(?:monid_live|whsec|apify_api|pat-na1)[_-][A-Za-z0-9-]{8,}\b/g, "[secret removed]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, "Bearer [secret removed]"],
];

export function scrubText(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrubText(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out as T;
  }
  return value;
}
