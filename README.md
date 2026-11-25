# mcsup-chat-bridge

MCSUP 聊天桥插件：订阅 Minecraft 服务器的聊天、控制台与生命周期事件，归一化为统一消息模型，分类后分发到可插拔的聊天平台。

架构分两层：平台无关内核（采集 → 归一化 → 分类 → 入库 → 分发）与可插拔平台适配器。内置 **QQ 官方机器人（API v2）**、**Telegram 机器人（Bot API 长轮询）**、**Discord 机器人（Bot Gateway + REST）**、**微信机器人（腾讯 iLink 长轮询）**、`log`、`null` 六种适配器。

QQ、Telegram、Discord 与微信适配器支持**双向互通**：

- 游戏 → 平台：玩家聊天按 `[玩家名]:消息` 发送到群/私聊；
- 平台 → 游戏：群聊消息（可选私聊）经 `console:write` 注入游戏，显示为 `[QQ] 昵称: 消息` / `[Telegram] 昵称: 消息` / `[Discord] 昵称: 消息` / `[微信] 微信用户-xxxxxx: 消息`；注入方式由 `injectMode` 决定（默认 `say` 会写进服务器日志，`tellraw` 只显示在游戏内）。
- QQ / Telegram / Discord 支持群聊与私聊**互相同步**（`qq.syncChannels` / `telegram.syncChannels` / `discord.syncChannels`）；Telegram 复用 `file_id` 直接转发图片/视频/文件，Discord 用图片 URL 作为 embed 立即镜像。微信官方客户端只建模单聊，因此不提供群/私聊镜像。
- **私聊同步**：顶层 `privateSync`（默认 `false`）一次决定所有已选平台是否接收私聊，安装向导里问一次；开启后私聊会参与注入游戏、群/私聊镜像与跨平台同步。与各平台的 `allowPrivate` 取并集，关掉它不会覆盖平台里显式打开的配置。
- **跨平台同步**：四个聊天平台默认互相转发（`crossPlatform=true`），群里或私聊收到的消息会发到其它平台的所有会话；转发形如 `[QQ 群] 昵称: 消息`，来源平台不回发自己。图片等媒体不跨平台搬运，只保留 `[图片]` 占位。

