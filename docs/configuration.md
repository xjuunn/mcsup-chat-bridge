# 配置参考

配置由 `src/config.ts` 的 zod schema 校验，宿主下发的非法值会在握手阶段以配置错误退出（退出码 3）。面向使用者的最小配置见 `README.md`。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `platforms` | `["log"]` | 启用的适配器 id；空数组表示只采集 |
| `forwardCategories` | `["chat"]` | 转发到平台的类别；默认只转发玩家聊天。需要加入/离开、死亡、进度、系统行时再显式追加；仍会采集入库 |
| `consoleForward` | `false` | 默认不转发控制台/日志行（`source=console`）；只采集入库。需要把服务器 `say`、日志同步到平台时再打开 |
| `storeSize` | `200` | 环形缓存条数（10–5000） |
| `queueCapacity` | `256` | 单平台出站与全局入站队列的积压上限（8–4096），超出丢最旧 |
| `inbound` | `true` | 是否允许平台消息注入游戏；关闭后 QQ / Telegram / Discord / 微信仍可出站 |
| `crossPlatform` | `true` | 是否让平台之间互相同步：一个平台收到的消息转给其它所有启用了同步的平台（如 QQ ↔ Telegram ↔ Discord ↔ 微信）。与 `inbound` 独立：关掉入站只影响「平台 → 游戏」，平台之间仍互通；关掉它则各平台只与游戏双向。只有实现 `relay` 的适配器会接收转发，`log` / `null` 不接收 |
| `privateSync` | `false` | 是否接收私聊：一次对所有已选平台生效，开启后私聊参与注入游戏、群/私聊镜像与跨平台同步。与各平台的 `allowPrivate` 取并集（平台里显式打开的不受它影响）；只影响声明了私聊能力的适配器（QQ / Telegram / Discord / 微信） |
| `inboundServer` | 自动 | 入站默认服务器；省略时选运行中的服务器 |
| `inboundMaxLength` | `200` | 单条入站文本上限（32–512），超长截断 |
| `injectMode` | `"say"` | 平台消息注入游戏的方式：`say` 会写入 `logs/latest.log`，但游戏内多出 `[Server]` 前缀；`tellraw` 游戏里只有 `[QQ]` / `[Telegram]` 标签但不写服务器日志（原版只有 `say`/`me` 这类服务器广播会进日志） |
| `log.prefix` | `"chat-bridge"` | 日志平台前缀 |
| `log.level` | `"info"` | `info` / `debug` |
| `qq.appId` | 无（必填） | QQ 开放平台机器人 AppID |
| `qq.clientSecret` | 无（必填） | 密钥；用于换取 `access_token`，界面遮蔽、读取打码 |
| `qq.sandbox` | `false` | 为 `true` 时用 `sandbox.api.sgroup.qq.com` |
| `qq.apiBase` | 按 sandbox 推导 | OpenAPI 基址，一般无需修改 |
| `qq.tokenUrl` | 官方凭证地址 | `https://bots.qq.com/app/getAppAccessToken` |
| `qq.intents` | `["group_and_c2c"]` | 事件订阅位；可选 `guilds` / `direct_message` / `interaction` 等 |
| `qq.markdown` | `false` | 为 `true` 用 `msg_type=2` 发 Markdown；默认纯文本避免符号被渲染。群/私聊镜像的图片始终优先用 Markdown 图文，与此开关无关 |
| `qq.groups` | `[]` | 出站 `group_openid`；同时是入站白名单。**留空 = 全部**：入站不限群，出站发给收到过消息的群。学到的群记在宿主 `storage:kv`（`plugin-data/chat-bridge/kv/`），插件重启后仍然有效 |
| `qq.privateUsers` | `[]` | 出站私聊 `user_openid`。**留空 = 全部**：入站不限对象，出站发给给机器人发过消息的用户。同样持久化在 `storage:kv` |
| `qq.allowedUsers` | `[]` | 非空时只允许这些 openid 进入游戏 |
| `qq.categories` | 沿用全局 | QQ 出站类别过滤 |
| `qq.inbound` | `true` | 是否把 QQ 消息注入游戏；为 `false` 时仍参与群/私聊镜像与跨平台同步 |
| `qq.allowPrivate` | `false` | 是否接收私聊（默认关闭，避免陌生人打扰）；顶层 `privateSync=true` 时同样生效（两者取并集） |
| `qq.syncChannels` | `true` | 群聊与私聊互相同步：群里收到的消息也会发到私聊目标，私聊收到的也会发到群目标；只影响 QQ 内部会话，不影响游戏注入；来源会话不重复发送 |
| `qq.forwardMedia` | `true` | 群/私聊互转时用一条消息转发图片（文字在前、图片在后）。QQ 表情统一转为 `[表情]` |
| `qq.mediaMode` | `"markdown"` | `markdown`：单条 Markdown 图文，图片先转存平台素材库换成 `qqbot-media://` 引用并带 `#宽px #高px`（QQ 客户端不带宽高只显示 `[图片]`），普通图片最长边 480px、纯表情贴纸 160px；`rich`：单条富媒体（图片在上、文字在下）。Markdown 上传或发送失败会自动退回 `rich` |
| `qq.label` | `"QQ"` | 游戏内显示为 `[QQ] 昵称: 消息` |
| `qq.server` | 全局 | 该适配器的入站默认服务器，同时决定插件跟随哪台服务器启停 |
| `qq.maxLength` | `1500` | 单条出站上限，超出按此分片（官方上限约 4000） |
| `qq.passiveReply` | `true` | 优先用最近入站消息的 `msg_id` 被动回复 |
| `qq.passiveLimit` | `4` | 同一消息最多被动回复次数（群聊 5、管理员 50） |
| `qq.passiveTtlMs` | `3300000` | 被动回复时效，官方窗口 60 分钟 |
| `qq.sendIntervalMs` | `500` | 两次 OpenAPI 调用的最小间隔，温柔限流 |
| `qq.apiTimeoutMs` | `15000` | 单次 HTTP 调用超时 |
| `qq.reconnectMinMs` / `reconnectMaxMs` | `1000` / `60000` | 重连退避范围（带抖动） |
| `qq.reconnectMaxAttempts` | `0` | 最大重连次数，0 表示无限重试 |
| `telegram.botToken` | 无（必填） | @BotFather 发放的机器人 token（形如 `123456:AAAA...`）；界面遮蔽、读取打码 |
| `telegram.apiBase` | `"https://api.telegram.org"` | Bot API 基址；使用自建 Bot API 服务时再改 |
| `telegram.groups` | `[]` | 出站群 `chat_id`（群/超级群为负，如 `-1001234567890`，也可写 `@username`），同时是入站白名单。**留空 = 全部**：入站不限群，出站发给收到过消息的群；学到的群记在宿主 `storage:kv`，重启后仍有效 |
| `telegram.privateUsers` | `[]` | 出站私聊 `user id`（数字或 `@username`）。**留空 = 全部**：出站发给给机器人发过消息的用户；同样持久化 |
| `telegram.allowedUsers` | `[]` | 非空时只允许这些 `user id` / `@username` 的消息进入游戏 |
| `telegram.categories` | 沿用全局 | Telegram 出站类别过滤 |
| `telegram.inbound` | `true` | 是否把 Telegram 消息注入游戏；为 `false` 时仍参与群/私聊镜像与跨平台同步 |
| `telegram.allowPrivate` | `false` | 是否接收私聊（默认关闭，避免陌生人打扰）；顶层 `privateSync=true` 时同样生效（两者取并集） |
| `telegram.syncChannels` | `true` | 群聊与私聊互相同步：群里收到的消息也会发到私聊目标，私聊收到的也会发到群目标；来源会话不重复发送 |
| `telegram.forwardMedia` | `true` | 群/私聊互转时转发图片/视频/动图/文件，复用 Telegram 的 `file_id`（不下载、不上传），文字在前、媒体在后 |
| `telegram.label` | `"Telegram"` | 游戏内显示为 `[Telegram] 昵称: 消息` |
| `telegram.server` | 全局 | 该适配器的入站默认服务器，同时决定插件跟随哪台服务器启停 |
| `telegram.maxLength` | `3500` | 单条出站上限，超出按此分片（Telegram 上限 4096，按 UTF-16 计长） |
| `telegram.linkPreview` | `false` | 是否展开消息里的网页预览；默认关闭避免刷屏 |
| `telegram.sendIntervalMs` | `1000` | 两次 Bot API 调用的最小间隔，温柔限流（同一群官方限制约 20 条/分钟） |
| `telegram.apiTimeoutMs` | `15000` | 单次 HTTP 调用超时 |
| `telegram.pollTimeoutSecs` | `30` | `getUpdates` 长轮询等待秒数（Bot API 上限 50） |
| `telegram.pollLimit` | `100` | 单次 `getUpdates` 最多取多少条（Bot API 上限 100） |
| `telegram.reconnectMinMs` / `reconnectMaxMs` | `1000` / `60000` | 断线重连退避范围（带抖动） |
| `telegram.reconnectMaxAttempts` | `0` | 最大重连次数，0 表示无限重试；401/404 凭证问题会直接停止 |
| `discord.botToken` | 无（必填） | Discord Developer Portal → Bot → Reset Token 得到的 token；界面遮蔽、读取打码 |
| `discord.apiBase` | `"https://discord.com/api/v10"` | REST 基址；使用自建代理时再改 |
| `discord.guilds` | `[]` | 非空时只接收这些服务器（guild）的消息；留空表示不限 |
| `discord.groups` | `[]` | 出站频道 id，同时是群聊入站白名单。**留空 = 全部**：入站不限频道，出站发给收到过消息的频道；学到的频道记在宿主 `storage:kv`，重启后仍有效 |
| `discord.privateUsers` | `[]` | 出站私聊 **user id**（不是 DM 频道 id）。**留空 = 全部**：出站发给给机器人发过私聊的用户；发送前自动换成 DM 频道并缓存 |
| `discord.allowedUsers` | `[]` | 非空时只允许这些 user id 的消息进入游戏 |
| `discord.categories` | 沿用全局 | Discord 出站类别过滤 |
| `discord.inbound` | `true` | 是否把 Discord 消息注入游戏；为 `false` 时仍参与频道/私聊镜像与跨平台同步 |
| `discord.allowPrivate` | `false` | 是否接收私聊（默认关闭，避免陌生人打扰）；顶层 `privateSync=true` 时同样生效（两者取并集） |
| `discord.syncChannels` | `true` | 频道与私聊互相同步：频道里收到的消息也会发到私聊目标，私聊收到的也会发到频道目标；来源会话不重复发送 |
| `discord.forwardMedia` | `true` | 频道/私聊互转时把入站图片 URL 作为 embed 立即重发（不下载、不上传）；视频/音频/文件只保留占位文本 |
| `discord.label` | `"Discord"` | 游戏内显示为 `[Discord] 昵称: 消息` |
| `discord.server` | 全局 | 该适配器的入站默认服务器，同时决定插件跟随哪台服务器启停 |
| `discord.maxLength` | `1900` | 单条出站上限，超出按此分片（Discord 上限 2000） |
| `discord.sendIntervalMs` | `1000` | 两次 REST 调用的最小间隔，温柔限流（Discord 每个频道约 5 条/5 秒） |
| `discord.apiTimeoutMs` | `15000` | 单次 HTTP 调用超时 |
| `discord.reconnectMinMs` / `reconnectMaxMs` | `1000` / `60000` | 断线重连退避范围（带抖动） |
| `discord.reconnectMaxAttempts` | `0` | 最大重连次数，0 表示无限重试；401 凭证问题会直接停止 |
| `weixin.botToken` | 无（必填） | 微信机器人 token，只能由 `node scripts/weixin-login.mjs` 扫码取得（形如 `wxbot_...`）；界面遮蔽、读取打码 |
| `weixin.apiBase` | `"https://ilinkai.weixin.qq.com"` | iLink 基址；扫码登录返回的 `baseurl` 不同时再改 |
| `weixin.privateUsers` | `[]` | 出站私聊 user id，同时是入站白名单。**留空 = 全部**：入站不限对象，出站发给给机器人发过消息的用户；学到的目标记在宿主 `storage:kv`，重启后仍有效 |
| `weixin.allowedUsers` | `[]` | 非空时只允许这些 user id 的消息进入游戏 |
| `weixin.categories` | 沿用全局 | 微信出站类别过滤 |
| `weixin.inbound` | `true` | 是否把微信消息注入游戏；为 `false` 时仍参与跨平台同步 |
| `weixin.allowPrivate` | `true` | 微信官方客户端只有单聊形态，默认接收；关闭后既不注入游戏也不参与跨平台同步（顶层 `privateSync=true` 时同样生效，两者取并集） |
| `weixin.label` | `"微信"` | 游戏内显示为 `[微信] 微信用户-xxxxxx: 消息`。协议没有昵称字段，显示名由 `from_user_id` 派生成稳定短别名（SHA-256 前 6 位十六进制） |
| `weixin.server` | 全局 | 该适配器的入站默认服务器，同时决定插件跟随哪台服务器启停 |
| `weixin.maxLength` | `1500` | 单条出站上限，超出按此分片（微信没有公开上限，按保守值切分） |
| `weixin.sendIntervalMs` | `1000` | 两次 iLink 调用的最小间隔，温柔限流 |
| `weixin.apiTimeoutMs` | `15000` | 单次 HTTP 调用超时 |
| `weixin.pollTimeoutMs` | `35000` | `getUpdates` 长轮询等待毫秒数；服务端可用 `longpolling_timeout_ms` 调整 |
| `weixin.reconnectMinMs` / `reconnectMaxMs` | `1000` / `60000` | 断线重连退避范围（带抖动） |
| `weixin.reconnectMaxAttempts` | `0` | 最大重连次数，0 表示无限重试；401/403 凭证问题会直接停止 |

