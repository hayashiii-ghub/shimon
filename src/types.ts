import type { Page } from "playwright";

import type { JsonValue } from "./canonicalize.ts";

export interface Viewport {
  width: number;
  height: number;
}

export interface ShimonCase {
  name: string;
  prepare?: (page: Page) => Promise<void> | void;
}

export interface ShimonConfig {
  target: {
    url: string;
    viewport: Viewport;
  };
  cases: ShimonCase[];
  probe: (page: Page) => Promise<JsonValue> | JsonValue;
  stabilize?: (page: Page) => Promise<void> | void;
  freezeAnimations: boolean;
}

export interface LoadedConfig {
  path: string;
  config: ShimonConfig;
}

export interface FingerprintArtifact {
  schemaVersion: 1;
  toolVersion: string;
  target: {
    url: string;
  };
  environment: {
    browser: string;
    browserVersion: string;
    viewport: Viewport;
    deviceScaleFactor: number;
    locale: string;
    timezone: string;
  };
  cases: Array<{
    name: string;
    probe: JsonValue;
  }>;
}
