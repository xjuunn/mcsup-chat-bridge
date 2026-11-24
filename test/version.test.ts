import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PLUGIN_VERSION } from "../src/version.js";

describe("版本号", () => {
  it("源码常量与 package.json 一致", () => {
    const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(text) as { version?: unknown };
    expect(PLUGIN_VERSION).toBe(parsed.version);
  });
});