平台专属配置放在与适配器 id 同名的字段下。QQ 示例：

```json
{
  "platforms": ["qq"],
  "forwardCategories": ["chat", "command", "join", "leave", "death", "advancement"],
  "inbound": true,
  "inboundServer": "survival",
  "privateSync": false,
  "qq": {
    "appId": "102000001",
    "clientSecret": "your-client-secret",
    "groups": ["GROUP_OPENID"],
    "allowedUsers": [],
    "allowPrivate": false,
    "syncChannels": true,
    "forwardMedia": true,
    "mediaMode": "markdown",
    "label": "QQ",
    "server": "survival"
  }
}
```

Telegram 示例（多个平台可同时启用）：

```json
{
  "platforms": ["qq", "telegram", "discord"],
  "forwardCategories": ["chat"],
  "inbound": true,
  "inboundServer": "survival",
  "privateSync": true,
  "qq": {
    "appId": "102000001",
    "clientSecret": "your-client-secret"
  },
  "telegram": {
    "botToken": "123456:AA...",
    "groups": ["-1001234567890"],
    "privateUsers": [],
    "allowPrivate": true,
    "syncChannels": true,
    "forwardMedia": true,
    "label": "Telegram",
    "server": "survival"
  },
  "discord": {
    "botToken": "MTIzNDU2...",
    "guilds": [],
    "groups": ["123456789012345678"],
    "privateUsers": [],
    "allowPrivate": true,
    "syncChannels": true,
    "forwardMedia": true,
    "label": "Discord",
    "server": "survival"
  }
}
```

