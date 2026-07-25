import type { Page } from "playwright";

import type { JsonValue } from "./json.ts";

export interface Viewport {
  width: number;
  height: number;
}

export interface ProjectCheckResult {
  id: string;
  description: string;
  pass: boolean;
  evidence?: JsonValue;
}

export interface ProjectCheck {
  id: string;
  description: string;
  evaluate: (
    page: Page,
  ) =>
    | boolean
    | { pass: boolean; evidence?: JsonValue }
    | Promise<boolean | { pass: boolean; evidence?: JsonValue }>;
}

export interface ShimonCase {
  name: string;
  path?: string;
  viewport?: Viewport;
  viewportName?: string;
  intent?: string;
  review?: string[];
  checks?: ProjectCheck[];
  prepare?: (page: Page) => Promise<void> | void;
}

export interface ShimonConfig {
  target: {
    url: string;
    viewport: Viewport;
  };
  viewports?: Record<string, Viewport>;
  cases: ShimonCase[];
  stabilize?: (page: Page) => Promise<void> | void;
  freezeAnimations: boolean;
  screenshot?: {
    mask: string[];
  };
  webServer?: {
    command: string;
    url: string;
    reuseExisting: boolean;
    timeoutMs: number;
  };
  timeouts?: {
    runMs: number;
    caseMs: number;
    navigationMs: number;
  };
}

export interface LoadedConfig {
  path: string;
  taskPath?: string;
  config: ShimonConfig;
}
