export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(source: Record<string, unknown>, key: string, fallback = ""): string {
  const value = source[key];
  return typeof value === "string" ? value : fallback;
}

export function readBoolean(source: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

export function readCount(source: Record<string, unknown>, key: string, max: number): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 0;
  return Math.min(value, max);
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