## 快速开始

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run test:real
```

一条命令跑完类型检查、单测、构建与真实进程测试：

```powershell
npm run verify
```

### 安装到 MCSUP 宿主

`npm run build` 产出的 `build/` 本身就是安装源：`mcsup-plugin build` 会编译 TypeScript、
生成 `manifest.json` / `descriptor.json` / 启动器，并把运行期依赖（`mcsup-plugin`、`ws`、
`zod`）以**真实目录** vendor 进 `build/node_modules/`。产物里没有符号链接，即使
`mcsup-plugin` 在本仓库是 `file:../mcsup/sdks/typescript`（npm 在 Windows 上会物化成
Junction），安装时也不会踩到宿主的 `denied: symbolic link in artifact`。

```powershell
npm run build
mcsup plugin verify .\build      # 可选：安装前让宿主校验一次
mcsup plugin install --from .\build
```

仓库根目录仍然不能直接当安装源：那里只有 `file:` 链接与 `dist/`，缺 `manifest.json`。

> 产物是 `descriptor schema 4`（安装向导用 `setup.fields[].when` 条件提问），需要
> 支持该 schema 的宿主（`DESCRIPTOR_SCHEMA_VERSION = 4`）。更新宿主后旧的
> `mcsup.exe` 会以 `unsupported descriptor schema 4, host supports 1..=3` 拒绝安装。

安装会一次走完整个向导，装完即用：

1. 列出插件申请的权限（`events` / `storage:kv` / `console:read` / `console:write` / `server:read`），
   问一次 `授予以上权限？[Y/n]`，默认授予；
2. 按插件 `setup` 声明逐项询问配置，字段帮助由插件随 descriptor 提供
   （`setup.fields[].help`，需要支持 descriptor schema 6 的宿主）：
   - 短说明（平台代号、注入方式、私聊开关、入站服务器）用 `inline` 贴在
     控件旁，不单独占行；需要去平台申请的凭据用 `steps` 打印编号步骤和官方链接；
   - `启用的平台` 是多选框：`■`/`□` 表示是否选中，空格切换、回车确认；
   - `游戏内注入方式` 是单选项；`入站服务器` 从已注册服务器中单选（必填），
     还没有服务器时才退回手输；`同步私聊消息` 是**全局开关**（默认「否」），
     选「是」后所有已选平台的私聊都参与注入、镜像与跨平台同步，不再按平台
     分别问；
   - `QQ AppID` / `QQ ClientSecret` / `Telegram Bot Token` / `Discord Bot Token` /
     `微信 Bot Token` **按平台条件提问**：
     平台里选了 `qq` 才会问前两项，选了 `telegram` 才会问 Bot Token，选了 `discord`
     才会问 Discord Bot Token，选了 `weixin` 才会问微信 Bot Token，没选的平台一个都不问
     （`setup.fields[].when`，需要支持 descriptor schema 4 的宿主）；被问到时都是必填，
     留空会提示后重新提问。微信 token 不能从后台复制：宿主支持 descriptor schema 5 时
     **安装向导会直接拉起插件完成扫码**（`setup.fields[].interactive`），二维码经
     `MCSUP_SETUP_UI_FILE` 交给宿主按终端宽度居中渲染；扫码后 token 经 0600 临时文件
     回传，不用手工复制。服务端建议的 iLink 基址（`weixin.apiBase`）**不是提问项**：
     它写在 config schema 里，由同一次扫码自动回填；扫码没给时适配器用默认地址。旧宿主
     会退回单 token 回传与插件自绘二维码，可先运行 `node scripts/weixin-login.mjs` 扫码再粘贴；
   - 输入框**不会预填旧值**：留空即沿用，密钥每输入一个字符显示一个 `*`；
   - 必填项没有旧值可沿用时不能回车跳过，会提示后重新提问（`Ctrl+C` 取消）；
3. 群 / 私聊 id **不用填**：留空即全部（入站不限会话，出站发给收到过消息的
   会话，记在宿主 `storage:kv` 里，插件重启后仍然有效）。需要限制范围时再用
   `qq.groups` / `qq.privateUsers`，或 `telegram.groups` / `telegram.privateUsers`、
   `discord.groups` / `discord.privateUsers` 收窄；
4. 写配置后自动启用并启动，成功后直接显示「已安装并启动」。
5. 插件跟随服务器启停：`inboundServer`（以及可选的 `qq.server` / `telegram.server` /
   `discord.server` / `weixin.server`）
   选中的服务器启动前先启动插件，停止后插件随之停止（多台服务器共用同一个插件时，
   最后一台停止才停），日常只需 `mcsup server start / stop`。

脚本或 CI 用 `--yes` 视为同意能力授权；`--no-setup` 跳过整个向导，
回到旧行为（装完需手动 `grant` / `config set` / `enable` / `start`）。

`npm run test:real` 会校验 `build/node_modules/` 里确实有 `mcsup-plugin`、`ws`、`zod`，
产物一旦退回「只编译、不 vendor」的状态就会直接失败，避免装到一半才发现解析不到依赖。

> 依赖 `mcsup-plugin@0.1.0`，通过 `file:../mcsup/sdks/typescript` 引用同级的 SDK 仓库。`scripts/ensure-sdk.mjs` 会比较 SDK 源码与 `dist/index.js` 的 mtime：缺失或过期时用 SDK 自带的 tsc 重新构建，已是最新时零开销。

## 目录结构

```
src/
  core/                     平台无关内核
    types.ts                消息模型、类别、来源、查询类型
    ids.ts                  内容摘要 id（sha256 base64url，16 字符）
    classify.ts             聊天 / 控制台行 / 生命周期 / 玩家的分类规则
    store.ts                环形缓存（头指针淘汰 + 文本截断）、去重、seq 游标分页
    dispatcher.ts           每平台固定大小环形队列 + 串行消费者 + 故障隔离
    bridge.ts               内核编排：启动、配置热更新、采集、入站注入、回声抑制
  platform-kit/             适配器契约与公共件（与具体平台无关）
    types.ts                ChatPlatform / PlatformFactory / GamePort / 入站消息契约
    registry.ts             注册表（id 校验、实例化）
    format.ts               出站文本格式（`[玩家名]:消息`）与按码点分片
    shared/                 适配器共用件：取值解析、退避等待、出站目标册与队列
  platforms/                平台适配器（每个文件一个平台）
    qq.ts                   QQ 官方机器人 API v2（WebSocket Gateway + OpenAPI，双向）
    telegram.ts             Telegram Bot API（getUpdates 长轮询 + REST，双向、群私聊同步）
    discord.ts              Discord Bot Gateway（WebSocket + REST v10，双向、频道私聊同步）
    weixin.ts               微信机器人（腾讯 iLink getUpdates 长轮询 + sendMessage，单聊双向）
    log.ts                  占位平台：写到插件日志
    null.ts                 空平台：只采集、不投递
  builtin-platforms.ts      内置适配器目录（组合根：BUILTIN_PLATFORMS + createRegistry）
  events/normalize.ts       宿主事件校验（zod）与归一化
  config.ts                 配置 schema（含 QQ / Telegram / Discord / 微信与密钥字段）、resolveConfig
  ops/index.ts              messages（table + 分页）与 status（detail，含入站统计）
  setup/weixin.ts           微信 Bot Token 的交互式安装字段（拉起扫码脚本，token / iLink 基址经临时文件回传）
  index.ts                  definePlugin 接线、能力声明、GamePort（say / tellraw）
scripts/
  ensure-sdk.mjs            SDK 缺失或过期（mtime）时自动构建
  weixin-login.mjs          微信扫码登录：终端显示二维码（或经 UI 文件交给宿主排版），取得 bot token，可 --apply 写入配置
  bundle-setup.mjs          构建后把扫码脚本与 lib/qr.mjs 复制进 build/setup/
  lib/qr.mjs                零依赖二维码编码与终端渲染（Byte 模式、等级 L）
  real-host-check.mjs       真实子进程 + 真实 TCP 假宿主 + 真实 QQ 官方协议（REST + Gateway）
