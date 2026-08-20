import { randomUUID } from "node:crypto";
import { access, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function pruneRunDirectories(root: string, keep: number): Promise<string[]> {
  const runs = join(root, "runs");
  const entries = await readdir(runs, { withFileTypes: true }).catch(() => []);
  const directories = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(runs, entry.name);
          const manifest = join(path, "manifest.json");
          if (!(await access(manifest).then(() => true).catch(() => false))) return null;
          return { path, mtimeMs: (await stat(manifest)).mtimeMs };
        }),
    )
  ).filter((entry): entry is { path: string; mtimeMs: number } => entry !== null);
  directories.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  const removed = directories.slice(0, Math.max(0, directories.length - keep)).map((entry) => entry.path);
  await Promise.all(removed.map((path) => rm(path, { recursive: true, force: true })));
  return removed;
}
