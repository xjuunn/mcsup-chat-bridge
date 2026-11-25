/**
 * 插件入口：只做接线
 *
 * 采集、分类、存储、分发的实现都在 `core/` 与 `platforms/`，这里负责：
 * - 声明能力与订阅
 * - 把 `console:write` / `server:read` 适配成平台无关的 `GamePort`
 * - 按会话（ctx）持有桥实例（WeakMap，支持同进程多个会话/测试宿主）
 * - 把宿主事件转给桥、把 op 查询转给桥
 *
 * 能力最小化：`console:write` 是高风险能力，只在 QQ / Telegram / Discord / 微信 → 游戏方向使用；
 * 宿主未授予时入站降级为仅计数，出站（游戏 → 平台）不受影响。
 */

import { definePlugin, PluginError } from "mcsup-plugin";
import type { LogClient } from "mcsup-plugin";

import { configSchema, resolveConfig } from "./config.js";
import { ChatBridge } from "./core/bridge.js";
import { createQueries } from "./ops/index.js";
import { createRegistry } from "./builtin-platforms.js";
import { weixinInteractiveSetup } from "./setup/weixin.js";
import type { GamePort, InjectMode } from "./platform-kit/types.js";
import type { KvLike } from "./core/targets.js";
import { PLUGIN_VERSION } from "./version.js";

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
 * 读取可选能力。
 *
 * SDK 对「已声明但未授予」的成员挂的是抛 `denied` 的 getter，直接访问会让
 * `onStart` 失败，文档承诺的降级分支根本走不到。优先问 `ctx.has`（新 SDK
 * 不会触碰 getter）；旧 SDK 没有 `has` 时退回 try/catch。
 */
