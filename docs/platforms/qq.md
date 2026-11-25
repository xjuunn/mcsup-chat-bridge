# QQ 官方机器人接入

面向维护者：QQ 开放平台官方机器人 API v2 的协议链路、消息格式、可靠性行为与限制。

本项目对接的是 **QQ 开放平台官方机器人 API v2**（`bot.q.qq.com`），不是 OneBot 社区实现。

## 前置条件

1. 在 [QQ 开放平台](https://q.qq.com/open) 创建机器人，取得 **AppID** 与 **ClientSecret**。
2. 在机器人管理端配置事件订阅：群聊/单聊消息；如需频道能力，另开 `guilds` 等 intents。
3. 把机器人拉进目标群即可。**openid 不用手填**：`qq.groups` / `qq.privateUsers` 留空即全部
   （入站不限会话，出站发给收到过消息的会话，记录持久化在宿主 `storage:kv`，重启不丢）；
   需要收窄范围时再填 `group_openid` /
   `user_openid`（不是群号 / QQ 号，可从 `mcsup plugin logs chat-bridge` 的入站日志里取）。
4. 官方机器人在群里**默认只能收到 @ 它的消息**（`GROUP_AT_MESSAGE_CREATE`）。群聊全量消息
   `GROUP_MESSAGE_CREATE` 与它**同属 intent `1<<25`**，本插件的默认 intents
   （`group_and_c2c`）已经覆盖，不需要改代码或加订阅。
   开启方式：**群主**用最新版手机 QQ 打开该群 → 点机器人头像 → 右上角齿轮 →
   把「机器人可获取的群聊消息范围」设为**获取群内全部消息**（部分管理端也叫
   「接收所有消息」）。开启后群内每条消息都会推送，未 @ 的消息同样注入游戏。
   注意：手机 QQ 版本过旧只支持私聊，看不到该设置项。
   机器人自己的发言（`author.bot=true`）会被丢弃，不会来回自激；嫌吵可用
   `qq.allowedUsers` 只放行指定发言人。

## 协议链路

- **访问凭证**：`POST https://bots.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}`，返回 `{access_token, expires_in}`；随后所有 OpenAPI 请求带 `Authorization: QQBot <access_token>`。
- **事件**：`GET {apiBase}/gateway` 取 wss 地址，连上后等待 op 10 Hello，再发 op 2 Identify（`token: "QQBot <token>"` + `intents` + `shard`）。断线优先 op 6 Resume；会话失效才重新 Identify。
- **发送**：`POST /v2/groups/{group_openid}/messages` 或 `/v2/users/{user_openid}/messages`，`msg_type=0` 纯文本、`2` Markdown。
- **被动回复**：记录每个会话最近一条入站消息的 `msg_id`，出站时带 `msg_id + 递增 msg_seq`。额度用尽或窗口过期才降级为主动消息。

## 消息格式

| 方向 | 格式 | 说明 |
| --- | --- | --- |
| 游戏 → QQ | `[玩家名]:消息` | 玩家聊天严格使用此格式，例如 `[Steve]:你好` |
| 游戏 → QQ（非聊天） | `[加入] Alex: Alex 加入了游戏` | 用中文类别标签，避免歧义 |
| QQ → 游戏 | `[QQ] 昵称: 消息` | 通过 `injectMode` 注入（默认 `say`，游戏内会多出 `[Server]` 前缀；改成 `tellraw` 则只有单标签）；可选 `qq.server` / `inboundServer` |
| QQ → 其它平台 | `[QQ 群] 昵称: 消息` / `[QQ 私聊] 昵称: 消息` | 跨平台同步（`crossPlatform`），发到 Telegram 的所有会话；只转发文本，图片等媒体保留 `[图片]` 占位，不回发来源平台 |

出站只发送纯文本（或显式开启的 Markdown），不拼任何平台标记；入站会把 `<@openid>` 映射成昵称、去掉机器人自身的 @，附件转为 `[图片]` / `[语音] ASR` / `[文件: 名称]` 占位文本。

## 可靠性行为

- **鉴权**：`clientSecret` 只用于换 token，且只发给官方凭证地址；OpenAPI 用 `Authorization: QQBot`。
- **重连**：指数退避 + 抖动；关闭码语义按官方协议处理——`4004` 清 token、`4006/4007/4900~4913` 重建会话、`4008` 限流等待 60 秒、`4013/4014/4914/4915` 等致命错误停止重连。
- **心跳**：按 Hello 下发的 `heartbeat_interval` 发送 op 1，并带最新 `s`。
- **限流**：两次 OpenAPI 调用之间至少 `sendIntervalMs`；429/5xx 退避重试；`msg_id+msg_seq` 重复时换 seq 重发。
- **去重**：入站按消息 id 记忆最近 1000 条，桥内核再按 `platform:id` 去重 10 分钟；重连后不会重复注入。
- **过滤**：只接收 `qq.groups` 内的群与 `qq.privateUsers` 内的私聊；`allowedUsers` 可进一步收窄发言人；机器人自己的消息不会被回灌。
- **群/私聊互通**：`qq.syncChannels`（默认 `true`）把一条 QQ 消息再发到除来源会话之外的所有目标：群里发的进私聊、私聊发的进群。消息带 `[群]` / `[私聊]` 前缀，来源会话跳过所以不会重复；机器人自己发的消息不触发入站事件，不会回环。图片（`qq.forwardMedia=true`）用**一条消息**转发：`qq.mediaMode=markdown`（默认）先转存平台素材库，再发单条 Markdown 图文 `[群] 昵称: 文字 ![图片 #宽px #高px](qqbot-media://...)`，文字在前、图片在后，手机 QQ 也能显示（实验确认：Markdown 图片不带宽高时手机和电脑都只显示 `[图片]`）。普通图片按最长边 480px 等比缩小，纯表情贴纸按 160px 缩小，避免表情被放大；`rich` 发单条富媒体（图片在上、文字在下）。素材引用保留 90 天滑动有效，配额满 100 张时自动淘汰最旧的一半。Markdown 转存或发送失败会自动退回 `rich`。纯表情消息会把贴纸并进同一条消息，不再额外补一条 `[表情]`；无贴纸可转发时显示 `[表情]` 文本。
- **跨平台同步**：`crossPlatform=true`（默认）时，QQ 收到的消息会以 `[QQ 群] 昵称: 消息` / `[QQ 私聊] 昵称: 消息` 发给 Telegram 的全部会话。转发只走 Telegram 自己的出站队列，不回流 `ctx.inbound`，不会成环；来源平台由内核排除。跨平台不搬运媒体，正文保留 `[图片]` 等占位。
- **出站目标（跨重启）**：`qq.groups` / `qq.privateUsers` 留空时，目标取「收到过消息的会话」。这份记录写在宿主 `storage:kv`（键 `qq:targets`，文件在 `plugin-data/chat-bridge/kv/`，按插件 id 划分，插件升级不丢），只在真的新增/淘汰会话时写一次，写入失败只告警一次且不影响收发。未授予 `storage:kv` 时退化为进程内记忆并在日志说明。群的 `group_openid` 只能在群消息或入群事件里得知，所以群从未说过话时私聊镜像无处可发——这时会告警一次「私聊镜像暂时发不到群」，补一条群消息或填上 `qq.groups` 即可。
- **注入安全**：`tellraw` 用 JSON 组件转义、`say` 用单行文本；两种方式都过滤控制字符，并在桥内核按注入文本做 60 秒回声抑制，避免「游戏 → QQ → 游戏」自激。注入成功时会在插件日志写一行 `[qq] 注入 <server>：[QQ] 昵称: 消息`，便于核对。
- **注入方式与日志**：原版 Minecraft 只有 `say`/`me` 这类服务器广播会写进 `logs/latest.log`。因此「游戏内只有 `[QQ]` 标签」与「QQ 消息出现在服务器日志」不可兼得：默认 `injectMode="say"` 让日志可查，但游戏内会显示 `[Server] [QQ] ...`；改成 `injectMode="tellraw"` 则只有单标签，服务器日志里没有。

## 官方频控（不可绕过）

- 主动消息：群 bot 维度 60 条/分钟、单关系 20 条/分钟、每群 1000 条/天；单聊 20 条/分钟、1000 条/天/用户。
- 被动回复：单聊 60 分钟内 4 次、群聊 5 次、群管理员 50 次，且必须带 60 分钟内的 `msg_id`。

因此适配器默认优先被动回复，并把 `sendIntervalMs` 当保护值；高频服务器建议只转发 `chat` / `join` / `leave` / `death` 等关键类别。

## 本地验证

没有真实 QQ 凭证时，`npm run test:real` 会启动一个真实的 **HTTP OpenAPI + WebSocket Gateway** 假服务端，并验证：

- `AppID/ClientSecret` 换 token，Identify 的 `token` 为 `QQBot <access_token>`、默认 intents 为 `group_and_c2c`；
- 游戏事件 → `POST /v2/groups/<openid>/messages`，`msg_type=0`、文本为 `[Steve]:有人吗`、带 `msg_seq`；
- QQ 群消息事件 → 宿主 `console:write/send_line`，命令为默认注入方式
  `say [QQ] 小A: 来自QQ`；把 `injectMode` 热更新成 `tellraw` 后再来一条，命令变成
  `tellraw @a {"text":"[QQ] 小A: 切换注入方式"}`；
- 非白名单群与重复消息 id 不会二次注入；
- `status.inbound` 计数正确，进程最终以退出码 0 结束。

真实联调只需把 `qq.appId` / `qq.clientSecret` / `qq.groups` 换成机器人的实际配置。

