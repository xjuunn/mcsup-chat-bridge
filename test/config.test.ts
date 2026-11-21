import { describe, expect, it, vi } from "vitest";
import { PluginError, toZod } from "mcsup-plugin";

import { configSchema, resolveConfig, type RawConfig } from "../src/config.js";
import { CATEGORIES } from "../src/core/types.js";
import { createRegistry } from "../src/platforms/index.js";
import type { PlatformFactory } from "../src/platforms/types.js";

const parse = (values: unknown): RawConfig => toZod(configSchema).parse(values) as RawConfig;

describe("配置解析", () => {
  it("空配置使用默认值", () => {
    const config = resolveConfig(parse({}));
    expect(config.platforms).toEqual(["log"]);
    expect(config.forwardCategories).toEqual([...CATEGORIES]);
    expect(config.consoleForward).toBe(true);
    expect(config.storeSize).toBe(200);
    expect(config.queueCapacity).toBe(256);
    expect(config.platformSettings.log).toBeUndefined();
  });

  it("平台列表去重、空数组表示只采集", () => {
    expect(resolveConfig(parse({ platforms: ["log", "log", " null "] })).platforms).toEqual([
      "log",
      "null",
    ]);
    expect(resolveConfig(parse({ platforms: [] })).platforms).toEqual([]);
  });

  it("类别去重并保留配置里的顺序", () => {
    const config = resolveConfig(parse({ forwardCategories: ["warning", "chat", "warning"] }));
    expect(config.forwardCategories).toEqual(["warning", "chat"]);
  });

  it("平台配置按适配器 id 取片段，并套用默认值", () => {
    const config = resolveConfig(parse({ platforms: ["log"], log: { prefix: "bridge" } }));
    expect(config.platformSettings.log).toEqual({ prefix: "bridge", level: "info" });
  });
});

describe("平台注册表", () => {
  it("未知平台抛 invalid_input", () => {
    const registry = createRegistry();
    try {
      registry.create("nope", { log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, settings: undefined });
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).code).toBe("invalid_input");
    }
  });

  it("内置平台可列出", () => {
    const ids = createRegistry().list().map((info) => info.id);
    expect(ids).toEqual(["log", "null"]);
  });

  it("重复注册与非法 id 被拒绝", () => {
    const registry = createRegistry();
    const stub: PlatformFactory = {
      id: "log",
      title: "重复的日志平台",
      create: () => ({
        id: "log",
        title: "重复的日志平台",
        start() {},
        deliver() {},
        stop() {},
      }),
    };
    expect(() => registry.register(stub)).toThrow(/already registered/);
    expect(() => registry.register({ ...stub, id: "Bad_ID" })).toThrow(/invalid platform id/);
  });
});