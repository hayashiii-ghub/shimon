import type { Page } from "playwright";

import { asJsonValue } from "./case-runner.ts";
import { ShimonError } from "./errors.ts";
import type { ProjectCheck, ProjectCheckResult } from "./types.ts";

type Execute = <T>(promise: Promise<T>) => Promise<T>;

export async function runProjectChecks(
  page: Page,
  checks: ProjectCheck[] = [],
  execute: Execute = async (promise) => promise,
): Promise<ProjectCheckResult[]> {
  const results: ProjectCheckResult[] = [];
  for (const check of checks) {
    const value = await execute(Promise.resolve().then(() => check.evaluate(page)));
    if (typeof value === "boolean") {
      results.push({ id: check.id, description: check.description, pass: value });
      continue;
    }
    if (value === null || typeof value !== "object" || typeof value.pass !== "boolean") {
      throw new ShimonError(
        "check_invalid",
        `Check ${check.id} must return a boolean or { pass, evidence? }.`,
      );
    }
    results.push({
      id: check.id,
      description: check.description,
      pass: value.pass,
      ...(value.evidence === undefined
        ? {}
        : { evidence: asJsonValue(value.evidence, `checks.${check.id}.evidence`) }),
    });
  }
  return results;
}