test/                       分类、存储、分发、桥、入站、QQ、Telegram、Discord、微信、二维码、配置、事件、MockHost
```

构建产物在 `build/`：`manifest.json`、`descriptor.json`、`bin/run.cmd|run.sh`、`bin/entry.mjs`、`dist/`、`setup/`（扫码登录脚本）、`node_modules/`（vendor 的运行期依赖）。整个目录可直接 `mcsup plugin install --from`。

## 消息模型

每条消息归一化为：

| 字段 | 说明 |
| --- | --- |
| `id` | 内容摘要，用于去重 |
| `seq` | 入库顺序号，游标分页使用；只对真正入库的消息递增 |
| `category` | 见下表 |
| `source` | `chat` / `console` / `event` |
| `server` | 服务器名；缺失时为 `unknown` |
| `at` | RFC3339 UTC |
| `from` | 发送者或玩家名；无则为 `null`（op 输出为 `""`） |
| `text` | 清理颜色码/控制字符后的文本；入库截断到 1000 字符 |
| `raw` | 原始聊天文本或控制台整行；入库截断到 4000 字符；生命周期事件为 `null` |
| `rule` | 命中的规则 id，便于观测与调试 |

`server`、`from`、`rule` 各自最多保留 64 字符。去重使用截断前的原文，截断只影响存储与分页输出。

类别（`category`）：

| 类别 | 来源示例 |
| --- | --- |
| `chat` | 玩家聊天（`chat:message`） |
| `command` | 聊天以 `/` 开头，或 `Steve issued server command: ...` |
| `join` / `leave` | `player:joined` / `player:left` |
| `system` | 服务器状态行（启动、保存、完成加载等）与 INFO 兜底 |
| `warning` | 控制台 WARN / WARNING |
| `error` | ERROR / FATAL / SEVERE，以及异常栈 |
| `death` | 死亡消息（原版常见句式） |
| `advancement` | 进度、挑战、目标 |
| `other` | 未归类的控制台行（如 DEBUG） |

分类顺序：先处理控制台里的聊天投影（`<name> text`，含离线模式的 `[Not Secure]` 前缀）与玩家加入 / 离开，再按日志级别、异常栈、命令、进度、死亡、系统行、INFO 兜底、`other` 判定。

**为什么聊天要跨源去重**：在线模式下宿主会把同一条聊天同时投递为 `chat:message` 与 `console:line`；离线模式（`online-mode=false`）下宿主只留控制台行（带 `[Not Secure]`），结构化事件可能不来。因此控制台聊天行**不再直接丢弃**，而是按 `(发言人, 文本)` 与结构化事件做 3 秒跨源去重：两种投递顺序下都只保留一条，计入 `status.duplicates`。玩家自己连发两句相同内容不会被误判（同源不参与去重）。

`console:line` 噪音很大（繁忙服务器每秒数百行）。插件必须静态订阅，运行期无法退订；因此**控制台行默认不转发**（`consoleForward=false`，仍采集入库），需要把服务器 `say`、日志同步到平台时再显式打开。`forwardCategories` 默认也只保留玩家聊天 `chat`。

## 配置

配置由 `src/config.ts` 的 zod schema 校验，宿主下发的非法值会在握手阶段以配置错误退出（退出码 3）。

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

```powershell
# 先写平台整块（内部双引号写成 \"，见文首安装说明）
mcsup plugin config set chat-bridge qq '{\"appId\":\"...\",\"clientSecret\":\"...\"}'
mcsup plugin config set chat-bridge telegram '{\"botToken\":\"123456:AA...\"}'
# 再写其余顶层键
mcsup plugin config set chat-bridge platforms '[\"qq\",\"telegram\",\"log\"]'
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

## Ops

### `messages`

最近的归一化消息，最新在前，支持类别 / 来源 / 服务器过滤与游标分页。

输入：`category?`、`source?`、`server?`、`cursor?`、`limit?`（默认 50，最大 200）。

输出：`{ items: [...], next?: string }`。`message` 项不含 `raw`，`from` 为空时是空字符串。

```powershell
# 宿主侧调用示例（伪代码）
messages { "limit": 20 }
messages { "category": "warning", "limit": 20, "cursor": "128" }
messages { "source": "console", "limit": 20 }
messages { "server": "survival", "limit": 20 }
```

分页游标是上一页最后一条的 `seq`；返回 `next` 时把它放进下一次请求的 `cursor`。非法游标按“从最新开始”处理，非法 `limit` 回退到 50。

### `status`

运行统计：

| 字段 | 说明 |
| --- | --- |
| `started` | 桥是否运行 |
| `uptimeSecs` | 运行秒数 |
| `accepted` | 入库成功条数 |
| `duplicates` | 内容摘要重复被丢弃条数 |
| `skipped` | 空行、结构化重复投影、未知事件等 |
| `filtered` | 已入库但按配置不转发的条数 |
| `suppressed` | 注入游戏后又被宿主回显、被回声抑制的条数 |
| `stored` | 当前缓存条数 |
| `categories` | 各类别累计计数（不受环形淘汰影响） |
| `platforms` | 每个平台的 `queued` / `delivered` / `failed` / `dropped`，以及跨平台转发的 `relayed` / `relayFailed` / `relayDropped` |
| `inbound` | `received` / `delivered` / `dropped` / `duplicates` / `failed`，以及 `relayed`（成功转给至少一个其它平台的条数） |

## QQ 机器人对接

本项目对接的是 **QQ 开放平台官方机器人 API v2**（`bot.q.qq.com`），不是 OneBot 社区实现。

### 前置条件

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

### 协议链路

- **访问凭证**：`POST https://bots.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}`，返回 `{access_token, expires_in}`；随后所有 OpenAPI 请求带 `Authorization: QQBot <access_token>`。
- **事件**：`GET {apiBase}/gateway` 取 wss 地址，连上后等待 op 10 Hello，再发 op 2 Identify（`token: "QQBot <token>"` + `intents` + `shard`）。断线优先 op 6 Resume；会话失效才重新 Identify。
- **发送**：`POST /v2/groups/{group_openid}/messages` 或 `/v2/users/{user_openid}/messages`，`msg_type=0` 纯文本、`2` Markdown。
- **被动回复**：记录每个会话最近一条入站消息的 `msg_id`，出站时带 `msg_id + 递增 msg_seq`。额度用尽或窗口过期才降级为主动消息。

### 消息格式

| 方向 | 格式 | 说明 |
| --- | --- | --- |
| 游戏 → QQ | `[玩家名]:消息` | 玩家聊天严格使用此格式，例如 `[Steve]:你好` |
| 游戏 → QQ（非聊天） | `[加入] Alex: Alex 加入了游戏` | 用中文类别标签，避免歧义 |
| QQ → 游戏 | `[QQ] 昵称: 消息` | 通过 `injectMode` 注入（默认 `say`，游戏内会多出 `[Server]` 前缀；改成 `tellraw` 则只有单标签）；可选 `qq.server` / `inboundServer` |
| QQ → 其它平台 | `[QQ 群] 昵称: 消息` / `[QQ 私聊] 昵称: 消息` | 跨平台同步（`crossPlatform`），发到 Telegram 的所有会话；只转发文本，图片等媒体保留 `[图片]` 占位，不回发来源平台 |

出站只发送纯文本（或显式开启的 Markdown），不拼任何平台标记；入站会把 `<@openid>` 映射成昵称、去掉机器人自身的 @，附件转为 `[图片]` / `[语音] ASR` / `[文件: 名称]` 占位文本。

