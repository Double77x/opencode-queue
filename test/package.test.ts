import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  exports: Record<string, string>;
  files: string[];
};

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(full)));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** A bare specifier's package name, unwrapping subpaths like `a/b` and `@scope/a/b`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function bareImports(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[^\n;]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier && !specifier.startsWith(".") && !specifier.startsWith("node:")) {
        found.add(specifier);
      }
    }
  }
  return [...found];
}

describe("published package", () => {
  test("declares every runtime import as a real dependency", async () => {
    const missing = new Set<string>();
    for (const file of await sources(path.join(root, "src"))) {
      for (const specifier of bareImports(await readFile(file, "utf8"))) {
        const name = packageOf(specifier);
        if (!(name in manifest.dependencies)) {
          missing.add(`${name} (from ${path.relative(root, file)})`);
        }
      }
    }
    assert.deepEqual(
      [...missing],
      [],
      "The package ships raw TypeScript, so anything imported at runtime must be a dependency. " +
        "A devDependency is not installed when OpenCode installs the plugin, and the plugin silently fails to load.",
    );
  });

  test("no runtime import is left as a devDependency only", async () => {
    for (const file of await sources(path.join(root, "src"))) {
      for (const specifier of bareImports(await readFile(file, "utf8"))) {
        const name = packageOf(specifier);
        if (name in manifest.devDependencies) {
          assert.fail(`${name} is imported by ${path.relative(root, file)} but is only a devDependency`);
        }
      }
    }
  });

  test("exports the server and tui entrypoints separately", () => {
    assert.equal(manifest.exports["."], "./src/server.ts");
    assert.equal(manifest.exports["./tui"], "./src/tui.tsx");
  });

  test("the tui entrypoint is not reachable from the server export", () => {
    assert.notEqual(manifest.exports["."], manifest.exports["./tui"]);
  });

  test("ships the raw sources it claims to", () => {
    assert.ok(manifest.files.includes("src"), "the tarball must include src because there is no build step");
  });
});