**密钥与持久化**：`qq.clientSecret` / `telegram.botToken` / `discord.botToken` /
`weixin.botToken` 用 SDK 的 `secretInput` 标记，descriptor 里是 `x-mcsup-secret: true`。
宿主负责按插件隔离、加密持久化（`secrets.json`），管理端读取时返回 `***`，插件握手时
收到明文才能工作；插件自身不落盘任何密钥，日志与 `status` 也不会输出 `clientSecret`、
`botToken` 或 `access_token`。Telegram 的 HTTP URL 含 token，Discord 的请求头含 token，
微信的 `Authorization: Bearer` 含 token，适配器日志只记录方法名与路由，不打印完整 URL /
Authorization。微信登录脚本不把 token 写进仓库或插件 KV：交互式安装时只写 0600 临时文件，
手工运行时只打印一次并交给宿主配置。

**写入顺序（手工配置时）**：`mcsup plugin config set` 每次都会对**合并后的完整配置**
做 schema 校验。`qq` / `telegram` / `discord` / `weixin` 片段都是可选的，但**一旦写了片段**，其中
`qq.appId` + `qq.clientSecret`、`telegram.botToken`、`discord.botToken`、`weixin.botToken`
就是必填项
（片段写一半会得到 `config.telegram.botToken: required field is missing`，且该次写入
不会生效）。所以手工配置时先写完整的平台块，再写 `platforms` 等顶层键：

