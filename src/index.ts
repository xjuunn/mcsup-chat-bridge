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
import type { GamePort, InjectMode } from "./platforms/types.js";

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
 * 注入方式由 `injectMode` 决定：
 * - `tellraw @a <JSON 文本组件>`：游戏里只显示插件自己的标签（如 `[QQ]`），
 *   不会像 `say` 那样多出 `[Server]` 前缀；原版不会把它写进服务器日志。
 * - `say <文本>`：会写进服务器 `logs/latest.log`（`[Not Secure] [Server] ...`），
 *   且没有玩家在线时也能记录；代价是游戏内会多一个 `[Server]` 前缀。
 *
 * 两者都会做控制字符清理，避免消息里的换行/制表符破坏命令行。
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
    async sendChat(server: string, text: string, mode: InjectMode = "tellraw"): Promise<void> {
      const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
      if (clean === "") {
        return;
      }
      const line =
        mode === "say" ? `say ${clean}` : `tellraw @a ${JSON.stringify({ text: clean })}`;
      await writer.sendLine(server, line);
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
  version: "0.1.15",
  license: "MIT",
  description: "采集 Minecraft 聊天与控制台消息，按可插拔平台分发，并支持平台消息回流游戏",
  resident: true,
  capabilities: ["events", "console:read", "console:write", "server:read"],
  config: configSchema,
  // 安装向导：`mcsup plugin install` 会先列能力授权，再逐项问这些值，
  // 写完后自动启用并启动，装完即可收发。只列「不填就用不了」的字段；
  // 群/私聊 openid 可以留空，首条消息后从插件日志补。
  setup: {
    fields: [
      {
        path: "platforms",
        required: true,
        default: ["qq"],
        label: "启用的平台",
        description: "逗号分隔：QQ 官方机器人填 qq，本地日志填 log；默认 qq",
      },
      {
        path: "injectMode",
        required: true,
        default: "tellraw",
        label: "游戏内注入方式",
        description:
          "tellraw 只显示在游戏内；say 同时写入 logs/latest.log（游戏内客户端看不到），需要日志可见时选 say",
      },
      {
        path: "qq.appId",
        required: true,
        label: "QQ AppID",
        description: "QQ 开放平台 → 机器人管理端 → 开发设置",
      },
      {
        path: "qq.clientSecret",
        required: true,
        secret: true,
        label: "QQ ClientSecret",
        description: "只用于换取 access_token，不会写入日志",
      },
      {
        path: "qq.server",
        label: "入站服务器",
        description: "QQ 消息注入哪个服务器；留空自动选择",
      },
      {
        path: "qq.groups",
        label: "群 openid",
        description:
          "逗号分隔；首次可从 `mcsup plugin logs chat-bridge` 的入站日志获取，留空表示不限制群",
      },
      {
        path: "qq.privateUsers",
        label: "私聊 openid",
        description: "逗号分隔；出站私聊目标，留空表示不主动私聊",
      },
      {
        path: "qq.allowPrivate",
        label: "接收私聊消息",
        description: "是否把 QQ 私聊消息注入游戏；默认关闭，避免陌生人打扰",
      },
    ],
  },
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