/**
 * 插件入口：只做接线
 *
 * 采集、分类、存储、分发的实现都在 `core/` 与 `platforms/`，这里负责：
 * - 声明能力与订阅
 * - 按会话（ctx）持有桥实例（WeakMap，支持同进程多个会话/测试宿主）
 * - 把宿主事件转给桥、把 op 查询转给桥
 */

import { definePlugin, PluginError } from "mcsup-plugin";

import { configSchema, resolveConfig } from "./config.js";
import { ChatBridge } from "./core/bridge.js";
import { createQueries } from "./ops/index.js";
import { createRegistry } from "./platforms/index.js";

/** 订阅事件：结构化聊天 + 玩家 + 原始控制台 + 服务器生命周期 */
export const SUBSCRIPTIONS = [
  "chat:message",
  "player:joined",
  "player:left",
  "console:line",
  "server:starting",
  "server:started",
  "server:stopped",
  "server:crashed",
] as const;

/** 每个会话一个桥；用 ctx 作键，避免多会话互相覆盖 */
const bridges = new WeakMap<object, ChatBridge>();

function bridgeOf(ctx: object): ChatBridge {
  const bridge = bridges.get(ctx);
  if (bridge === undefined) {
    throw new PluginError("unavailable", "聊天桥尚未就绪");
  }
  return bridge;
}

export const plugin = definePlugin({
  id: "chat-bridge",
  title: "聊天桥",
  version: "0.1.0",
  license: "MIT",
  description: "采集 Minecraft 聊天与控制台消息，分类后按可插拔聊天平台分发",
  resident: true,
  capabilities: ["events", "console:read"],
  config: configSchema,
  subscriptions: [...SUBSCRIPTIONS],

  async onStart(ctx) {
    const bridge = new ChatBridge({
      log: ctx.log,
      registry: createRegistry(),
      config: resolveConfig(ctx.config),
    });
    bridges.set(ctx, bridge);
    try {
      await bridge.start();
    } catch (error) {
      bridges.delete(ctx);
      throw error;
    }
  },

  onEvent(data, ctx, meta) {
    bridges.get(ctx)?.ingest(meta.kind, data, meta);
  },

  async onConfigChange(config, ctx) {
    await bridges.get(ctx)?.applyConfig(resolveConfig(config));
  },

  async onStop(ctx) {
    const bridge = bridges.get(ctx);
    if (bridge !== undefined) {
      bridges.delete(ctx);
      await bridge.stop("插件停止");
    }
  },

  queries: createQueries(bridgeOf),
});

export default plugin;