安装向导不走这条路径：它用深度合并按字段写入，只改目标键，不会覆盖平台块的
其它值，也不会把打码后的 `***` 写回；而且只问**所选平台**需要的凭据，没选的
平台不会创建对应片段。下面的手工写法只用于装完之后补改：

```bash
# 先写平台整块
mcsup plugin config set chat-bridge qq '{"appId":"...","clientSecret":"..."}'
mcsup plugin config set chat-bridge telegram '{"botToken":"123456:AA..."}'
# 再写其余顶层键
mcsup plugin config set chat-bridge platforms '["qq","telegram","log"]'
```

**能力声明**：`events`、`storage:kv`、`console:read`、`console:write`、`server:read`。
`storage:kv` 属低风险能力（安装即得），用来记住留空配置时的出站会话目标，
让插件重启后不必等群里先说话；未授予时退化为进程内记忆并在日志说明。
`console:write` 属高风险能力，安装向导会把它列进授权清单，由用户一次确认
（`--yes` 视为同意）；`--no-setup` 时仍需显式 `mcsup plugin grant chat-bridge console:write`。
未授予时插件仍会正常出站，但 QQ → 游戏方向降级为仅计数并在日志与
`status.inbound.failed` 中体现，不会假装成功。

配置热更新的语义：

- 只改 `forwardCategories`、`consoleForward`、`storeSize`：立即生效，不重建平台。
- 平台列表、平台配置或 `queueCapacity` 变化：先启动新分发器，成功后停旧平台；新平台启动失败会抛错，宿主回滚配置，旧平台继续服务。