### 可靠性行为

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

### 官方频控（不可绕过）

- 主动消息：群 bot 维度 60 条/分钟、单关系 20 条/分钟、每群 1000 条/天；单聊 20 条/分钟、1000 条/天/用户。
- 被动回复：单聊 60 分钟内 4 次、群聊 5 次、群管理员 50 次，且必须带 60 分钟内的 `msg_id`。

因此适配器默认优先被动回复，并把 `sendIntervalMs` 当保护值；高频服务器建议只转发 `chat` / `join` / `leave` / `death` 等关键类别。

### 本地验证

没有真实 QQ 凭证时，`npm run test:real` 会启动一个真实的 **HTTP OpenAPI + WebSocket Gateway** 假服务端，并验证：

- `AppID/ClientSecret` 换 token，Identify 的 `token` 为 `QQBot <access_token>`、默认 intents 为 `group_and_c2c`；
- 游戏事件 → `POST /v2/groups/<openid>/messages`，`msg_type=0`、文本为 `[Steve]:有人吗`、带 `msg_seq`；
- QQ 群消息事件 → 宿主 `console:write/send_line`，命令为默认注入方式
  `say [QQ] 小A: 来自QQ`；把 `injectMode` 热更新成 `tellraw` 后再来一条，命令变成
  `tellraw @a {"text":"[QQ] 小A: 切换注入方式"}`；
- 非白名单群与重复消息 id 不会二次注入；
- `status.inbound` 计数正确，进程最终以退出码 0 结束。

真实联调只需把 `qq.appId` / `qq.clientSecret` / `qq.groups` 换成机器人的实际配置。

## Telegram 机器人对接

本项目对接的是 **Telegram Bot API**（`api.telegram.org`），走 **`getUpdates` 长轮询**
而不是 webhook：插件运行在宿主沙箱里，没有公网入口，长轮询是唯一不需要暴露端口的
方案。offset 持久化在宿主 `storage:kv`（键 `telegram:offset`），重启不会重复收取
已经确认过的 update。

### 前置条件

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

### 协议链路

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

### 消息格式

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

### 可靠性行为

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

### 已知限制

- 单条消息上限 **4096** 字符（按 UTF-16 计长，适配器不会切断 emoji 代理对），
  caption 上限 1024 字符；默认 `maxLength=3500` 留出余量。
- 公开 Bot API 的 `getFile` 下载上限 **20 MB**；本适配器只复用 `file_id` 转发，
  不下载文件，因此不受该限制影响，但 `file_id` 只对**同一个 bot** 有效。
- 不订阅频道（`channel_post`）与编辑消息；需要时扩展 `allowed_updates` 即可，但要
  同时调整去重键，否则编辑后的消息会被当成重复丢弃。
- 长轮询意味着**一个 bot 只能有一个插件实例**消费更新；同一 token 配到两台宿主会
  互相抢消息（409 冲突，双方轮流 `deleteWebhook` 并重试）。

### 排障：消息只走一边

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

### 本地验证

`test/telegram.test.ts` 用真实的 HTTP 假 Bot API（含长轮询挂起 / 唤醒）覆盖：配置
解析、`getMe` 校验、入站归一化与白名单、learned targets、HTML 转义与分片、
群/私聊镜像、媒体 `file_id`、论坛话题、429 重试、offset 持久化与重启、401 停止、
409 `deleteWebhook`、停止后不再发送。真实联调只需把 `telegram.botToken` 换成
@BotFather 发放的 token，并把机器人拉进群。

## Discord 机器人对接

本项目对接 Discord **Bot Gateway（WebSocket）+ REST API v10**。插件运行在宿主沙箱里，
没有公网入口，因此不配置 Interactions Endpoint，只建立**出站** Gateway 连接。

### 前置条件

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

### 协议链路

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

### 消息格式

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

### 可靠性行为

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

### 已知限制

- 必须开启 **Message Content Intent**，否则收不到正文（Gateway 4014）。
- 单条正文上限 **2000** 字符，默认 `maxLength=1900` 留出余量；不做 Markdown 转义，
  但在 `allowed_mentions` 里禁用了 @ 解析。
- 附件 URL 是带签名的临期地址，只适合「收到后立即镜像」；不回传、不转存，跨平台也不搬运媒体。
- 私聊受 Discord 的「共同服务器 / 用户先私聊」限制；对陌生用户主动发 DM 可能 403。
- 当前只支持单分片；机器人规模超出单分片（Gateway 返回 4010/4011）时直接停止并说明原因。
- 帖子（thread）按普通频道 id 处理；已归档帖子或权限不足会发送失败，需要先在 Discord 里放开权限。
- 不订阅编辑 / 删除事件，也不实现 Slash Command；需要时在 Gateway 事件与去重键上单独扩展。

### 本地验证

`test/discord.test.ts` 用真实的 HTTP 假 REST + WebSocket 假 Gateway 覆盖：配置解析、
Identify（默认 intents）、频道/私聊入站与白名单、learned targets、私聊 user id →
DM channel 缓存、分片、频道/私聊镜像与图片 embed、跨平台 `relay`、429 重试、401 停止、
关闭码 4009 重新 Identify / 4000 Resume / 4014 致命提示。真实联调只需把
`discord.botToken` 换成 Developer Portal 的 token，打开 Message Content Intent 并把
机器人拉进服务器。

## 微信机器人对接

本项目对接**腾讯官方微信机器人（iLink Bot API）**：`getUpdates` 长轮询收取消息，
`sendMessage` 发送文本。它与 Telegram 同构，插件运行在宿主沙箱里，不需要公网回调地址，
也不走企业微信群 webhook 或公众号那套必须暴露 URL 的方案。

### 前置条件

1. 安装时选上 `weixin`，向导问「微信 Bot Token」时会直接启动插件扫码登录：
   终端画出二维码，用手机微信扫码；token 由脚本写进 0600 临时文件回传，
   不要求手工复制（宿主需支持 descriptor schema 5 的 `setup.fields[].interactive`）。
