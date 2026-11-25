# Discord 机器人接入

面向维护者：Discord Bot Gateway 与 REST v10 的协议链路、消息格式、可靠性行为与限制。

本项目对接 Discord **Bot Gateway（WebSocket）+ REST API v10**。插件运行在宿主沙箱里，
没有公网入口，因此不配置 Interactions Endpoint，只建立**出站** Gateway 连接。

## 前置条件

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建
   Application，进入 **Bot** 页执行 **Reset Token** 取得 bot token。
2. 同一页的 **Privileged Gateway Intents** 打开 **Message Content Intent**。未开启时
   Gateway 会以 `4014` 关闭，插件日志会直接给出开启路径；这是「连上又立刻断开」最常见的原因。
3. 用 OAuth2 URL Generator 勾选 `bot` scope 与 **Send Messages** / **Read Message History** /
   **Embed Links** / **Attach Files** 权限，把机器人邀请进目标服务器。
4. **频道 id 不用手填**：`discord.groups` / `discord.privateUsers` 留空即全部（入站不限
   会话，出站发给收到过消息的会话，记录持久化在宿主 `storage:kv`，重启不丢）。需要收窄时：
   频道 id 用「右键频道 → 复制链接」的末段，user id 用「开发者模式 → 右键用户 → 复制用户 ID」。
5. 私聊只能在「用户与机器人有共同服务器」或「用户先私聊过机器人」时建立；否则 Discord
   会以 403 拒绝，适配器无法绕过。
6. 机器人自己及其它 bot 的消息（`author.bot=true`）会被丢弃，不会来回自激；嫌吵可用
   `discord.allowedUsers` 只放行指定发言人。

## 协议链路

- **鉴权**：先 `GET /users/@me` 校验 token，再 `GET /gateway/bot` 取 Gateway 地址。
  REST 请求带 `Authorization: Bot <token>`，日志不打印 token 与完整请求头。
- **Gateway**：连上后等待 op 10 Hello，发 op 2 Identify，默认 intents 为
  `GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15)`（值
  `37376`）。按 Hello 下发的 `heartbeat_interval` 发 op 1，收到 op 11 视为确认；心跳
  连续未确认会主动断开重连。断线优先 op 6 Resume（带 `session_id` 与最新 `seq`），
  `4007` / `4009` 等会话失效才清 session 重新 Identify。
- **出站**：`POST /channels/{channel_id}/messages`，正文按 `maxLength` 分片。
  私聊配置里填的是 **user id**，发送前经 `POST /users/@me/channels`
  （`{recipient_id}`）换成 DM channel id 并缓存（最多 128 个）。
- **关闭码**：`4004` / `4010` / `4011` / `4012` / `4013` / `4014` 视为致命并停止重连；
  `4008` 等待 60 秒；其余优先 Resume。

## 消息格式

| 方向 | 格式 | 说明 |
| --- | --- | --- |
| 游戏 → Discord | `[玩家名]:消息` | 玩家聊天严格使用此格式，例如 `[Steve]:你好` |
| 游戏 → Discord（非聊天） | `[加入] Alex: Alex 加入了游戏` | 用中文类别标签，避免歧义 |
| Discord → 游戏 | `[Discord] 昵称: 消息` | 通过 `injectMode` 注入（默认 `say`，游戏内会多出 `[Server]` 前缀；改成 `tellraw` 则只有单标签）；可选 `discord.server` / `inboundServer` |
| Discord 频道 ↔ 私聊 | `[群] 昵称: ...` / `[私聊] 昵称: ...` | `syncChannels` 镜像，来源会话不重复发送 |
| Discord → 其它平台 | `[Discord 群] 昵称: 消息` / `[Discord 私聊] 昵称: 消息` | 跨平台同步（`crossPlatform`），发到 QQ / Telegram / 微信的所有会话；只转发文本，媒体保留占位，不回发来源平台 |

入站把附件按 `content_type` 转成 `[图片]` / `[视频]` / `[音频]` / `[文件: 名称]`
占位，贴纸转为 `[表情]`。`discord.forwardMedia=true`（默认）时，频道/私聊镜像会把
图片 URL 作为 embed 立即再发一次；**不下载、不上传**。所有出站消息都带
`allowed_mentions: { parse: [] }`，玩家聊天里的 `@everyone` / `@here` 不会变成全员通知。

