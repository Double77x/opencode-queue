import { mkdir } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { writeAtomic } from "../utils/fs.ts";

const STALE_MS = 10_000;
const UPDATE_MS = 2_000;
const RETRIES = 40;

export class LockTimeoutError extends Error {
  override name = "LockTimeoutError";
  constructor(file: string, options?: { cause?: unknown }) {
    super(`Timed out waiting for the lock on ${file}`, options);
  }
}

function key(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Serialises mutations to `file` across every process that can see it. The
 * in-process chain keeps concurrent calls in one Node process ordered; the
 * file lock extends that ordering to every other OpenCode window.
 */
const chains = new Map<string, Promise<unknown>>();

function serialise<T>(file: string, work: () => Promise<T>): Promise<T> {
  const id = key(file);
  const previous = chains.get(id) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  chains.set(id, settled);
  void settled.then(() => {
    if (chains.get(id) === settled) chains.delete(id);
  });
  return next;
}

export async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  return serialise(file, async () => {
    await mkdir(path.dirname(file), { recursive: true });
    let release: () => Promise<void>;
    try {
      release = await lock(file, {
        realpath: false,
        stale: STALE_MS,
        update: UPDATE_MS,
        retries: { retries: RETRIES, factor: 1.25, minTimeout: 20, maxTimeout: 250, randomize: true },
      });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      if (code === "ELOCKED") throw new LockTimeoutError(file, { cause: error });
      throw error;
    }
    try {
      return await work();
    } finally {
      await release().catch(() => undefined);
    }
  });
}

export async function writeLocked(file: string, contents: string): Promise<void> {
  await withFileLock(file, () => writeAtomic(file, contents));
}
