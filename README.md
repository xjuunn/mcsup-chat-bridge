# mcsup-chat-bridge

MCSUP 聊天桥插件：把 Minecraft 服务器的聊天、控制台与玩家事件同步到聊天平台，并把平台消息注入游戏。

内置 QQ 官方机器人、Telegram、Discord 与微信四种双向适配器，另提供 `log`（写入插件日志）与 `null`（只采集、不投递）。四个聊天平台之间可以互相同步，群聊与私聊也可按需镜像。

## 功能

- 游戏到平台：玩家聊天按 `[玩家名]:消息` 发送到已启用的平台。
- 平台到游戏：群聊或私聊消息以 `[QQ] 昵称: 消息` 等形式注入服务器。
- 跨平台同步：QQ、Telegram、Discord、微信默认互相同步文本消息。
- 群私聊镜像：各平台内群聊与私聊可以互转，媒体按平台能力转发或保留占位。
- 记录查询：宿主可通过 `messages` 与 `status` 查询最近消息与运行统计。

## 环境要求

- 已安装 MCSUP，宿主支持 descriptor schema 6。
- 已在 MCSUP 中注册至少一台 Minecraft 服务器。
- 从源码构建时需要 Node.js 20 以上。

## 安装

直接从 GitHub Release 安装（无需本地构建）：

```bash
mcsup plugin install --url https://github.com/xjuunn/mcsup-chat-bridge/releases/download/v0.1.0/mcsup-chat-bridge-0.1.0.zip
```

从源码构建并安装：

```bash
npm install
npm run build
mcsup plugin install --from ./build
```

`build/` 是完整安装源，包含 `manifest.json`、`descriptor.json`、启动器与运行期依赖。安装前可用 `mcsup plugin verify ./build` 校验产物。

发布流程：给插件仓库打 `v*` tag（例如 `v0.1.30`，需与 `package.json` 版本一致），GitHub Actions 自动构建并发布 zip 与 `.sha256`。安装器会把 zip 旁的 `.sha256` 作为校验值，也可用 `--sha256` 显式固定。

安装向导依次完成：

1. 列出插件申请的能力，确认一次。`console:write` 用于把平台消息注入游戏，属高风险能力。
2. 多选启用的平台。未选中的平台不会询问凭据。
3. 选择游戏内注入方式、入站服务器与是否同步私聊。
4. 按所选平台填写凭据。微信通过扫码登录，无需手工复制 token。
5. 写入配置后自动启用并启动。

脚本或 CI 可用 `--yes` 跳过确认，或用 `--no-setup` 跳过整个向导并手动配置。

## 使用

插件跟随服务器启停：`inboundServer` 选中的服务器启动前拉起插件，停止后插件随之停止。多台服务器共用同一插件时，最后一台停止才停止。日常只需：

```bash
mcsup server start
mcsup server stop
```

消息方向：

| 方向 | 示例 |
| --- | --- |
| 游戏到平台 | `[Steve]:你好` |
| 平台到游戏 | `[QQ] 昵称: 消息`、`[Telegram] 昵称: 消息` |
| 跨平台 | `[QQ 群] 昵称: 消息` |

群聊与私聊的目标默认自动学习：配置留空表示不限会话，出站发给收到过消息的会话，并持久化在宿主中，重启后仍然有效。需要收窄范围时再填 `groups` / `privateUsers`。

默认只转发玩家聊天，控制台行只入库不转发。需要同步服务器 `say` 或日志时打开 `consoleForward`，或用 `forwardCategories` 追加类别。

## 平台接入

| 平台 | 凭据 | 必须开启的权限 |
| --- | --- | --- |
| QQ | 开放平台 AppID 与 ClientSecret | 读取群内全部消息、主动在群内发言 |
| Telegram | BotFather 的 bot token | 关闭隐私模式，读取群内全部消息、发送消息 |
| Discord | Developer Portal 的 bot token | Message Content Intent、Send Messages、Read Message History、Embed Links、Attach Files |
| 微信 | 安装向导扫码取得 | 无额外权限，仅单聊 |