## 可靠性行为

- **鉴权**：启动时用 `/users/@me` 校验 token；401/403/404 视为凭证或基址错误，直接
  停止重连并打出可操作的日志。
- **重连**：指数退避 + 抖动（`reconnectMinMs` / `reconnectMaxMs`）；
  `reconnectMaxAttempts=0` 表示无限重试。停止时用可中断等待，不会多等一个完整退避周期。
- **限流**：两次 REST 调用之间至少 `sendIntervalMs`；429 读 `retry_after`（秒）等待后
  重试，5xx 与网络错误退避重试，单条消息最多 3 次；401/403/404 不重试。
- **去重**：Discord 的 `message_id` 全局唯一，直接作入站 id；适配器先按最近 1000 条记忆，
  桥内核再按 `platform:id` 去重 10 分钟；Gateway 重投不会重复注入。
- **过滤**：`discord.guilds` 限制服务器、`discord.groups` 限制频道、`discord.privateUsers`
  限制私聊对象，`allowedUsers` 可进一步收窄发言人；被丢弃时告警一次并打印可填进配置的
  channel_id / user_id。
- **频道/私聊互通**：`discord.syncChannels`（默认 `true`）把一条消息再发到除来源会话
  之外的所有目标：频道里发的进私聊、私聊发的进频道。消息带 `[群]` / `[私聊]` 前缀；
  机器人自己发的消息不会触发入站，因此不会回环。没有频道目标时会告警一次「私聊镜像
  暂时发不到频道」，补一条频道消息或填上 `discord.groups` 即可。
- **跨平台同步**：`crossPlatform=true`（默认）时，Discord 收到的消息会以
  `[Discord 群] 昵称: 消息` 发给 QQ / Telegram / 微信 的全部会话，反之同理。转发走适配器自己的
  出站队列，不回流 `ctx.inbound`；跨平台不搬运媒体，只保留正文里的 `[图片]` 等占位。
- **出站目标（跨重启）**：`discord.groups` / `discord.privateUsers` 留空时，目标取
  「收到过消息的会话」，写在宿主 `storage:kv`（键 `discord:targets`）；未授予
  `storage:kv` 时退化为进程内记忆。学习到的私聊目标已经是 DM channel id，重启后可直接复用；
  配置里的 user id 需要重新解析一次 DM（有缓存）。
- **注入安全**：与 QQ / Telegram 相同，`tellraw` / `say` 都过滤控制字符，桥内核按注入
  文本做 60 秒回声抑制。

## 已知限制

- 必须开启 **Message Content Intent**，否则收不到正文（Gateway 4014）。
- 单条正文上限 **2000** 字符，默认 `maxLength=1900` 留出余量；不做 Markdown 转义，
  但在 `allowed_mentions` 里禁用了 @ 解析。
- 附件 URL 是带签名的临期地址，只适合「收到后立即镜像」；不回传、不转存，跨平台也不搬运媒体。
- 私聊受 Discord 的「共同服务器 / 用户先私聊」限制；对陌生用户主动发 DM 可能 403。
- 当前只支持单分片；机器人规模超出单分片（Gateway 返回 4010/4011）时直接停止并说明原因。
- 帖子（thread）按普通频道 id 处理；已归档帖子或权限不足会发送失败，需要先在 Discord 里放开权限。
- 不订阅编辑 / 删除事件，也不实现 Slash Command；需要时在 Gateway 事件与去重键上单独扩展。

## 本地验证

`test/discord.test.ts` 用真实的 HTTP 假 REST + WebSocket 假 Gateway 覆盖：配置解析、
Identify（默认 intents）、频道/私聊入站与白名单、learned targets、私聊 user id →
DM channel 缓存、分片、频道/私聊镜像与图片 embed、跨平台 `relay`、429 重试、401 停止、
关闭码 4009 重新 Identify / 4000 Resume / 4014 致命提示。真实联调只需把
`discord.botToken` 换成 Developer Portal 的 token，打开 Message Content Intent 并把
机器人拉进服务器。

