import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../libs/lock.ts";
import { type Arming, parseArming } from "../core/autorun.ts";
import { writeAtomic } from "../utils/fs.ts";

const FILE_NAME = "autorun.json";

export function armingFile(worktree: string): string {
  return path.join(worktree, ".opencode", FILE_NAME);
}

/** Undefined means "off". A missing, empty, or corrupt file all read as off. */
export async function readArming(worktree: string): Promise<Arming | undefined> {
  let raw: string;
  try {
    raw = await readFile(armingFile(worktree), "utf8");
  } catch {
    return undefined;
  }
  return parseArming(raw);
}

export async function writeArming(worktree: string, arming: Arming | undefined): Promise<void> {
  const file = armingFile(worktree);
  await withFileLock(file, async () => {
    if (arming === undefined) {
      await unlink(file).catch(() => undefined);
      return;
    }
    await writeAtomic(file, `${JSON.stringify(arming, null, 2)}\n`);
  });
}
