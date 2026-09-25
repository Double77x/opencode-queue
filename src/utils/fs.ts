import { randomBytes } from "node:crypto";
import { open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TRANSIENT = new Set(["EACCES", "EBUSY", "EPERM", "ENOTEMPTY"]);
const RENAME_ATTEMPTS = 6;
const BACKOFF_MS = 25;

function isTransient(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return TRANSIENT.has(String(error.code));
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!isTransient(error) || attempt === RENAME_ATTEMPTS - 1) throw error;
      await delay(BACKOFF_MS * 2 ** attempt);
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r").catch(() => undefined);
  if (!handle) return;
  await handle.sync().catch(() => undefined);
  await handle.close().catch(() => undefined);
}

/**
 * Replaces `file` atomically: write to a sibling temp file, fsync it, rename
 * over the target, then fsync the directory. A reader either sees the whole old
 * document or the whole new one, never a partial write.
 */
export async function writeAtomic(file: string, contents: string): Promise<void> {
  const directory = path.dirname(file);
  const mode = await stat(file).then(
    (value) => value.mode,
    () => 0o600,
  );
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporary, file);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}
