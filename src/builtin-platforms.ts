/**
 * 内置平台目录（组合根）
 *
 * 适配器本体在 `platforms/`，每个文件一个平台；这里只做「内置实现 → 注册表」
 * 的装配，不承载任何平台协议。新增平台时在 `src/platforms/<id>.ts` 写适配器，
 * 然后在这里加一行即可，桥内核与 op 层都不需要改动。
 */

import { PlatformRegistry } from "./platform-kit/registry.js";
import type { PlatformFactory } from "./platform-kit/types.js";
import { discordPlatformFactory } from "./platforms/discord.js";
import { logPlatformFactory } from "./platforms/log.js";
import { nullPlatformFactory } from "./platforms/null.js";
import { qqPlatformFactory } from "./platforms/qq.js";
import { telegramPlatformFactory } from "./platforms/telegram.js";

/** 内置平台（按 id 排序展示） */
export const BUILTIN_PLATFORMS: readonly PlatformFactory[] = [
  discordPlatformFactory,
  logPlatformFactory,
  nullPlatformFactory,
  qqPlatformFactory,
  telegramPlatformFactory,
];

/** 新建注册表；`extra` 供测试或上层注入自定义适配器 */
export function createRegistry(extra: readonly PlatformFactory[] = []): PlatformRegistry {
  const registry = new PlatformRegistry();
  for (const factory of [...BUILTIN_PLATFORMS, ...extra]) {
    registry.register(factory);
  }
  return registry;
}