QQ：在 [QQ 开放平台](https://q.qq.com/open) 创建机器人。群主用最新版手机 QQ 打开群，进入机器人设置，把「机器人可获取的群聊消息范围」设为获取群内全部消息，否则只能收到 @ 机器人的消息。

Telegram：在 [@BotFather](https://t.me/BotFather) 用 `/newbot` 创建机器人，再用 `/setprivacy` 关闭隐私模式，并把机器人移出群后重新拉入。未关闭时只能收到 @ 与命令消息。

Discord：在 [Developer Portal](https://discord.com/developers/applications) 创建应用并取得 bot token，打开 Message Content Intent，再用 OAuth2 链接邀请机器人入服。未开启该 intent 时连接会被立即关闭。

微信：安装时选择 `weixin`，向导会拉起扫码登录；也可运行 `node scripts/weixin-login.mjs` 手工获取。腾讯没有后台复制 token 的入口，token 失效后需要重新扫码。微信官方客户端只有单聊形态。

各平台的协议细节、频控与限制见 `docs/platforms/`。

## 常用配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `platforms` | `["log"]` | 启用的平台，空数组表示只采集 |
| `forwardCategories` | `["chat"]` | 转发到平台的类别，默认只有玩家聊天 |
| `consoleForward` | `false` | 是否转发控制台与日志行 |
| `inbound` | `true` | 是否允许平台消息注入游戏 |
| `privateSync` | `false` | 是否接收私聊，对所有平台生效 |
| `crossPlatform` | `true` | 是否让平台之间互相同步 |
| `injectMode` | `say` | 注入方式；`say` 会写入服务器日志，`tellraw` 不写 |
| `inboundServer` | 自动 | 入站消息注入到哪台服务器 |

完整配置表与示例见 [`docs/configuration.md`](docs/configuration.md)。

手工补改配置时先写完整平台块，再写顶层键；每次写入都会对合并后的完整配置做校验：

```bash
mcsup plugin config set chat-bridge qq '{"appId":"...","clientSecret":"..."}'
mcsup plugin config set chat-bridge platforms '["qq","log"]'
mcsup plugin restart chat-bridge
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `mcsup plugin status chat-bridge` | 运行状态与收发统计 |
| `mcsup plugin logs chat-bridge` | 查看入站、注入与重连日志 |
| `mcsup plugin setup chat-bridge` | 重跑安装向导 |
| `mcsup plugin config get chat-bridge` | 查看当前配置 |
| `mcsup plugin restart chat-bridge` | 重启插件 |
| `mcsup plugin remove chat-bridge` | 卸载插件 |

## 排障

| 现象 | 处理 |
| --- | --- |
| 平台收不到游戏聊天 | 确认平台已启用、凭据有效，并查看日志中是否还有「没有可用的会话目标」 |
| 游戏收不到平台消息 | 确认 `inbound` 为 `true`、目标服务器正在运行、`inboundServer` 指向正确 |
| QQ 群内只能收到 @ 消息 | 群主把群消息范围改为获取群内全部消息 |
| Telegram 群内只能收到 @ 消息 | 用 `/setprivacy` 关闭隐私模式，并把机器人移出群后重新拉入 |
| Discord 连上又立即断开 | 打开 Message Content Intent |
| 私聊没有反应 | 私聊默认关闭，通过向导或 `privateSync` 打开 |
| 微信 token 失效 | 重新扫码登录，更新 `weixin.botToken` |

排障顺序固定为：平台是否收到消息、是否有出站目标、是否注入到游戏。完整排查见 [`docs/architecture.md`](docs/architecture.md) 与各平台文档。

## 文档

- [`AGENTS.md`](AGENTS.md)：构建、测试与维护约定
- [`docs/configuration.md`](docs/configuration.md)：完整配置参考
- [`docs/architecture.md`](docs/architecture.md)：消息模型、Ops 与运行保证
- [`docs/platforms/`](docs/platforms)：QQ、Telegram、Discord、微信协议细节
- [`docs/adding-a-platform.md`](docs/adding-a-platform.md)：新增平台适配器
- [`docs/testing.md`](docs/testing.md)：测试范围与真实宿主检查

## 许可

MIT