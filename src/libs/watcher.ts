import { watch, type FSWatcher } from "node:fs";

/**
 * Calls `onChange` when `file` is replaced by another process. Editors and
 * atomic renames fire several events per save, so callers debounce.
 */
export function watchFile(file: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;

  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 60);
  };

  try {
    watcher = watch(file, { persistent: false }, fire);
    watcher.on("error", () => undefined);
  } catch {
    watcher = undefined;
  }

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
