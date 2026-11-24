import { describe, expect, it, vi } from "vitest";
import { PluginError, toZod } from "mcsup-plugin";

import { configSchema, resolveConfig, type RawConfig } from "../src/config.js";
import { createRegistry } from "../src/builtin-platforms.js";
import type { PlatformFactory } from "../src/platform-kit/types.js";

const parse = (values: unknown): RawConfig => toZod(configSchema).parse(values) as RawConfig;

describe("配置解析", () => {
  it("空配置使用默认值", () => {
    const config = resolveConfig(parse({}));
    expect(config.platforms).toEqual(["log"]);
    expect(config.forwardCategories).toEqual(["chat"]);
    expect(config.consoleForward).toBe(false);
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

  it("QQ 配置片段随 platforms 一起下发", () => {
    const config = resolveConfig(
      parse({
        platforms: ["qq"],
        qq: { appId: "102000001", clientSecret: "s3cret", groups: ["G1"] },
      }),
    );
    expect(config.platformSettings.qq).toMatchObject({
      appId: "102000001",
      clientSecret: "s3cret",
      sandbox: false,
      markdown: false,
      passiveReply: true,
      groups: ["G1"],
    });
  });

  it("QQ 缺少 appId 时 schema 拒绝", () => {
    expect(() => parse({ platforms: ["qq"], qq: { clientSecret: "s3cret" } })).toThrow();
  });

  it("Telegram 配置片段随 platforms 一起下发", () => {
    const config = resolveConfig(
      parse({
        platforms: ["telegram"],
        telegram: { botToken: "123:abc", groups: ["-100"], syncChannels: false },
      }),
    );
    expect(config.platformSettings.telegram).toMatchObject({
      botToken: "123:abc",
      groups: ["-100"],
      syncChannels: false,
      inbound: true,
      allowPrivate: false,
    });
  });

  it("Telegram 缺少 botToken 时 schema 拒绝", () => {
    expect(() => parse({ platforms: ["telegram"], telegram: {} })).toThrow();
  });

  it("Discord 配置片段随 platforms 一起下发", () => {
    const config = resolveConfig(
      parse({
        platforms: ["discord"],
        discord: {
          botToken: "discord-token",
          guilds: ["100"],
          groups: ["200"],
          privateUsers: ["300"],
          allowPrivate: true,
        },
      }),
    );
    expect(config.platformSettings.discord).toMatchObject({
      botToken: "discord-token",
      guilds: ["100"],
      groups: ["200"],
      privateUsers: ["300"],
      allowPrivate: true,
      inbound: true,
      syncChannels: true,
      maxLength: 1900,
    });
  });

  it("Discord 缺少 botToken 时 schema 拒绝", () => {
    expect(() => parse({ platforms: ["discord"], discord: {} })).toThrow();
  });

  it("微信配置片段随 platforms 一起下发", () => {
    const config = resolveConfig(
      parse({
        platforms: ["weixin"],
        weixin: {
          botToken: "wxbot_token",
          privateUsers: ["42"],
          allowedUsers: ["42", "43"],
        },
      }),
    );
    expect(config.platformSettings.weixin).toMatchObject({
      botToken: "wxbot_token",
      privateUsers: ["42"],
      allowedUsers: ["42", "43"],
      inbound: true,
      allowPrivate: true,
      maxLength: 1500,
      pollTimeoutMs: 35000,
    });
  });

  it("微信缺少 botToken 时 schema 拒绝", () => {
    expect(() => parse({ platforms: ["weixin"], weixin: {} })).toThrow();
  });

  it("入站开关与上限有默认值，且可覆盖", () => {
    const defaults = resolveConfig(parse({}));
    expect(defaults.inbound).toBe(true);
    expect(defaults.crossPlatform).toBe(true);
    expect(defaults.privateSync).toBe(false);
    expect(defaults.inboundMaxLength).toBe(200);
    expect(defaults.injectMode).toBe("say");
    const custom = resolveConfig(parse({ inbound: false, crossPlatform: false, privateSync: true, inboundServer: "creative", inboundMaxLength: 64, injectMode: "say" }));
    expect(custom.inbound).toBe(false);
    expect(custom.crossPlatform).toBe(false);
    expect(custom.privateSync).toBe(true);
    expect(custom.inboundServer).toBe("creative");
    expect(custom.inboundMaxLength).toBe(64);
    expect(custom.injectMode).toBe("say");
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
    expect(ids).toEqual(["discord", "log", "null", "qq", "telegram", "weixin"]);
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