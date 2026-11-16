// Removes em dashes (and en dashes used as dashes) from generated prose.
//
// The author does not want dashes in published text, and the GPT models put one in
// roughly 40% of the podcast annotations (test of 2026-11-16). Prompting alone does
// not hold, so the annotate preset runs its prose fields through this after parsing.
// Numeric ranges written with an en dash ("1990–2000", "p. 12–15") are kept.

export function stripDashes(text: string): string {
  if (!text) return text;
  let s = text;
  // Leading dash at the start of the text or of a line: drop it.
  s = s.replace(/(^|\n)\s*[—–]\s*/g, "$1");
  // Em dash anywhere, en dash only when spaced (unspaced en dash is a range).
  s = s.replace(/\s*—\s*/g, ", ");
  s = s.replace(/\s+–\s+/g, ", ");
  // Tidy what the replacement can leave behind.
  s = s.replace(/,\s*([,.;:!?])/g, "$1");
  s = s.replace(/([(\[])\s*,\s*/g, "$1");
  s = s.replace(/,\s*$/g, "");
  s = s.replace(/ {2,}/g, " ");
  return s;
}

