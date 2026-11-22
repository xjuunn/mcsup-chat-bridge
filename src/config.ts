/**
 * 配置 schema 与解析
 *
 * 平台专属配置放在与适配器 id 同名的字段里（如 `log` / `qq`），桥只负责把
 * 该片段传给工厂。新增平台时在这里加一个字段即可，不需要改分发内核。
 *
 * 密钥字段用 `secretInput(...)` 标记：宿主据此把字段渲染为遮蔽输入、读取时
 * 打码、日志脱敏；握手时仍会把明文下发给插件使用。配置本身由宿主按插件
 * 隔离并持久化，插件不需要也不应该自己落盘密钥。
 */

import { s, secretInput } from "mcsup-plugin";
import type { InferSchema } from "mcsup-plugin";

import type { BridgeConfig } from "./core/bridge.js";
import { CATEGORIES } from "./core/types.js";

export const configSchema = s.object({
  platforms: s.optional(
    s.array(s.string({ max: 32 }), {
      maxItems: 16,
      describe: "启用的聊天平台适配器 id；省略时使用 log，空数组表示只采集",
    }),
  ),
  forwardCategories: s.optional(
    s.array(s.enum(CATEGORIES), {
      describe: "转发到平台的类别；省略时只转发玩家聊天（chat），需要加入/离开、死亡等事件时显式追加",
    }),
  ),
  consoleForward: s.boolean({
    default: false,
    label: "转发控制台消息",
    describe: "为 false（默认）时只采集并入库，不投递到平台；需要转发服务器 say/日志时再打开",
  }),
  storeSize: s.integer({
    default: 200,
    min: 10,
    max: 5_000,
    label: "缓存条数",
    describe: "内存中保留的最近消息数",
  }),
  queueCapacity: s.integer({
    default: 256,
    min: 8,
    max: 4_096,
    label: "队列容量",
    describe: "单个平台出站队列与全局入站队列的积压上限，超出后丢弃最旧消息",
  }),
  inbound: s.boolean({
    default: true,
    label: "允许平台消息进入游戏",
    describe: "为 false 时平台仍可出站，但 QQ 等外部消息不会注入游戏",
  }),
  inboundServer: s.optional(
    s.string({
      max: 64,
      label: "入站默认服务器",
      describe: "外部消息默认注入的服务器名；省略时自动选择运行中的服务器",
    }),
  ),
  inboundMaxLength: s.integer({
    default: 200,
    min: 32,
    max: 512,
    label: "入站文本上限",
    describe: "单条外部消息注入游戏前的最大字符数；超长会截断，避免撑爆聊天栏",
  }),
  injectMode: s.enum(["tellraw", "say"], {
    default: "tellraw",
    label: "注入方式",
    describe:
      "tellraw（默认）：游戏里只有 [QQ] 标签，不写服务器日志；say：写进服务器 logs/latest.log，但游戏内会多出 [Server] 前缀。原版只有 say/me 这类服务器广播会进日志，两者不可兼得",
  }),
  log: s.optional(
    s.object(
      {
        prefix: s.string({ default: "chat-bridge", max: 32, label: "日志前缀" }),
        level: s.enum(["info", "debug"], { default: "info", label: "日志级别" }),
      },
      { label: "本地日志平台" },
    ),
  ),
  qq: s.optional(
    s.object(
      {
        appId: s.string({
          max: 32,
          label: "AppID",
          describe: "QQ 开放平台机器人 AppID（q.qq.com 机器人管理端 → 开发设置）",
        }),
        clientSecret: secretInput(
          s.string({
            max: 256,
            label: "ClientSecret",
            describe: "QQ 开放平台机器人 ClientSecret；只用于换取 access_token，不会写入日志",
          }),
        ),
        sandbox: s.boolean({
          default: false,
          label: "沙箱环境",
          describe: "为 true 时使用 sandbox.api.sgroup.qq.com；正式上线请关闭",
        }),
        apiBase: s.optional(
          s.string({
            max: 512,
            label: "OpenAPI 基址",
            describe: "默认 https://api.sgroup.qq.com；一般无需修改",
          }),
        ),
        tokenUrl: s.optional(
          s.string({
            max: 512,
            label: "凭证地址",
            describe: "默认 https://bots.qq.com/app/getAppAccessToken",
          }),
        ),
        intents: s.optional(
          s.array(
            s.enum([
              "guilds",
              "guild_members",
              "public_guild_messages",
              "direct_message",
              "group_and_c2c",
              "interaction",
              "message_audit",
            ]),
            {
              maxItems: 7,
              label: "事件订阅",
              describe: "默认 group_and_c2c（群聊与单聊）；频道能力需在开放平台申请权限",
            },
          ),
        ),
        markdown: s.boolean({
          default: false,
          label: "Markdown 发送",
          describe: "为 false 时用纯文本（msg_type=0），避免玩家消息里的符号被渲染；群/私聊镜像图片始终优先走 Markdown 图文",
        }),
        groups: s.optional(
          s.array(s.string({ max: 64, label: "群 openid" }), {
            maxItems: 32,
            label: "群聊",
            describe:
              "出站目标 group_openid；同时作为入站白名单。留空表示全部：入站不限群，出站发给收到过消息的群",
          }),
        ),
        privateUsers: s.optional(
          s.array(s.string({ max: 64, label: "用户 openid" }), {
            maxItems: 32,
            label: "私聊对象",
            describe:
              "出站私聊目标 user_openid（不是 QQ 号）。留空表示全部：入站不限对象，出站发给给机器人发过消息的用户",
          }),
        ),
        allowedUsers: s.optional(
          s.array(s.string({ max: 64, label: "用户 openid" }), {
            maxItems: 64,
            label: "入站发言人白名单",
            describe: "非空时只允许这些 openid 的消息进入游戏；空表示桥接聊天内所有人",
          }),
        ),
        categories: s.optional(
          s.array(s.enum(CATEGORIES), {
            label: "转发类别",
            describe: "QQ 出站只转发这些类别；省略时沿用全局 forwardCategories",
          }),
        ),
        inbound: s.boolean({
          default: true,
          label: "接收 QQ 消息",
          describe: "为 false 时只出站，不把 QQ 消息注入游戏",
        }),
        allowPrivate: s.boolean({
          default: false,
          label: "接收私聊",
          describe: "是否把私聊消息注入游戏；默认关闭，避免陌生人打扰",
        }),
        syncChannels: s.boolean({
          default: true,
          label: "群聊/私聊互相同步",
          describe:
            "为 true 时，群里收到的 QQ 消息也会转发到私聊目标，私聊收到的也会转发到群目标（同一会话不重复发送）；只影响 QQ 内部的群与私聊，不影响游戏注入",
        }),
        forwardMedia: s.boolean({
          default: true,
          label: "同步图片",
          describe:
            "为 true 时，群/私聊互转会用一条消息转发入站图片（文字在前、图片在后）。QQ 表情统一转为 [表情] 文本",
        }),
        mediaMode: s.enum(["markdown", "rich"], {
          default: "markdown",
          label: "图片消息形态",
          describe:
            "markdown：单条 Markdown 图文，图片先转存平台素材库（qqbot-media://），手机/电脑都能显示；rich：单条富媒体（图片在上、文字在下），兼容性兜底。Markdown 上传或发送失败会自动退回 rich",
        }),
        label: s.string({
          default: "QQ",
          max: 16,
          label: "游戏内标签",
          describe: "注入游戏时显示的前缀，例如 [QQ] 昵称: 消息",
        }),
        server: s.optional(
          s.string({
            max: 64,
            label: "入站服务器",
            describe: "QQ 消息默认注入的服务器；省略时使用全局 inboundServer 或自动选择",
          }),
        ),
        maxLength: s.integer({
          default: 1_500,
          min: 64,
          max: 4_000,
          label: "单条出站上限",
          describe: "超过后按此长度分片发送；官方纯文本上限约 4000 字符",
        }),
        passiveReply: s.boolean({
          default: true,
          label: "被动回复",
          describe: "优先用最近一条入站消息的 msg_id 被动回复，规避主动消息频控",
        }),
        passiveLimit: s.integer({
          default: 4,
          min: 1,
          max: 50,
          label: "被动回复次数",
          describe: "同一条消息最多回复次数；单聊 4 次、群聊 5 次、群管理员 50 次",
        }),
        passiveTtlMs: s.integer({
          default: 3_300_000,
          min: 10_000,
          max: 3_600_000,
          label: "被动回复时效",
          describe: "超过该时长不再使用入站 msg_id；官方窗口 60 分钟，默认留 5 分钟余量",
        }),
        sendIntervalMs: s.integer({
          default: 500,
          min: 0,
          max: 10_000,
          label: "发送间隔",
          describe: "两次 OpenAPI 调用之间的最小间隔，用于温柔限流",
        }),
        apiTimeoutMs: s.integer({
          default: 15_000,
          min: 1_000,
          max: 60_000,
          label: "API 超时",
        }),
        reconnectMinMs: s.integer({
          default: 1_000,
          min: 200,
          max: 60_000,
          label: "重连最小间隔",
        }),
        reconnectMaxMs: s.integer({
          default: 60_000,
          min: 1_000,
          max: 600_000,
          label: "重连最大间隔",
        }),
        reconnectMaxAttempts: s.integer({
          default: 0,
          min: 0,
          max: 10_000,
          label: "最大重连次数",
          describe: "0 表示无限重试",
        }),
      },
      { label: "QQ 机器人（官方 API v2）" },
    ),
  ),
});

/** 宿主下发的配置（已按 schema 解析） */
export type RawConfig = InferSchema<typeof configSchema>;

/** 把宿主配置解析为桥内核使用的配置 */
export function resolveConfig(raw: RawConfig): BridgeConfig {
  const platforms = unique(
    (raw.platforms ?? ["log"]).map((id) => id.trim()).filter((id) => id !== ""),
  );
  const source = raw as unknown as Record<string, unknown>;
  const platformSettings: Record<string, unknown> = {};
  for (const id of platforms) {
    platformSettings[id] = source[id];
  }
  return {
    platforms,
    forwardCategories:
      raw.forwardCategories === undefined
        ? ["chat"]
        : [...new Set(raw.forwardCategories)],
    consoleForward: raw.consoleForward ?? false,
    storeSize: raw.storeSize ?? 200,
    queueCapacity: raw.queueCapacity ?? 256,
    inbound: raw.inbound ?? true,
    inboundMaxLength: raw.inboundMaxLength ?? 200,
    injectMode: raw.injectMode ?? "tellraw",
    ...(raw.inboundServer === undefined ? {} : { inboundServer: raw.inboundServer }),
    platformSettings,
  };
}

/** 去重并保持首次出现的顺序 */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}