# Telegram 机器人接入

面向维护者：Telegram Bot API 长轮询的协议链路、消息格式、可靠性行为与限制。

本项目对接的是 **Telegram Bot API**（`api.telegram.org`），走 **`getUpdates` 长轮询**
而不是 webhook：插件运行在宿主沙箱里，没有公网入口，长轮询是唯一不需要暴露端口的
方案。offset 持久化在宿主 `storage:kv`（键 `telegram:offset`），重启不会重复收取
已经确认过的 update。

## 前置条件

1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)，`/newbot` 创建机器人并取得
   **bot token**（形如 `123456:AAAA...`）；已有机器人用 `/token` 重新查看。
2. **群聊必须关闭隐私模式**：BotFather 里 `/setprivacy` → 选中该机器人 → `Disable`。
   Telegram 默认只把 @ 机器人或命令消息推给机器人；关闭后群内每条消息都会推送。
   私聊不受此限制。修改后需要把机器人移出群再拉回（或重启会话）才生效。
3. 把机器人拉进目标群即可。**chat_id / user id 不用手填**：`telegram.groups` /
   `telegram.privateUsers` 留空即全部（入站不限会话，出站发给收到过消息的会话，
   记录持久化在宿主 `storage:kv`，重启不丢）；拉群时会直接记下群 chat_id，
   也可以发一条群消息让它学习。需要收窄范围时再填 chat_id。
   Telegram 的群 id 是负数（超级群/论坛群形如 `-1001234567890`），私聊 id 是正数；
   两者都能从 `mcsup plugin logs chat-bridge` 的入站日志里看到。
4. **论坛群（话题）**：适配器会记住收到的 `message_thread_id`，出站回到同一个话题；
   `General` 话题的 id 固定为 `1`，发送时自动省略（否则 Telegram 会拒绝）。
5. 机器人自己的消息（`from.is_bot=true`）会被丢弃，不会来回自激；嫌吵可用
   `telegram.allowedUsers` 只放行指定发言人。

## 协议链路

- **入站**：`POST {apiBase}/bot{token}/getUpdates`，带 `offset`（最后确认的
  `update_id + 1`）、`timeout`（长轮询秒数）、`limit` 与
  `allowed_updates: ["message", "my_chat_member"]`。只处理新消息；`edited_message`
  的 `message_id` 与原文相同，会被去重挡掉，因此不订阅。`my_chat_member` 用来
  捕获机器人入群 / 被移出：入群即记下群 chat_id 作为出站目标（不必等群里先开口），
  被移出则忘掉该目标。
- **出站**：`POST /sendMessage`，`parse_mode: "HTML"`，文本按 `&` / `<` / `>`
  转义后发送；超长按 `maxLength` 分片。媒体用 `sendPhoto` / `sendVideo` /
  `sendAnimation` / `sendDocument`，直接复用 Telegram 的 `file_id`（不下载、
  不上传），文字在前、媒体在后。
- **冲突**：同一个 bot 只能有一个 `getUpdates` 消费者。若另一个实例或残留 webhook
  占位（409），首次自动 `deleteWebhook` 一次，之后仍冲突则退避 10 秒重试。

## 消息格式

| 方向 | 格式 | 说明 |
| --- | --- | --- |
| 游戏 → Telegram | `[玩家名]:消息` | 玩家聊天严格使用此格式，例如 `[Steve]:你好` |
| 游戏 → Telegram（非聊天） | `[加入] Alex: Alex 加入了游戏` | 用中文类别标签，避免歧义 |
| Telegram → 游戏 | `[Telegram] 昵称: 消息` | 通过 `injectMode` 注入（默认 `say`，游戏内会多出 `[Server]` 前缀；改成 `tellraw` 则只有单标签）；可选 `telegram.server` / `inboundServer` |
| Telegram 群 ↔ 私聊 | `[群] 昵称: ...` / `[私聊] 昵称: ...` | `syncChannels` 镜像，来源会话不重复发送 |
| Telegram → 其它平台 | `[Telegram 群] 昵称: 消息` / `[Telegram 私聊] 昵称: 消息` | 跨平台同步（`crossPlatform`），发到 QQ 的所有会话；只转发文本，媒体保留占位，不回发来源平台 |

入站会把图片、视频、动图、语音、音频、视频消息、表情、文件、位置、投票、联系人、
骰子转成 `[图片]` / `[视频]` / `[文件: 名称]` 之类的占位文本；一个消息只会有一种媒体
（GIF 同时带 `animation` 与 `document` 时按动图记一次）。

## 可靠性行为

- **鉴权**：启动时用 `getMe` 校验 token；401/404 视为凭证或基址错误，直接停止重连
  并打出可操作的日志，不会无限刷屏。
- **重连**：指数退避 + 抖动（`reconnectMinMs` / `reconnectMaxMs`）；
  `reconnectMaxAttempts=0` 表示无限重试。
- **限流**：两次 Bot API 调用之间至少 `sendIntervalMs`；429 读
  `parameters.retry_after` 等待后重试；5xx 与网络错误按退避重试，单条消息最多
  3 次。
- **去重**：Telegram 的 `message_id` 只在单个会话内唯一，适配器用
  `${chat_id}:${message_id}` 生成入站 id，先按最近 1000 条记忆，桥内核再按
  `platform:id` 去重 10 分钟；长轮询重发不会重复注入。