2. 旧宿主或不走安装向导时，手工运行扫码脚本，终端同样会直接把二维码画出来：

   ```powershell
   node scripts/weixin-login.mjs
   ```

   二维码由 `scripts/lib/qr.mjs` 零依赖生成，黑字白底并保留 4 个模块的静默区；
   链接也会同时打印，终端显示不了块字符时加 `--plain` 只看链接。脚本按腾讯的
   iLink 登录流程处理 `wait` / `scaned` / `confirmed` / `expired` /
   `scaned_but_redirect`，需要 PIN 时会提示输入手机微信显示的数字。成功后**只打印一次**
   bot token。
3. 把 token 写入配置。可以重跑脚本并加 `--apply` 自动完成（写入 `weixin.botToken`、
   把 `weixin` 并入 `platforms`、重启插件），也可以手工：

   ```powershell
   mcsup plugin config set chat-bridge weixin.botToken --secret   # 粘贴 token
   mcsup plugin config set chat-bridge platforms '["weixin", ...]'
   mcsup plugin restart chat-bridge
   ```

4. 扫码的微信号本身只对应一个机器人会话；`privateUsers` 不用手填，对方先给机器人发一条
   消息就会记下目标（写进宿主 `storage:kv` 的 `weixin:targets`，重启不丢）。
5. 微信官方客户端把机器人会话固定建模为单聊（`ChatType: "direct"`），因此本项目只支持
   单聊：不提供 `groups` / `syncChannels` / `forwardMedia`，避免把一对一会话互相镜像。

### 协议链路

- **鉴权**：请求头 `AuthorizationType: ilink_bot_token` + `Authorization: Bearer <token>`，
  另带随机 `X-WECHAT-UIN`、`iLink-App-Id: bot` 与 `iLink-App-ClientVersion`。日志不打印
  token 与完整请求头。
- **`base_info`**：每个 POST 都带 `channel_version` 与 `bot_agent`。服务端要求
  `channel_version` 前三段是 `3.x.x`，本项目写成 `3.0.1/mcsup-chat-bridge-<版本>`；
  `bot_agent` 为 `mcsup-chat-bridge/<版本>`。
- **入站**：`POST /ilink/bot/getupdates`，请求体带上次返回的 `get_updates_buf`；服务端
  有新消息或长轮询超时后返回 `msgs` 与新的游标。游标持久化到 `storage:kv`（键
  `weixin:sync`），重启后不重复收取旧消息。客户端超时按正常控制流处理。
- **出站**：`POST /ilink/bot/sendmessage`，正文放在 `msg.item_list[0].text_item.text`；
  入站消息带 `context_token` 时必须原样回传。令牌按会话持久化（键 `weixin:context`，
  不是账号凭据）；服务端返回 `ret=-2` 时清掉令牌重试一次。
- **生命周期**：启动时 `POST /ilink/bot/msg/notifystart`、停止时 `msg/notifystop`；
  失败只记调试日志，不阻塞启停。
- **token 失效**：`ret` / `errcode` 为 `-14` 时暂停收发 60 分钟（与官方客户端一致），
  避免把失效 token 打成重试风暴；持续失效需重新扫码并更新 `weixin.botToken`。

### 消息格式

| 方向 | 格式 | 说明 |
| --- | --- | --- |
| 游戏 → 微信 | `[玩家名]:消息` | 玩家聊天严格使用此格式 |
| 游戏 → 微信（非聊天） | `[加入] Alex: Alex 加入了游戏` | 用中文类别标签 |
| 微信 → 游戏 | `[微信] 微信用户-xxxxxx: 消息` | 协议没有昵称字段，显示名由对方的 `from_user_id` 派生成稳定短别名（SHA-256 前 6 位十六进制），不会把完整 openid 写进聊天 |
| 微信 → 其它平台 | `[微信 私聊] 微信用户-xxxxxx: 消息` | 跨平台同步（`crossPlatform`），发到 QQ / Telegram / Discord 的所有会话；不回发来源平台 |

入站把 `item_list` 归一为文本：`type=1` 取 `text_item.text`；`type=3` 优先用
`voice_item.text`（语音转写），没有转写时保留 `[语音]`；图片 / 视频 / 文件分别转为
`[图片]` / `[视频]` / `[文件: 名称]`。媒体不下载也不上传：CDN 内容是 AES 加密的，
跨平台句柄也不通用。

### 可靠性行为

- **鉴权错误**：401/403 停止重连并提示重新扫码；404 视为 `weixin.apiBase` 配错。
- **重连**：指数退避 + 抖动（`reconnectMinMs` / `reconnectMaxMs`），
  `reconnectMaxAttempts=0` 表示无限重试；连续失败达到 3 次后拉长到 30 秒。
- **限流与重试**：两次 iLink 调用之间至少 `sendIntervalMs`；5xx 与网络错误退避重试，
  单条消息最多 3 次；`ret=-2` 只清 `context_token` 重试一次。
- **去重**：`message_id` / `msg_id` / `svr_id` 是 uint64，直接 `JSON.parse` 会落到
  double 精度、相邻 id 可能相同。适配器在解析前给这三类**对象键**的数字字面量加引号，
  保留完整精度；再按最近 1000 条去重，桥内核再按 `platform:id` 兜一层。
- **过滤**：`weixin.allowedUsers` 收窄发言人，`weixin.privateUsers` 收窄私聊对象；
  被丢弃时按发送者告警一次并打印可填进配置的 user_id。
- **跨平台同步**：`crossPlatform=true`（默认）时，微信收到的消息会以
  `[微信 私聊] 微信用户-xxxxxx: 消息` 发给其它平台的全部会话；转发走适配器自己的
  出站队列，不回流 `ctx.inbound`，因此不会成环。

### 已知限制

