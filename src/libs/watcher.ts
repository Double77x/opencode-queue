import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Watches `file` for replacement by another process, whether or not it exists
 * yet. Watching the file itself fails on a fresh project, where the file is
 * created by the first write, so the containing directory is watched and the
 * filename filtered. That also covers atomic replace, which unlinks and renames
 * rather than writing in place.
 */
export function watchFile(file: string, onChange: () => void): () => void {
  const directory = path.dirname(file);
  const target = path.basename(file);
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;

  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 60);
  };

  const attach = async () => {
    try {
      await mkdir(directory, { recursive: true });
      watcher = watch(directory, { persistent: false }, (_event, changed) => {
        if (changed === target || changed === null) fire();
      });
      watcher.on("error", () => undefined);
    } catch {
      watcher = undefined;
    }
  };

  void attach();

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
