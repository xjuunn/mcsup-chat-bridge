# 测试


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
