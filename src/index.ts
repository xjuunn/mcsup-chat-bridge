/**
 * 插件入口：只做接线
 *
 * 采集、分类、存储、分发的实现都在 `core/` 与 `platforms/`，这里负责：
 * - 声明能力与订阅
 * - 把 `console:write` / `server:read` 适配成平台无关的 `GamePort`
 * - 按会话（ctx）持有桥实例（WeakMap，支持同进程多个会话/测试宿主）
 * - 把宿主事件转给桥、把 op 查询转给桥
 *
 * 能力最小化：`console:write` 是高风险能力，只在 QQ → 游戏方向使用；宿主
 * 未授予时入站降级为仅计数，出站（游戏 → QQ）不受影响。
 */

import { definePlugin, PluginError } from "mcsup-plugin";
import type { LogClient } from "mcsup-plugin";

import { configSchema, resolveConfig } from "./config.js";
import { ChatBridge } from "./core/bridge.js";
import { createQueries } from "./ops/index.js";
import { createRegistry } from "./platforms/index.js";
import type { GamePort } from "./platforms/types.js";

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

/** 运行期能力形状：宿主可能只授予部分能力，未授予的成员在 ctx 上不存在 */
interface RuntimeCapabilities {
  readonly "console:write"?: {
    sendLine(server: string, line: string): Promise<void>;
  };
  readonly "server:read"?: {
    readonly servers: {
      list(): Promise<readonly { readonly name: string; readonly status: string }[]>;
    };
  };
}

function bridgeOf(ctx: object): ChatBridge {
  const bridge = bridges.get(ctx);
  if (bridge === undefined) {
    throw new PluginError("unavailable", "聊天桥尚未就绪");
  }
  return bridge;
}

/**
 * 把宿主能力适配成 `GamePort`。
 *
 * 注入使用 `tellraw @a <JSON 文本组件>` 而不是 `say`：`say` 会以服务器口吻
 * 回显到控制台，容易被桥再次采集，形成自激；`tellraw` 只面向玩家。
 */
function createGamePort(ctx: object, log: LogClient): GamePort | undefined {
  const caps = ctx as RuntimeCapabilities;
  const writer = caps["console:write"];
  if (writer === undefined) {
    log.warn("未授予 console:write：QQ → 游戏方向不可用，桥将以仅出站模式运行");
    return undefined;
  }
  const servers = caps["server:read"]?.servers;

  return {
    async sendChat(server: string, text: string): Promise<void> {
      const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
      if (clean === "") {
        return;
      }
      await writer.sendLine(server, `tellraw @a ${JSON.stringify({ text: clean })}`);
    },
    async resolveServer(preferred?: string): Promise<string | null> {
      if (preferred !== undefined && preferred !== "") {
        return preferred;
      }
      if (servers === undefined) {
        return null;
      }
      try {
        const list = await servers.list();
        const running = list.find((item) => item.status === "running" || item.status === "starting");
        return running?.name ?? list[0]?.name ?? null;
      } catch {
        return null;
      }
    },
  };
}

export const plugin = definePlugin({
  id: "chat-bridge",
  title: "聊天桥",
  version: "0.1.0",
  license: "MIT",
  description: "采集 Minecraft 聊天与控制台消息，按可插拔平台分发，并支持平台消息回流游戏",
  resident: true,
  capabilities: ["events", "console:read", "console:write", "server:read"],
  config: configSchema,
  subscriptions: [...SUBSCRIPTIONS],

  async onStart(ctx) {
    const config = resolveConfig(ctx.config);
    const bridge = new ChatBridge({
      log: ctx.log,
      registry: createRegistry(),
      config,
      game: createGamePort(ctx, ctx.log),
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
    const bridge = bridges.get(ctx);
    if (bridge === undefined) {
      return;
    }
    await bridge.applyConfig(resolveConfig(config));
    // 配置变更可能调整了目录外的行为；这里不需要重建 GamePort，
    // 因为能力由宿主握手授予，与配置无关。
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