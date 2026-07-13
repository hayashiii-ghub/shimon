import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalStringify, type JsonValue } from "./canonicalize.ts";

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function artifactPath(root: string, label: string): string {
  if (!LABEL_PATTERN.test(label) || label === "." || label === "..") {
    throw new Error(
      `Invalid label ${JSON.stringify(label)}; use 1-128 letters, numbers, dots, dashes, or underscores.`,
    );
  }

  return join(root, `${label}.json`);
}

export async function writeArtifact(
  root: string,
  label: string,
  artifact: JsonValue,
): Promise<string> {
  const destination = artifactPath(root, label);
  await mkdir(root, { recursive: true });

  const temporary = join(root, `.${label}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, canonicalStringify(artifact), { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }

  return destination;
}

export async function readArtifact(root: string, label: string): Promise<JsonValue> {
  const source = artifactPath(root, label);
  return JSON.parse(await readFile(source, "utf8")) as JsonValue;
}
