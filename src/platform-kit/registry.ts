/**
 * 平台注册表
 *
 * 新增平台 = 实现 `PlatformFactory` 并 `register()` 一次；配置里写这个 id
 * 就会实例化。注册表只做静态登记与 id 校验，不触达 IO。
 */

import { PluginError } from "mcsup-plugin";

import type { ChatPlatform, PlatformCreateOptions, PlatformFactory, PlatformInfo } from "./types.js";

/** 适配器 id 的线上形状（与插件 id 同风格，便于写进配置） */
const PLATFORM_ID = /^[a-z][a-z0-9-]{0,31}$/;

export class PlatformRegistry {
  private readonly factories = new Map<string, PlatformFactory>();

  public register(factory: PlatformFactory): this {
    if (!PLATFORM_ID.test(factory.id)) {
      throw new Error(`invalid platform id: ${factory.id}`);
    }
    if (this.factories.has(factory.id)) {
      throw new Error(`platform adapter already registered: ${factory.id}`);
    }
    this.factories.set(factory.id, factory);
    return this;
  }

  public has(id: string): boolean {
    return this.factories.has(id);
  }

  public list(): readonly PlatformInfo[] {
    return [...this.factories.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((factory) => ({
        id: factory.id,
        title: factory.title,
        ...(factory.description === undefined ? {} : { description: factory.description }),
      }));
  }

  /** 实例化一个平台；id 未知时抛出可配置回滚的 `invalid_input` */
  public create(id: string, options: PlatformCreateOptions): ChatPlatform {
    const factory = this.factories.get(id);
    if (factory === undefined) {
      throw new PluginError(
        "invalid_input",
        `unknown chat platform "${id}"; registered: ${[...this.factories.keys()].join(", ")}`,
      );
    }
    const platform = factory.create(options);
    if (platform.id !== id) {
      throw new PluginError("internal", `platform adapter "${id}" created an instance with id "${platform.id}"`);
    }
    return platform;
  }
}