- **过滤**：`telegram.groups` 限制允许的群、`telegram.privateUsers` 限制私聊对象，
  `allowedUsers` 可进一步收窄发言人；被丢弃时会告警一次并打印可填进配置的
  chat_id / user_id，方便收窄范围。
- **群/私聊互通**：`telegram.syncChannels`（默认 `true`）把一条消息再发到除来源
  会话之外的所有目标：群里发的进私聊、私聊发的进群。消息带 `[群]` / `[私聊]`
  前缀；机器人自己发的消息不会触发入站，因此不会回环。媒体（`forwardMedia=true`）
  跟在文字后面用 `file_id` 转发；没有群目标时会告警一次「私聊镜像暂时发不到群」，
  补一条群消息或填上 `telegram.groups` 即可。
- **跨平台同步**：`crossPlatform=true`（默认）时，QQ 收到的消息会以
  `[QQ 群] 昵称: 消息` 发给 Telegram 的全部会话，反之同理。转发走适配器自己的
  出站队列，不回流 `ctx.inbound`，所以不会形成 qq → telegram → qq 的环；来源平台
  由内核排除。跨平台不搬运媒体：QQ 需要 `qqbot-media://`、Telegram 用 `file_id`，
  两者不通用，只保留正文里的 `[图片]` 等占位。
- **出站目标（跨重启）**：`telegram.groups` / `telegram.privateUsers` 留空时，目标
  取「收到过消息的会话」，写在宿主 `storage:kv`（键 `telegram:targets`），只在真的
  新增/淘汰会话时写一次；未授予 `storage:kv` 时退化为进程内记忆。机器人入群时
  从 `my_chat_member` 直接记下群目标，被移出时忘记它。
- **群升级**：普通群升级为超级群后 chat_id 会变；发送失败若带
  `migrate_to_chat_id`，本次改用新 id 发送并告警，提示把 `telegram.groups` 更新为
  新 id。
- **注入安全**：与 QQ 相同，`tellraw` / `say` 都过滤控制字符，桥内核按注入文本做
  60 秒回声抑制。

## 已知限制

- 单条消息上限 **4096** 字符（按 UTF-16 计长，适配器不会切断 emoji 代理对），
  caption 上限 1024 字符；默认 `maxLength=3500` 留出余量。
- 公开 Bot API 的 `getFile` 下载上限 **20 MB**；本适配器只复用 `file_id` 转发，
  不下载文件，因此不受该限制影响，但 `file_id` 只对**同一个 bot** 有效。
- 不订阅频道（`channel_post`）与编辑消息；需要时扩展 `allowed_updates` 即可，但要
  同时调整去重键，否则编辑后的消息会被当成重复丢弃。
- 长轮询意味着**一个 bot 只能有一个插件实例**消费更新；同一 token 配到两台宿主会
  互相抢消息（409 冲突，双方轮流 `deleteWebhook` 并重试）。

## 排障：消息只走一边

先看 `mcsup plugin logs chat-bridge`，按日志定位，不要猜：

| 现象 | 日志 | 原因 / 处理 |
| --- | --- | --- |
| 游戏里说话，Telegram 收不到 | `还没有可用的会话目标` | 出站目标还没学到。把机器人拉进群（入群事件会自动记录），或在群里发一条消息；也可以显式填 `telegram.groups` |
| 群里发消息，游戏里没反应 | 没有 `收到群消息：chat_id=...` | BotFather 的**隐私模式**还开着（`/setprivacy` → `Disable`），然后必须把机器人移出群再拉回；只改开关不重拉不生效。若日志里出现「丢弃群消息」，按括号里的原因处理 |
| 群里发消息，日志有 `收到群消息` 但游戏没反应 | `注入 <server>` / `未注入` | 目标服务器没在运行、`inbound=false`，或 `inboundServer` 选了别的服务器；看注入日志里的服务器名 |
| 私聊没反应 | `丢弃私聊（私聊未启用…）` | 默认不接私聊。全局打开：`mcsup plugin config set chat-bridge privateSync true`，或在安装向导里选「同步私聊消息 = 是」；只开单个平台时用 `telegram.allowPrivate` / `qq.allowPrivate`（注意陌生人也能私聊机器人） |
| 偶发 `fetch failed` | 后面跟着 `N ms 后重试` | 到 `api.telegram.org` 的网络抖动（代理 / TUN 切换时常见）；新版本会把 `cause`（`ECONNRESET` / `ENOTFOUND` 等）一起打出来。持续失败再检查代理 |

定位顺序固定为：**有没有收到更新** → **有没有目标** → **有没有注入**。
`mcsup plugin logs chat-bridge` 里三条关键日志分别是 `收到群消息`、
`已加入群` / `还没有可用的会话目标`、`注入 <server>`。

## 本地验证

`test/telegram.test.ts` 用真实的 HTTP 假 Bot API（含长轮询挂起 / 唤醒）覆盖：配置
解析、`getMe` 校验、入站归一化与白名单、learned targets、HTML 转义与分片、
群/私聊镜像、媒体 `file_id`、论坛话题、429 重试、offset 持久化与重启、401 停止、
409 `deleteWebhook`、停止后不再发送。真实联调只需把 `telegram.botToken` 换成
@BotFather 发放的 token，并把机器人拉进群。