- **token 只能扫码取得**：腾讯没有后台复制入口，插件也不把密钥落盘，所以首次使用必须
  先跑 `scripts/weixin-login.mjs`；token 丢失后要重新扫码（必要时先在手机微信解除旧绑定）。
- **扫码后无法获取 token 的情况**：服务端返回 `binded_redirect` 表示该微信号已绑定过
  另一个客户端，不会再签发 token；脚本会直接说明原因。
- 官方客户端只建模单聊，本项目不假设微信群机器人会话存在；群聊需要腾讯后续开放协议。
- 协议不提供发言人昵称，也不提供用户资料或通讯录接口；游戏内显示的是由 `from_user_id`
  派生的稳定短别名 `微信用户-xxxxxx`。同一个 id 跨重启不变，但别名不是真实昵称；需要
  真实姓名只能另行人工绑定（当前不提供）。
- 媒体只有占位：不解密 CDN 内容，也不跨平台搬运图片 / 语音 / 文件。

### 本地验证

`test/weixin.test.ts` 用真实的 HTTP 假 iLink 服务覆盖：配置解析、uint64 消息 id 保精度、
文本/语音/媒体归一化、单聊入站与白名单、learned targets、`get_updates_buf` 游标持久化、
`context_token` 回传与 `ret=-2` 重试、分片、5xx 重试、`-14` 暂停、`relay` 跨平台转发与
启停通知。真实联调只需按上面的前置条件扫码取得 token。

## 扩展一个新的聊天平台

只需要「配置 + 一个文件 + 注册一行 + 测试」，内核与 op 层都不用改。QQ、Telegram、
Discord 与微信已内置，可直接参照 `src/platforms/qq.ts` / `src/platforms/telegram.ts` /
`src/platforms/discord.ts` / `src/platforms/weixin.ts`；适配器目录只放平台实现，契约与公共件在
`src/platform-kit/`。完整清单（含配置、共享件、测试与自查）见
[`docs/adding-a-platform.md`](docs/adding-a-platform.md)。

### 1. 实现 `PlatformFactory`

下面用一个假想的 `matrix` 说明骨架。出站目标解析、队列、积压上限与失败计数
全部复用 `platform-kit/shared/outbound.ts`，适配器只提供「怎么发」：

```ts
// src/platforms/matrix.ts
import { LearnedTargets } from "../core/targets.js";
import { formatOutbound, formatRelay } from "../platform-kit/format.js";
import { OutboundQueue, TargetBook } from "../platform-kit/shared/outbound.js";
import type { NormalizedMessage } from "../core/types.js";
import type { ChatPlatform, PlatformFactory } from "../platform-kit/types.js";

const OUTBOUND_LIMIT = 512;

export const matrixPlatformFactory: PlatformFactory = {
  id: "matrix",
  title: "Matrix",
  description: "Matrix 客户端 API",
  create({ log, settings, kv, private: privateSync = false }) {
    const config = parseMatrixSettings(settings); // 缺凭据抛 PluginError("invalid_input")
    const learned = new LearnedTargets({ key: "matrix:targets", log, kv, limit: 64 });
    const targets = new TargetBook({
      label: "matrix", log, learned,
      groups: config.groups, users: config.privateUsers,
      syncChannels: config.syncChannels,
      noTargetHint: "收到消息后自动补齐",
      noMirrorHint: "在群里发一条消息，或把 matrix.groups 填成群 id",
    });
    const outbound = new OutboundQueue<{ id: string; text: string }>({
      label: "matrix", title: "Matrix", limit: OUTBOUND_LIMIT, log, targets,
      isStopping: () => stopping,
      send: (target, pending) => sendText(target, pending.text),
    });
    let stopping = false;
    return {
      id: "matrix",
      title: "Matrix",
      start(ctx) {
        if (ctx.signal.aborted) return;
        ctx.signal.addEventListener("abort", () => {
          stopping = true;
          outbound.clear();
        });
        // 建立连接；收到外部消息时调用 ctx.inbound({ platform, channel, author, text })
      },
      deliver(message: NormalizedMessage) {
        outbound.push({ id: message.id, text: formatOutbound(message) });
      },
      // 可选：实现 relay 就参与跨平台同步；只入自己的队列，禁止回流 ctx.inbound
      relay(message) {
        outbound.push({ id: `relay:${message.platform}`, text: formatRelay(message) });
      },
      stop(reason) {
        stopping = true;
        outbound.clear();
        log.debug(`[matrix] 断开：${reason}`);
      },
    } satisfies ChatPlatform;
  },
};
```

### 2. 注册

```ts
// src/builtin-platforms.ts
import { matrixPlatformFactory } from "./platforms/matrix.js";

export const BUILTIN_PLATFORMS: readonly PlatformFactory[] = [
  discordPlatformFactory,
  logPlatformFactory,
  nullPlatformFactory,
  qqPlatformFactory,
  telegramPlatformFactory,
  matrixPlatformFactory,
];
```

### 3. 加配置字段

```ts
// src/config.ts，configSchema 内
matrix: s.optional(
  s.object(
    {
      token: secretInput(s.string({ label: "Access Token", max: 512 })),
      roomId: s.string({ label: "默认房间", max: 128 }),
    },
    { label: "Matrix" },
  ),
),
```

之后配置 `"platforms": ["matrix"]` 就会实例化；`config.matrix` 这个片段会原样传给工厂的 `settings`（schema 内的默认值已由 zod 补齐）。

### 4. 加测试

```ts
// test/matrix.test.ts
import { expectPlatformContract } from "./helpers/platform-contract.js";

it("满足平台最小契约", async () => {
  await expectPlatformContract(matrixPlatformFactory, { settings: { token: "t", roomId: "r" } });
});
```

协议收发行为按 QQ / Telegram / Discord / 微信 的用例写：配置解析、目标（配置与学习）、
入站白名单、`inbound=false` 只同步不注入、`relay` 不回流。

### 适配器约定