function capabilityOf<T>(ctx: object, name: string): T | undefined {
  const probe = ctx as { has?: (capability: string) => boolean };
  if (typeof probe.has === "function" && !probe.has(name)) {
    return undefined;
  }
  try {
    return (ctx as Record<string, T | undefined>)[name];
  } catch {
    return undefined;
  }
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
  const writer = capabilityOf<RuntimeCapabilities["console:write"]>(ctx, "console:write");
  if (writer === undefined) {
    log.warn("未授予 console:write：平台 → 游戏方向不可用，桥将以仅出站模式运行");
    return undefined;
  }
  const servers = capabilityOf<NonNullable<RuntimeCapabilities["server:read"]>>(ctx, "server:read")?.servers;

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
      } catch (error) {
        // 列表不可用时退回「不绑定服务器」，但必须说清原因：否则表现成
        // 平台消息没人接收，排查时看不出是宿主没启动还是权限被收回。
        log.warn(
          `读取服务器列表失败，平台 → 游戏方向暂不绑定服务器：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
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
  const kv = capabilityOf<KvLike>(ctx, "storage:kv");
  if (kv === undefined) {
    log.warn("未授予 storage:kv：出站目标只在本次运行内有效（重启后需重新收到消息）");
  }
  return kv;
}

export const plugin = definePlugin({
  id: "chat-bridge",
  title: "聊天桥",
  version: PLUGIN_VERSION,
  license: "MIT",
  description: "采集 Minecraft 聊天与控制台消息，按可插拔平台分发，并支持平台消息回流游戏",
  resident: true,
  capabilities: ["events", "storage:kv", "console:read", "console:write", "server:read"],
  config: configSchema,
  // 服务器绑定：`inboundServer` 是「平台消息注入哪台服务器」，`qq.server` /
  // `telegram.server` 是各适配器的覆盖值。宿主据此让插件跟随服务器启停——
  // 绑定的服务器启动前先拉起插件，全部停止后再收掉。
  bind: { servers: ["inboundServer", "qq.server", "telegram.server", "discord.server", "weixin.server"] },
  // 安装向导：`mcsup plugin install` 会先列能力授权，再逐项问这些值，
  // 写完后自动启用并启动，装完即可收发。只列「不填就收不到消息」的字段：
  // 群/私聊 chat id 可以留空，首条消息后从插件日志补；`allowPrivate` 等
  // 开关默认安全值，装完再用 `config set` 打开。
  // 平台凭据用 `when` 条件提问：没选 qq 就完全不问 QQ 凭据，反之亦然
  // （`when` 需要宿主支持 descriptor schema 4）。
  // 每个字段用 `help`（schema 6）声明教程：短说明用 `inline` 贴在控件旁，
  // 需要去平台申请的凭据用 `steps` 给操作步骤与官方链接。教程写在插件侧，
  // 宿主不内置平台知识；没选的平台连提问都不会出现。
  // 微信没有可粘贴的 token：`interactive`（schema 5）让宿主拉起插件，
  // 由插件在终端画二维码并扫码，登录结果经临时密钥文件回传。
  setup: {
    fields: [
      {
        path: "platforms",
        required: true,
        default: ["qq"],
        choices: ["qq", "telegram", "discord", "weixin", "log"],
        label: "启用的平台",
        help: {
          style: "inline",
          text: "QQ 官方机器人选 qq；Telegram 选 telegram；Discord 选 discord；微信选 weixin；本地日志选 log（可多选）",
        },
      },
      {
        path: "injectMode",
        required: true,
        default: "say",
        label: "游戏内注入方式",
        help: {
          style: "inline",
          text: "say：写入 logs/latest.log，游戏内多出 [Server] 前缀；tellraw：只显示在游戏内、不写日志",
        },
      },
      {
        path: "privateSync",
        required: true,
        default: false,
        label: "同步私聊消息",
        help: {
          style: "inline",
          text: "全局开关：选「是」后所有已选平台的私聊都参与注入、镜像与跨平台同步；默认关闭，避免陌生人私聊机器人",
        },
      },
      {
        path: "inboundServer",
        required: true,
        choicesFrom: "servers",
        label: "入站服务器",
        help: {
          style: "inline",
          text: "平台消息注入哪台服务器；从已注册服务器中选择（qq.server / telegram.server 可单独覆盖）",
        },
      },
      {
        path: "qq.appId",
        required: true,
        label: "QQ AppID",
        help: {
          style: "steps",
          title: "获取 QQ AppID",
          steps: [
            "打开 https://q.qq.com/ 登录 QQ 开放平台",
            "创建或选择机器人，进入「开发设置」",
            "复制「AppID」；同页的「AppSecret」就是下一步的 ClientSecret",
            "在开放平台为机器人开启群聊消息接收与发送权限；群里需 @ 机器人才会响应",
          ],
          links: [{ label: "QQ 机器人文档", url: "https://bot.q.qq.com/wiki/" }],
        },
        // 条件提问：没选 qq 就不问、也不要求 QQ 凭据
        when: { path: "platforms", includes: "qq" },
      },
      {
        path: "qq.clientSecret",
        required: true,
        secret: true,
        label: "QQ ClientSecret",
        help: {
          style: "steps",
          title: "获取 QQ ClientSecret",
          steps: [
            "打开 https://q.qq.com/ → 你的机器人 →「开发设置」",
            "复制「AppSecret」（即 ClientSecret）",
            "重置过密钥就填最新值，旧值会立即失效",
          ],
          links: [{ label: "QQ 机器人文档", url: "https://bot.q.qq.com/wiki/" }],
        },
        when: { path: "platforms", includes: "qq" },
      },
      {
        path: "telegram.botToken",
        required: true,
        secret: true,
        label: "Telegram Bot Token",
        help: {
          style: "steps",
          title: "获取 Telegram Bot Token",
          steps: [
            "在 Telegram 打开 @BotFather：https://t.me/BotFather",
            "发送 /newbot，按提示设置显示名与以 bot 结尾的用户名",
            "复制回复里的 HTTP API token；已有机器人用 /token 重新获取",
            "群聊默认只收到 @ 与命令消息；要读取全部消息，在 @BotFather 用 /setprivacy 关闭隐私模式，再把机器人移出并重新加群",
          ],
          links: [
            { label: "Bot 教程", url: "https://core.telegram.org/bots/tutorial" },
          ],
        },
        when: { path: "platforms", includes: "telegram" },
      },
      {
        path: "discord.botToken",
        required: true,
        secret: true,
        label: "Discord Bot Token",
        help: {
          style: "steps",
          title: "获取 Discord Bot Token",
          steps: [
            "打开 https://discord.com/developers/applications 并登录",
            "New Application → 左侧 Bot → Reset Token，复制 token",
            "在同一页打开 Message Content Intent，否则收不到消息内容",
            "邀请机器人入群时勾选 Read Messages 与 Send Messages 权限",
          ],
          links: [
            {
              label: "Discord 开发者文档",
              url: "https://discord.com/developers/docs/quick-start/getting-started",
            },
          ],
        },
        when: { path: "platforms", includes: "discord" },
      },
      {
        // 扫码登录会顺带给出 iLink 基址；它写在 config schema 里，由同一次
        // 登录回填，不作为 setup 字段提问。
        path: "weixin.botToken",
        required: true,
        secret: true,
        interactive: true,
        label: "微信 Bot Token",
        help: {
          style: "steps",
          steps: ["用手机微信扫码并按提示确认"],
        },
        when: { path: "platforms", includes: "weixin" },
      },
    ],
    interactive: {
      "weixin.botToken": weixinInteractiveSetup,
    },
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