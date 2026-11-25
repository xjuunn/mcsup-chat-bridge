# 架构与消息模型

面向维护者：消息如何采集、分类、入库、分发，以及宿主与插件的边界。


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


## `messages`

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

## `status`

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


- **不持久化消息**：只保留最近 `storeSize` 条；进程重启即丢失。**插件配置与密钥由宿主持久化并按插件隔离**，聊天桥不落盘。
- **内存有界**：分发队列是固定大小环形缓冲（丢最旧 O(1)，慢消费者不会让数组增长）；入站队列同样有界；入库文本/原始行分别截断到 1000/4000 字符，超长控制台行不会撑爆缓存或结果帧。
- **事件是触发语义**：宿主不补发，断线期间的消息不会回填。
- **单平台保序**：同一平台内严格按入库顺序投递；入站注入也串行，保证游戏内顺序稳定。
- **平台间隔离**：一个平台慢或抛错不影响采集与其他平台。
- **停止**：先排空队列，再 abort 信号并调用 `stop`；排空与 `stop` 各有默认 3 秒上限，超时记 warn。
- **去重**：同内容摘要只入库一次；入站按平台消息 id 去重并保留 10 分钟；注入文本回流会被回声抑制。
- **配置回滚**：平台配置变更失败时保留旧平台，不会出现“两边都没有”的空窗。
- **能力降级**：未授予 `console:write` 时出站正常、入站计数为失败，不伪造成功。


- 已内置 QQ 官方机器人（API v2）、Telegram Bot API（长轮询）、Discord Bot Gateway（WebSocket + REST v10）与微信机器人（腾讯 iLink 长轮询）。
- 入站只处理文本与常见消息段（图片/语音/文件转为占位文本）；不把媒体内容落盘。Telegram 的群/私聊镜像可直接复用 `file_id` 转发媒体；QQ 需要先转存平台素材库；Discord 只把图片 URL 作为 embed 立即镜像；微信只保留占位（CDN 内容加密）。QQ 不支持回复链与话题线程，Telegram 支持论坛话题（`message_thread_id`）。跨平台（QQ ↔ Telegram ↔ Discord ↔ 微信）只转发文本，媒体句柄不通用，正文保留 `[图片]` 等占位。
- QQ 官方机器人在群聊默认只能收到 @ 消息；全量群消息需在开放平台开通权限，并受官方主动消息频控约束。Telegram 需要在 BotFather 关闭 privacy mode 才能收到群内全部消息。Discord 需要在 Developer Portal 打开 Message Content Intent（否则 Gateway 以 4014 关闭）。微信 token 只能由扫码脚本取得，且官方客户端只建模单聊。
- 与真实 QQ / Telegram / Discord / 微信端联调需要用户提供 QQ AppID/ClientSecret、Telegram bot token、Discord bot token、微信扫码得到的 bot token 与机器人环境；仓库内 QQ 用真实 HTTP + WebSocket 假服务端、Telegram 用真实 HTTP 长轮询假服务端、Discord 用真实 HTTP REST + WebSocket Gateway 假服务端、微信用真实 HTTP iLink 假服务端验证协议链路。
- 插件静态订阅 `console:line`，无法运行期退订；高噪音环境靠 `consoleForward` / `forwardCategories` 控制转发。
- 内存环形缓存，不落盘；需要历史时应由宿主查询或后续接持久化。
- 尚未与真实 MCSUP 宿主 + Minecraft 服务器联调；真实宿主联调放在下一阶段。