- `deliver` 由内核串行调用，不会并发；慢只影响自己的队列。
- 队列满时内核丢最旧消息并计入 `dropped`，适配器不需要处理背压。
- `deliver` 抛错只计入 `failed` 并记日志，不会打断消费者，也不影响其他平台。
- 连接、重连、限流、鉴权都由适配器自己负责；内核只提供 `AbortSignal` 与 `stop(reason)`。
- **入站**：适配器收到外部消息后调用 `ctx.inbound({ platform, channel, author, text, messageId?, inject? })`；
  内核统一做去重、长度限制、排队、回声抑制，并通过 `ctx.game` 注入游戏。
  平台自己的 `inbound=false` 设成 `inject: false`，只停注入，消息仍参与跨平台同步；
  适配器不需要知道服务器选择、注入命令或队列细节。
- **跨平台**：适配器可选地实现 `relay(message)`，内核会把「其它平台」收到的消息
  投给它；不实现就永远收不到转发（`log` / `null` 如此）。判断依据是「有没有这个
  方法」，不是平台 id，新平台无需改内核。`relay` 只把已格式化的文本发进自己的
  出站队列，禁止回流 `ctx.inbound`，否则会成环；来源平台由内核排除，媒体不跨平台
  搬运。
- **降级**：`ctx.game` 在未授予 `console:write` 时为 `undefined`；适配器只负责上报消息，
  内核会记录失败计数，不要求适配器自己判断权限。
- **私聊**：`PlatformCreateOptions.private` 是内核下发的全局 `privateSync`，适配器
  用「自己的 `allowPrivate` 或它」决定是否接收私聊（取并集，不要覆盖平台显式配置）。
  打开后私聊和群聊走同一条入站链路，无需额外分支。
- 平台 id 必须匹配 `^[a-z][a-z0-9-]{0,31}$`，且与 `create()` 返回实例的 `id` 一致。

## 运行保证与边界

- **不持久化消息**：只保留最近 `storeSize` 条；进程重启即丢失。**插件配置与密钥由宿主持久化并按插件隔离**，聊天桥不落盘。
- **内存有界**：分发队列是固定大小环形缓冲（丢最旧 O(1)，慢消费者不会让数组增长）；入站队列同样有界；入库文本/原始行分别截断到 1000/4000 字符，超长控制台行不会撑爆缓存或结果帧。
- **事件是触发语义**：宿主不补发，断线期间的消息不会回填。
- **单平台保序**：同一平台内严格按入库顺序投递；入站注入也串行，保证游戏内顺序稳定。
- **平台间隔离**：一个平台慢或抛错不影响采集与其他平台。
- **停止**：先排空队列，再 abort 信号并调用 `stop`；排空与 `stop` 各有默认 3 秒上限，超时记 warn。
- **去重**：同内容摘要只入库一次；入站按平台消息 id 去重并保留 10 分钟；注入文本回流会被回声抑制。
- **配置回滚**：平台配置变更失败时保留旧平台，不会出现“两边都没有”的空窗。
- **能力降级**：未授予 `console:write` 时出站正常、入站计数为失败，不伪造成功。

## 测试

```powershell
npm run typecheck   # 源码 + 测试的类型检查
npm test            # 单测 + MockHost 全链路（无 socket）
npm run build       # 生成 build/manifest.json、descriptor.json、启动器
npm run test:real   # 真实进程 + 真实 TCP 端点
```

单测覆盖：

- 分类规则（聊天、颜色码、控制台级别、异常栈、命令、死亡、进度、系统行、空行）
- 环形缓存、去重、游标分页、容量淘汰、过滤、超长文本截断、持续大量写入
- 固定环队列、单平台保序、平台隔离、持续溢出丢最旧、平台启动失败回滚、停止排空
- 桥的启动/停止/配置热更新/启动前配置/平台切换/过滤配置不重建/未知平台回滚
- 配置默认值、去重、平台配置切片、QQ / Telegram / Discord / 微信配置片段与入站默认值、注册表重复与非法 id
- 事件负载校验、非法时间回退、缺失服务器名兜底
- **入站**：格式化注入、`inboundServer`、去重、截断、全局关闭、无 `console:write` 降级、回声抑制
- **跨平台同步**：转发目标选择（排除来源平台、只投给实现 `relay` 的平台）、
  `crossPlatform` 开关、入站与跨平台两条边互相独立、无接收方时不计 `relayed`、
  转发队列溢出与失败计数
- **QQ**：配置校验与默认值、`[玩家名]:消息` 格式、官方入站事件归一（@ 映射/附件/引用）、
  假 Gateway 上的 Identify、被动回复 `msg_id+msg_seq`、白名单、去重、Markdown、401 刷新 token、分片与关闭码处理
- **Telegram**：配置校验与默认值、假 Bot API 长轮询（挂起 / 唤醒 / offset 前进）、
  `getMe` 校验、入站归一化与媒体占位、群/发言人白名单、learned targets、HTML 转义与
  UTF-16 安全分片、群/私聊镜像、媒体 `file_id`、论坛话题、429 `retry_after` 重试、
  offset 持久化与重启、401 停止重连、409 自动 `deleteWebhook`、停止后不再发送
- **Discord**：配置校验与默认值、假 REST + Gateway 的 Identify（默认 intents）、
  频道/私聊入站、`guilds` / `groups` / `allowedUsers` 白名单、learned targets、
  私聊 user id → DM channel 缓存、分片、频道/私聊镜像与图片 embed、跨平台 `relay`、
  429 `retry_after` 重试、401 停止、关闭码 4009 重新 Identify / 4000 Resume / 4014 致命
- **微信**：配置校验与默认值、假 iLink 长轮询（挂起 / 唤醒 / 游标前进）、uint64 消息 id
  保精度、文本/语音转写/媒体占位归一化、单聊入站与白名单、learned targets、
  `context_token` 回传与 `ret=-2` 重试、分片、5xx 重试、`-14` 暂停 60 分钟、
  跨平台 `relay`、启停通知
