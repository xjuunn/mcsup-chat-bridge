# 开发说明

本文件面向维护者。用户安装与使用说明见 `README.md`；协议、配置与架构细节在 `docs/`。

## 文档索引

| 文件 | 内容 |
| --- | --- |
| `README.md` | 面向用户：安装、向导、平台接入、常用命令、排障 |
| `docs/architecture.md` | 消息模型、分类规则、Ops、运行保证与已知限制 |
| `docs/configuration.md` | 完整配置表、示例、密钥与热更新语义 |
| `docs/platforms/qq.md` | QQ 官方机器人协议、可靠性、频控 |
| `docs/platforms/telegram.md` | Telegram Bot API 协议、可靠性、排障 |
| `docs/platforms/discord.md` | Discord Gateway 与 REST 协议、可靠性 |
| `docs/platforms/weixin.md` | 微信 iLink 协议、扫码登录、限制 |
| `docs/adding-a-platform.md` | 新增适配器清单与最小骨架 |
| `docs/testing.md` | 测试分层、覆盖范围、真实宿主检查 |
| `docs/chat-platform-research.md` | OpenClaw / Hermes Agent 接入调研 |

## 环境与构建

需要 Node.js 20 以上。SDK 依赖同级的 `../mcsup/sdks/typescript`，首次构建前先在该仓库完成 `npm install`。

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:real
npm run verify        # 上述四步一次跑完
```

`npm run build` 产出可安装目录 `build/`：`manifest.json`、`descriptor.json`、启动器、`dist/`、`setup/` 与 vendored `node_modules/`。产物内是真实目录，不含符号链接。

## 目录结构

```
src/
  core/                   平台无关内核：消息模型、分类、缓存、分发、编排
  platform-kit/           适配器契约与公共件（registry、格式化、出站队列）
  platforms/              平台适配器，每个文件一个平台
  events/                 宿主事件校验与归一化
  config.ts               配置 schema 与安装向导字段
  ops/                    messages / status 两个查询
  setup/                  微信交互式安装字段
  index.ts                definePlugin 接线与能力声明
scripts/                  构建、扫码登录、真实宿主检查
test/                     内核、适配器、MockHost 与契约测试
```

## 架构约束

- `core/` 不感知具体平台；`platform-kit/` 只放契约与公共件；`platforms/` 只放适配器实现。
- 适配器只实现 `ChatPlatform` 的 `start` / `deliver` / `stop`，可选 `relay`。白名单、去重、注入方式、服务器选择与类别过滤都在内核，适配器不得重复判定。
- `relay` 只把文本发进自己的出站队列，禁止回流 `ctx.inbound`。
- 未授予 `console:write` 时入站降级为失败计数，不伪造成功。
- 消息不落盘；只有配置与宿主 `storage:kv` 中的会话目标会被持久化。

## 改动约定

- 新增或修改配置字段时，同时更新 `src/config.ts` 的 schema、安装向导字段和 `docs/configuration.md`。
- descriptor 的当前 schema 版本是 6。结构化字段描述使用 `setup.fields[].description` 的对象形式；字符串形式不抬高版本。
- 适配器新增行为需要同步 `docs/platforms/` 对应文档与 `docs/testing.md`。
- `README.md` 只保留用户视角内容；协议链路、内部实现与测试细节放在 `docs/`。
- 提交前运行 `npm run verify`，四项全过才算完成。