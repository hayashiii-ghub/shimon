import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalStringify, type JsonValue } from "./canonicalize.ts";
import { ShimonError } from "./errors.ts";

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isViewport(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.width) &&
    (value.width as number) > 0 &&
    Number.isInteger(value.height) &&
    (value.height as number) > 0
  );
}

function isFingerprintArtifact(value: Record<string, unknown>): boolean {
  if (!isRecord(value.target) || typeof value.target.url !== "string") return false;
  if (!isRecord(value.environment)) return false;
  const environment = value.environment;
  if (
    typeof environment.browser !== "string" ||
    typeof environment.browserVersion !== "string" ||
    !isViewport(environment.viewport) ||
    typeof environment.deviceScaleFactor !== "number" ||
    !Number.isFinite(environment.deviceScaleFactor) ||
    typeof environment.locale !== "string" ||
    typeof environment.timezone !== "string"
  ) {
    return false;
  }
  if (!Array.isArray(value.cases)) return false;
  return value.cases.every(
    (testCase) =>
      isRecord(testCase) &&
      typeof testCase.name === "string" &&
      isViewport(testCase.viewport) &&
      Object.hasOwn(testCase, "probe"),
  );
}

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
  let artifact: unknown;
  try {
    artifact = JSON.parse(await readFile(source, "utf8"));
  } catch (error) {
    throw new ShimonError("artifact_invalid", `Could not read artifact: ${source}`, undefined, {
      cause: error,
    });
  }

  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new ShimonError("artifact_invalid", `Artifact must be a JSON object: ${source}`);
  }
  const value = artifact as Record<string, unknown>;
  if (value.schemaVersion !== 2) {
    throw new ShimonError(
      "artifact_incompatible",
      `Artifact schema ${String(value.schemaVersion)} is not supported: ${source}`,
      "Capture a fresh artifact with this shimon version.",
    );
  }
  if (typeof value.toolVersion !== "string" || !isFingerprintArtifact(value)) {
    throw new ShimonError("artifact_invalid", `Artifact is missing required fields: ${source}`);
  }

  return artifact as JsonValue;
}