- **出站目标持久化**：跨实例读回群/私聊目标、重复会话不重复写盘、无 `storage:kv` 时退化、
  记录损坏按空处理、超上限淘汰、写入失败只告警一次；适配器侧覆盖「重启后仍镜像到记下的群」
  「首条群消息写回 KV」「无群目标时告警一次」
- MockHost：握手声明、事件 → 分类 → 入库 → 查询、配置热更新、非法配置回滚、未知平台退出码

`test:real` 不是纯单元测试：它会启动构建产物 `build/bin/run.cmd`（Windows）或 `run.sh`，作为真实子进程连接本机 TCP 假宿主，走完整线上协议；同时启动一个真实的 QQ 官方协议假服务端（HTTP OpenAPI + WebSocket Gateway）：

1. 插件发 `hello`，断言 `plugin_id`、五项能力（含 `storage:kv` / `console:write` / `server:read`）与订阅
2. 宿主回 `welcome`，下发三平台配置（`log` + `null` + `qq`）与限额；QQ 指向假 OpenAPI
3. QQ 适配器用 AppID/ClientSecret 换 token，完成 Identify（`QQBot <token>` + `group_and_c2c`）
4. 投递 14 条事件（聊天、命令、加入/离开、控制台警告/错误/系统行、死亡、进度、服务器启动/就绪/崩溃）
5. 调用 `messages` 验证游标分页、类别过滤、source / server 过滤、8 种类别与去重/去色
6. 调用 `status` 验证采集、跳过、分类与三个平台的投递计数
7. 断言 OpenAPI 收到 `POST /v2/groups/123456/messages`，`msg_type=0`、文本为 `[Steve]:有人吗`
8. 推送 `GROUP_AT_MESSAGE_CREATE`，断言宿主收到 `console:write/send_line`
   `say [QQ] 小A: 来自QQ`（默认注入方式）；非白名单群与重复消息 id 不注入
9. 下发 `config` 验证热更新只影响转发，三平台计数一致；同时把 `injectMode` 切成
   `tellraw`，断言下一条入站变成 `tellraw @a {"text":"[QQ] 小A: 切换注入方式"}`
10. `ping` / `pong`，检查日志平台的真实 stderr 输出
11. 断言插件只调用了已声明的宿主方法（假宿主的返回形状按真宿主 `api.rs` 给，
   写能力回 `{ok:true}`，读能力回文档结构），漂移即失败
12. `shutdown`，断言退出码 0

说明：本机没有可启动的 Minecraft 服务器与真实 MCSUP 宿主，也没有真实 QQ 凭证，所以对端是“假宿主 + 假 QQ 开放平台”，但它们跑的是真实帧协议、真实进程、真实 socket、真实 HTTP 与真实 WebSocket 握手；插件侧的分类、分发、QQ 协议与入站注入逻辑没有被 mock。

Windows 启动器经 `cmd.exe /d /s /c` 调用，并使用 `windowsVerbatimArguments`：Node 默认会给含空格的参数加引号并把内部引号转义成 `\"`，而 `cmd.exe` 不认反斜杠转义，会直接报“不是内部或外部命令”。测试脚本里对“等待连接”设了 10 秒超时，启动失败时会打印插件 stderr 而不是无限挂起。

## 调研

`docs/chat-platform-research.md` 对比了 OpenClaw 与 Hermes Agent 接入聊天平台的核心实现（契约、生命周期、监管/重连、入站归一化、出站与限流），并映射到本项目的 `ChatPlatform`：

- 两套实现都把「连接」当作长驻任务（`startAccount` / `connect`），监管与重连放在框架层。
- 我们当前把监管下放给适配器，只保留 `start / deliver / stop`；接真实平台前建议先补「送达结果 + 平台健康状态」。
- 文档同时记录了代码获取状态：OpenClaw 为本地部分检出，Hermes 为 GitHub API 核心文件快照。

## 已知限制 / 下一步

- 已内置 QQ 官方机器人（API v2）、Telegram Bot API（长轮询）、Discord Bot Gateway（WebSocket + REST v10）与微信机器人（腾讯 iLink 长轮询）。
- 入站只处理文本与常见消息段（图片/语音/文件转为占位文本）；不把媒体内容落盘。Telegram 的群/私聊镜像可直接复用 `file_id` 转发媒体；QQ 需要先转存平台素材库；Discord 只把图片 URL 作为 embed 立即镜像；微信只保留占位（CDN 内容加密）。QQ 不支持回复链与话题线程，Telegram 支持论坛话题（`message_thread_id`）。跨平台（QQ ↔ Telegram ↔ Discord ↔ 微信）只转发文本，媒体句柄不通用，正文保留 `[图片]` 等占位。
- QQ 官方机器人在群聊默认只能收到 @ 消息；全量群消息需在开放平台开通权限，并受官方主动消息频控约束。Telegram 需要在 BotFather 关闭 privacy mode 才能收到群内全部消息。Discord 需要在 Developer Portal 打开 Message Content Intent（否则 Gateway 以 4014 关闭）。微信 token 只能由扫码脚本取得，且官方客户端只建模单聊。
- 与真实 QQ / Telegram / Discord / 微信端联调需要用户提供 QQ AppID/ClientSecret、Telegram bot token、Discord bot token、微信扫码得到的 bot token 与机器人环境；仓库内 QQ 用真实 HTTP + WebSocket 假服务端、Telegram 用真实 HTTP 长轮询假服务端、Discord 用真实 HTTP REST + WebSocket Gateway 假服务端、微信用真实 HTTP iLink 假服务端验证协议链路。
- 插件静态订阅 `console:line`，无法运行期退订；高噪音环境靠 `consoleForward` / `forwardCategories` 控制转发。
- 内存环形缓存，不落盘；需要历史时应由宿主查询或后续接持久化。
- 尚未与真实 MCSUP 宿主 + Minecraft 服务器联调；真实宿主联调放在下一阶段。