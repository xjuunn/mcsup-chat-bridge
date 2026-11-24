/**
 * 平台契约的可复用断言
 *
 * 新平台只需要在 `test/<id>.test.ts` 里写一行
 * `await expectPlatformContract(myFactory, { settings: {...} })`，就能覆盖
 * 「注册表能实例化、start/stop 在已停止信号下安全、deliver 不抛错」这些
 * 与协议无关的约定。协议本身的收发行为仍由各平台自己的用例负责。
 */

import { expect } from "vitest";
import type { LogClient } from "mcsup-plugin";

import type { NormalizedMessage } from "../../src/core/types.js";
import { PlatformRegistry } from "../../src/platform-kit/registry.js";
import type { ChatPlatform, PlatformFactory } from "../../src/platform-kit/types.js";

/** 适配器 id 的线上形状 */
export const PLATFORM_ID = /^[a-z][a-z0-9-]{0,31}$/;

export interface ContractOptions {
  /** 工厂的 `settings`；缺省用空对象，验证默认值路径 */
  readonly settings?: unknown;
}

function silentLog(): LogClient {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function sampleMessage(): NormalizedMessage {
  return {
    id: "contract-1",
    seq: 1,
    category: "chat",
    source: "chat",
    server: "test",
    at: "2026-01-01T00:00:00.000Z",
    from: "Steve",
    text: "hello",
    raw: "<Steve> hello",
    rule: "chat.message",
  };
}

/**
 * 跑一遍平台契约并返回实例，方便调用方继续做平台专属断言。
 */
export async function expectPlatformContract(
  factory: PlatformFactory,
  options: ContractOptions = {},
): Promise<ChatPlatform> {
  expect(factory.id).toMatch(PLATFORM_ID);
  expect(factory.title.trim()).not.toBe("");

  const registry = new PlatformRegistry().register(factory);
  const log = silentLog();
  const platform = registry.create(factory.id, {
    log,
    settings: options.settings ?? {},
  });
  expect(platform.id).toBe(factory.id);
  expect(platform.title).toBe(factory.title);

  // 宿主在停止过程中启动插件时，signal 已经 abort：start 必须安全返回，
  // 不能建立连接，更不能抛错。
  await platform.start({ log, signal: AbortSignal.abort(), inbound: () => {} });
  // 出站只碰自己的队列：空文本、无目标都不得抛错。
  platform.deliver(sampleMessage());
  await platform.stop("contract");
  // 停止必须幂等，宿主可能重复调用
  await platform.stop("contract");
  return platform;
}