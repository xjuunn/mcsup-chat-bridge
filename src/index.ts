/**
 * 插件入口：只做接线
 *
 * 采集、分类、存储、分发的实现都在 `core/` 与 `platforms/`，这里负责：
 * - 声明能力与订阅
 * - 把 `console:write` / `server:read` 适配成平台无关的 `GamePort`
 * - 按会话（ctx）持有桥实例（WeakMap，支持同进程多个会话/测试宿主）
 * - 把宿主事件转给桥、把 op 查询转给桥
 *
 * 能力最小化：`console:write` 是高风险能力，只在 QQ / Telegram → 游戏方向使用；
 * 宿主未授予时入站降级为仅计数，出站（游戏 → 平台）不受影响。
 */

import { definePlugin, PluginError } from "mcsup-plugin";
import type { LogClient } from "mcsup-plugin";

import { configSchema, resolveConfig } from "./config.js";
import { ChatBridge } from "./core/bridge.js";
import { createQueries } from "./ops/index.js";
import { createRegistry } from "./platforms/index.js";
import type { GamePort, InjectMode } from "./platforms/types.js";
import type { KvLike } from "./core/targets.js";

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
  readonly "storage:kv"?: KvLike;
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
 * - `tellraw @a <JSON 文本组件>`：游戏里只显示插件自己的标签（如 `[QQ]` / `[Telegram]`），
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
    log.warn("未授予 console:write：平台 → 游戏方向不可用，桥将以仅出站模式运行");
    return undefined;
  }
  const servers = caps["server:read"]?.servers;

  return {
    async sendChat(server: string, text: string, mode: InjectMode = "say"): Promise<void> {
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

/**
 * 宿主 `storage:kv`，用于记住「见过的会话」
 *
 * 未授予时返回 undefined：适配器退化为进程内记忆（重启后要等群里先说一句），
 * 并在日志里说明原因，免得用户以为持久化生效了。
 */
function createTargetKv(ctx: object, log: LogClient): KvLike | undefined {
  const kv = (ctx as RuntimeCapabilities)["storage:kv"];
  if (kv === undefined) {
    log.warn("未授予 storage:kv：出站目标只在本次运行内有效（重启后需重新收到消息）");
  }
  return kv;
}

export const plugin = definePlugin({
  id: "chat-bridge",
  title: "聊天桥",
  version: "0.1.23",
  license: "MIT",
  description: "采集 Minecraft 聊天与控制台消息，按可插拔平台分发，并支持平台消息回流游戏",
  resident: true,
  capabilities: ["events", "storage:kv", "console:read", "console:write", "server:read"],
  config: configSchema,
  // 服务器绑定：`inboundServer` 是「平台消息注入哪台服务器」，`qq.server` /
  // `telegram.server` 是各适配器的覆盖值。宿主据此让插件跟随服务器启停——
  // 绑定的服务器启动前先拉起插件，全部停止后再收掉。
  bind: { servers: ["inboundServer", "qq.server", "telegram.server"] },
  // 安装向导：`mcsup plugin install` 会先列能力授权，再逐项问这些值，
  // 写完后自动启用并启动，装完即可收发。只列「不填就收不到消息」的字段：
  // 群/私聊 chat id 可以留空，首条消息后从插件日志补；`allowPrivate` 等
  // 开关默认安全值，装完再用 `config set` 打开。
  // 平台凭据用 `when` 条件提问：没选 qq 就完全不问 QQ 凭据，反之亦然
  // （`when` 需要宿主支持 descriptor schema 4）。
  setup: {
    fields: [
      {
        path: "platforms",
        required: true,
        default: ["qq"],
        choices: ["qq", "telegram", "log"],
        label: "启用的平台",
        description: "QQ 官方机器人需要 qq；Telegram 需要 telegram；本地日志需要 log（可多选）",
      },
      {
        path: "injectMode",
        required: true,
        default: "say",
        label: "游戏内注入方式",
        description:
          "say（默认）：写入 logs/latest.log，游戏内会多出 [Server] 前缀；tellraw：只显示在游戏内、不写日志，游戏里只有 [QQ]/[Telegram] 标签",
      },
      {
        path: "inboundServer",
        required: true,
        choicesFrom: "servers",
        label: "入站服务器",
        description: "平台消息注入哪台服务器；从已注册服务器中选择（qq.server / telegram.server 可单独覆盖）",
      },
      {
        path: "qq.appId",
        required: true,
        label: "QQ AppID",
        description: "QQ 开放平台 → 机器人管理端 → 开发设置；只在启用了 qq 时询问",
        // 条件提问：没选 qq 就不问、也不要求 QQ 凭据
        when: { path: "platforms", includes: "qq" },
      },
      {
        path: "qq.clientSecret",
        required: true,
        secret: true,
        label: "QQ ClientSecret",
        description: "只用于换取 access_token，不会写入日志；只在启用了 qq 时询问",
        when: { path: "platforms", includes: "qq" },
      },
      {
        path: "telegram.botToken",
        required: true,
        secret: true,
        label: "Telegram Bot Token",
        description: "Telegram 里找 @BotFather，用 /newbot 或 /token 获取；只在启用了 telegram 时询问",
        when: { path: "platforms", includes: "telegram" },
      },
    ],
  },
  subscriptions: [...SUBSCRIPTIONS],

  async onStart(ctx) {
    const config = resolveConfig(ctx.config);
    const kv = createTargetKv(ctx, ctx.log);
    const bridge = new ChatBridge({
      log: ctx.log,
      registry: createRegistry(),
      config,
      game: createGamePort(ctx, ctx.log),
      ...(kv === undefined ? {} : { kv }),
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