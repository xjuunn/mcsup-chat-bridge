# 微信机器人接入

面向维护者：腾讯 iLink Bot API 的协议链路、消息格式、可靠性行为与限制。

本项目对接**腾讯官方微信机器人（iLink Bot API）**：`getUpdates` 长轮询收取消息，
`sendMessage` 发送文本。它与 Telegram 同构，插件运行在宿主沙箱里，不需要公网回调地址，
也不走企业微信群 webhook 或公众号那套必须暴露 URL 的方案。

## 前置条件

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

## 协议链路

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

## 消息格式

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

## 可靠性行为

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

## 已知限制

- **token 只能扫码取得**：腾讯没有后台复制入口，插件也不把密钥落盘，所以首次使用必须
  先跑 `scripts/weixin-login.mjs`；token 丢失后要重新扫码（必要时先在手机微信解除旧绑定）。
- **扫码后无法获取 token 的情况**：服务端返回 `binded_redirect` 表示该微信号已绑定过
  另一个客户端，不会再签发 token；脚本会直接说明原因。
- 官方客户端只建模单聊，本项目不假设微信群机器人会话存在；群聊需要腾讯后续开放协议。
- 协议不提供发言人昵称，也不提供用户资料或通讯录接口；游戏内显示的是由 `from_user_id`
  派生的稳定短别名 `微信用户-xxxxxx`。同一个 id 跨重启不变，但别名不是真实昵称；需要
  真实姓名只能另行人工绑定（当前不提供）。
- 媒体只有占位：不解密 CDN 内容，也不跨平台搬运图片 / 语音 / 文件。

## 本地验证

`test/weixin.test.ts` 用真实的 HTTP 假 iLink 服务覆盖：配置解析、uint64 消息 id 保精度、
文本/语音/媒体归一化、单聊入站与白名单、learned targets、`get_updates_buf` 游标持久化、
`context_token` 回传与 `ret=-2` 重试、分片、5xx 重试、`-14` 暂停、`relay` 跨平台转发与
启停通知。真实联调只需按上面的前置条件扫码取得 token。

