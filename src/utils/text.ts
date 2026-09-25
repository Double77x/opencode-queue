const ELLIPSIS = "…";

/**
 * Truncates on code points, not UTF-16 units, so an emoji or a combining mark
 * is never split in half. The ellipsis is counted inside the budget.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max - 1).join("") + ELLIPSIS;
}
