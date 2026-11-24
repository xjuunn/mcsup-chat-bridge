import { describe, expect, it } from "vitest";
import { PluginError } from "mcsup-plugin";

import { BUILTIN_PLATFORMS } from "../src/builtin-platforms.js";
import { discordPlatformFactory } from "../src/platforms/discord.js";
import { PlatformRegistry } from "../src/platform-kit/registry.js";
import { expectPlatformContract, PLATFORM_ID } from "./helpers/platform-contract.js";

/** 不需要凭据即可实例化的内置平台；QQ / Telegram 缺凭据应当拒绝启动 */
const CREDENTIAL_FREE = new Set(["log", "null"]);

describe("平台契约（内置适配器）", () => {
  for (const factory of BUILTIN_PLATFORMS) {
    if (!CREDENTIAL_FREE.has(factory.id)) {
      continue;
    }
    it(`${factory.id} 满足最小契约`, async () => {
      await expectPlatformContract(factory);
    });
  }

  it("discord 满足最小契约", async () => {
    await expectPlatformContract(discordPlatformFactory, { settings: { botToken: "test-token" } });
  });

  it("所有内置平台的 id 与标题合法，且互不重名", () => {
    const ids = BUILTIN_PLATFORMS.map((factory) => factory.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const factory of BUILTIN_PLATFORMS) {
      expect(factory.id).toMatch(PLATFORM_ID);
      expect(factory.title.trim()).not.toBe("");
    }
  });

  for (const id of ["qq", "telegram", "discord"]) {
    it(`${id} 缺凭据时按 invalid_input 拒绝，而不是运行期崩溃`, () => {
      const registry = new PlatformRegistry();
      for (const factory of BUILTIN_PLATFORMS) {
        registry.register(factory);
      }
      expect(() =>
        registry.create(id, { log: { debug() {}, info() {}, warn() {}, error() {} }, settings: {} }),
      ).toThrow(PluginError);
    });
  }

  it("注册表拒绝重复 id 与未知 id", () => {
    const factory = BUILTIN_PLATFORMS.find((item) => item.id === "null");
    expect(factory).toBeDefined();
    const registry = new PlatformRegistry().register(factory!);
    expect(() => registry.register(factory!)).toThrow(/already registered/);
    expect(() =>
      registry.create("nope", { log: { debug() {}, info() {}, warn() {}, error() {} }, settings: {} }),
    ).toThrow(PluginError);
  });
});