/**
 * 平台目录
 *
 * 内置适配器集中在这里注册；新增平台时在 `createRegistry` 里加一行即可，
 * 桥内核与 op 层都不需要改动。
 */

import { PlatformRegistry } from "./registry.js";
import { logPlatformFactory } from "./log.js";
import { nullPlatformFactory } from "./null.js";
import { qqPlatformFactory } from "./qq.js";
import type { PlatformFactory } from "./types.js";

/** 内置平台（按 id 排序展示） */
export const BUILTIN_PLATFORMS: readonly PlatformFactory[] = [
  logPlatformFactory,
  nullPlatformFactory,
  qqPlatformFactory,
];

/** 新建注册表；`extra` 供测试或上层注入自定义适配器 */
export function createRegistry(extra: readonly PlatformFactory[] = []): PlatformRegistry {
  const registry = new PlatformRegistry();
  for (const factory of [...BUILTIN_PLATFORMS, ...extra]) {
    registry.register(factory);
  }
  return registry;
}