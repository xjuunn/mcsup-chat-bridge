/**
 * 真实环境测试：构建产物 + 真实子进程 + 真实 TCP 端点
 *
 * 对端是一个「假宿主」，但走的是完整线上协议：新起进程、通过
 * `build/bin/run.cmd`（或 run.sh）启动、TCP 连接、hello/welcome 握手、
 * event/call/config/ping/shutdown 帧。验证的不是分类函数的单测，而是
 * 产物能被宿主拉起并完成整条链路。
 *
 * 用法：
 *   npm run build
 *   npm run test:real
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "build");
const entry = path.join(buildDir, "bin", "entry.mjs");
const launcher =
  process.platform === "win32"
    ? path.join(buildDir, "bin", "run.cmd")
    : path.join(buildDir, "bin", "run.sh");

if (!existsSync(entry)) {
  console.error("[real] 未找到构建产物，请先运行 npm run build");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(buildDir, "manifest.json"), "utf8"));
const descriptor = JSON.parse(readFileSync(path.join(buildDir, "descriptor.json"), "utf8"));

assert(manifest.id === "chat-bridge", `manifest.id 应为 chat-bridge，实际 ${manifest.id}`);
assert(manifest.capabilities.includes("events"), "manifest 缺少 events 能力");
assert(manifest.capabilities.includes("console:read"), "manifest 缺少 console:read 能力");
assert(
  Array.isArray(manifest.subscriptions) && manifest.subscriptions.includes("chat:message"),
  "manifest 未声明 chat:message 订阅",
);
assert(
  Array.isArray(descriptor.ops) && descriptor.ops.some((op) => op.id === "messages"),
  "descriptor 缺少 messages op",
);
assert(
  Array.isArray(descriptor.ops) && descriptor.ops.some((op) => op.id === "status"),
  "descriptor 缺少 status op",
);

const server = net.createServer();
server.on("error", (error) => fail(`宿主监听失败：${error.message}`));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (address === null || typeof address === "string") {
  fail("无法取得监听端口");
}
const endpoint = `tcp://127.0.0.1:${address.port}`;
const accepted = new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error("插件在 10 秒内未连接到宿主端点"));
  }, 10_000);
  server.once("connection", (socket) => {
    clearTimeout(timer);
    resolve(socket);
  });
});

let stderr = "";
let stdout = "";
let exited = false;
// Windows 上 .cmd 必须经 cmd.exe 启动；显式传 /d /s /c，避免 shell:true 的
// 参数拼接与弃用告警。endpoint 与路径都由本脚本生成，不含用户输入。
//
// 这里必须用 windowsVerbatimArguments + 外层双引号：Node 默认会给含空格的
// 参数加引号并把内部引号转义成 \"，而 cmd.exe 不认反斜杠转义，会直接报
// 「不是内部或外部命令」。`cmd /s /c ""<path>" --endpoint <url>"` 是标准写法：
// /s 去掉最外层引号，内部 `<path>` 的引号保留。
const child =
  process.platform === "win32"
    ? spawn(
        "cmd.exe",
        ["/d", "/s", "/c", `""${launcher}" --endpoint ${endpoint}"`],
        {
          cwd: root,
          env: { ...process.env, MCSUP_PLUGIN_TOKEN: "a".repeat(64) },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
        },
      )
    : spawn(launcher, ["--endpoint", endpoint], {
        cwd: root,
        env: { ...process.env, MCSUP_PLUGIN_TOKEN: "a".repeat(64) },
        stdio: ["ignore", "pipe", "pipe"],
      });
child.on("error", (error) => fail(`无法启动插件进程：${error.message}`));
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
const exitPromise = new Promise((resolve) => {
  child.on("exit", (code, signal) => {
    exited = true;
    resolve(code ?? (signal === null ? -1 : -2));
  });
});

const frames = [];
let buffer = "";
let socket;
try {
  socket = await accepted;
} catch (error) {
  if (!exited) {
    child.kill();
  }
  server.close();
  console.error(`[real] ${error instanceof Error ? error.message : String(error)}`);
  if (stderr) {
    console.error("--- 插件 stderr ---");
    console.error(stderr.slice(-2_000));
  }
  process.exit(1);
}
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) {
      return;
    }
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== "") {
      try {
        frames.push(JSON.parse(line));
      } catch {
        fail(`收到非 JSON 帧：${line}`);
      }
    }
  }
});

const send = (frame) => {
  socket.write(`${JSON.stringify({ v: 1, ...frame })}\n`);
};

const waitFor = async (predicate, label, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(predicate);
    if (found !== undefined) {
      return found;
    }
    if (Date.now() >= deadline) {
      fail(`等待超时：${label}`);
    }
    await delay(10);
  }
};

const resultOf = async (id) => {
  const frame = await waitFor((f) => f.type === "result" && f.id === id, `result ${id}`);
  if (frame.ok !== true) {
    fail(`调用 ${id} 失败：${JSON.stringify(frame.error)}`);
  }
  return frame.output;
};

let nextId = 100;
const call = async (op, input = {}) => {
  const id = nextId;
  nextId += 1;
  send({ type: "call", id, op, input });
  return await resultOf(id);
};

const successCases = [];

try {
  // ---- 握手 -------------------------------------------------------------
  const hello = await waitFor((f) => f.type === "hello", "hello");
  assert(hello.plugin_id === "chat-bridge", `hello.plugin_id 异常：${hello.plugin_id}`);
  assert(hello.api === 1, `hello.api 异常：${hello.api}`);
  assert(hello.requested.includes("events"), "hello 未申请 events");
  assert(hello.requested.includes("console:read"), "hello 未申请 console:read");
  assert(hello.subscriptions.includes("console:line"), "hello 未订阅 console:line");
  successCases.push("hello 帧包含插件 id、能力与订阅");

  send({
    type: "welcome",
    session_id: "real-session-1",
    host_version: "0.0.0-test",
    granted: ["events", "console:read"],
    limits: {
      inflight: 8,
      frame_bytes: 1_048_576,
      event_queue: 1_024,
      log_lines_per_sec: 200,
    },
    config: { revision: 1, values: { platforms: ["log", "null"] } },
    scope: { kind: "machine" },
  });
  await delay(150);

  // ---- 投递事件 ---------------------------------------------------------
  const at = (second) => `2026-11-21T12:00:${String(second).padStart(2, "0")}Z`;
  const emit = (seq, kind, data) => {
    send({ type: "event", seq, kind, at: at(seq), server: "survival", data });
  };

  emit(1, "chat:message", {
    server: "survival",
    from: "Steve",
    text: "\u00a7a有人吗",
    at: at(1),
  });
  emit(2, "chat:message", { server: "survival", from: "Steve", text: "/help", at: at(2) });
  emit(3, "player:joined", { player: "Alex" });
  // 与事件 1 同一行的控制台投影：应被跳过，避免重复
  emit(4, "console:line", {
    server: "survival",
    line: "[12:00:04] [Server thread/INFO]: <Steve> \u00a7a有人吗",
    at: at(4),
  });
  emit(5, "console:line", {
    server: "survival",
    line: "[12:00:05] [Server thread/WARN]: Can't keep up! Is the server overloaded?",
    at: at(5),
  });
  emit(6, "console:line", {
    server: "survival",
    line: "[12:00:06] [Server thread/ERROR]: Failed to load chunk",
    at: at(6),
  });
  emit(7, "console:line", {
    server: "survival",
    line: "[12:00:07] [Server thread/INFO]: Saving the game",
    at: at(7),
  });
  emit(8, "server:started", { name: "survival" });
  // 与事件 10 同一行的控制台投影：应被跳过
  emit(9, "console:line", {
    server: "survival",
    line: "[12:00:09] [Server thread/INFO]: Alex left the game",
    at: at(9),
  });
  emit(10, "player:left", { player: "Alex" });
  emit(11, "console:line", {
    server: "survival",
    line: "[12:00:11] [Server thread/INFO]: Alex was slain by Zombie",
    at: at(11),
  });
  emit(12, "console:line", {
    server: "survival",
    line: "[12:00:12] [Server thread/INFO]: Steve has made the advancement [Stone Age]",
    at: at(12),
  });
  emit(13, "server:starting", { name: "survival" });
  emit(14, "server:crashed", { name: "survival" });
  await delay(300);

  // ---- 查询与分页 -------------------------------------------------------
  const page1 = await call("messages", { limit: 2 });
  assert(Array.isArray(page1.items) && page1.items.length === 2, "messages 首页应有 2 条");
  assert(typeof page1.next === "string" && page1.next !== "", "messages 首页应返回 next 游标");
  const page2 = await call("messages", { limit: 2, cursor: page1.next });
  assert(Array.isArray(page2.items) && page2.items.length === 2, "messages 第二页应有 2 条");
  const ids = new Set([...page1.items, ...page2.items].map((item) => item.id));
  assert(ids.size === 4, "分页结果不应重复");
  successCases.push("messages 游标分页连续且不重复");

  const all = await call("messages", { limit: 50 });
  assert(all.items.length === 12, `messages 应有 12 条，实际 ${all.items.length}`);
  const categories = all.items.map((item) => item.category).sort();
  assert(
    JSON.stringify(categories) ===
      JSON.stringify([
        "advancement",
        "chat",
        "command",
        "death",
        "error",
        "join",
        "leave",
        "system",
        "system",
        "system",
        "system",
        "warning",
      ]),
    `类别不符：${categories.join(",")}`,
  );
  const chatTexts = all.items.filter((item) => item.category === "chat").map((item) => item.text);
  assert(chatTexts.length === 1 && chatTexts[0] === "有人吗", `聊天去重/去色失败：${chatTexts.join(" | ")}`);
  successCases.push("聊天去重、颜色码清理与 8 种类别识别");

  const warnings = await call("messages", { category: "warning" });
  assert(warnings.items.length === 1, "按类别过滤应命中 1 条 warning");
  successCases.push("messages 支持类别过滤");

  const consoleOnly = await call("messages", { source: "console", limit: 50 });
  assert(consoleOnly.items.length === 5, `source=console 应有 5 条，实际 ${consoleOnly.items.length}`);
  assert(
    consoleOnly.items.every((item) => item.source === "console"),
    "source=console 返回了其他来源",
  );
  const survivalOnly = await call("messages", { server: "survival", limit: 50 });
  assert(survivalOnly.items.length === 12, "server=survival 应命中全部消息");
  const creative = await call("messages", { server: "creative" });
  assert(creative.items.length === 0, "server=creative 不应命中消息");
  successCases.push("messages 支持 source / server 过滤");

  // ---- 状态与平台投递 ---------------------------------------------------
  let status = await call("status");
  const deadline = Date.now() + 5_000;
  while (
    (status.platforms[0]?.delivered < 12 || status.platforms[1]?.delivered < 12) &&
    Date.now() < deadline
  ) {
    await delay(20);
    status = await call("status");
  }
  assert(status.started === true, "status.started 应为 true");
  assert(status.accepted === 12, `status.accepted 应为 12，实际 ${status.accepted}`);
  assert(status.skipped === 2, `status.skipped 应为 2，实际 ${status.skipped}`);
  assert(status.stored === 12, `status.stored 应为 12，实际 ${status.stored}`);
  assert(
    status.categories.chat === 1 && status.categories.system === 4,
    "status 分类计数不符",
  );
  assert(
    status.categories.death === 1 && status.categories.advancement === 1,
    "status 未记录死亡/进度",
  );
  assert(
    status.platforms.length === 2 &&
      status.platforms[0].id === "log" &&
      status.platforms[1].id === "null",
    "status 平台列表不符",
  );
  assert(
    status.platforms[0].delivered === 12 && status.platforms[1].delivered === 12,
    `两个平台都应投递 12 条，实际 ${status.platforms.map((p) => p.delivered).join("/")}`,
  );
  successCases.push("status 反映采集、跳过、分类与双平台投递计数");

  // ---- 配置热更新 -------------------------------------------------------
  const configId = nextId;
  nextId += 1;
  send({
    type: "config",
    id: configId,
    revision: 2,
    values: { platforms: ["log", "null"], forwardCategories: ["chat"] },
  });
  const configResult = await resultOf(configId);
  assert(configResult.revision === 2, "config 回执 revision 不符");
  emit(15, "console:line", {
    server: "survival",
    line: "[12:00:15] [Server thread/WARN]: 这条只入库不转发",
    at: at(15),
  });
  await delay(200);
  const filtered = await call("status");
  assert(filtered.accepted === 13, `配置变更后 accepted 应为 13，实际 ${filtered.accepted}`);
  assert(filtered.filtered === 1, `配置变更后 filtered 应为 1，实际 ${filtered.filtered}`);
  assert(filtered.stored === 13, `配置变更后 stored 应为 13，实际 ${filtered.stored}`);
  assert(
    filtered.platforms.every((platform) => platform.delivered === 12),
    "被过滤的 warning 不应投递到任何平台",
  );
  successCases.push("配置热更新只影响转发，不影响采集，双平台一致");

  // ---- 心跳与平台适配器实际输出 ----------------------------------------
  send({ type: "ping", n: 7 });
  const pong = await waitFor((f) => f.type === "pong" && f.n === 7, "pong 7");
  assert(pong.n === 7, "pong 序号不符");
  await delay(100);
  assert(stderr.includes("日志平台已就绪"), "日志平台未输出就绪日志");
  assert(stderr.includes("[chat-bridge]") && stderr.includes("有人吗"), "日志平台未收到并输出聊天消息");
  successCases.push("ping/pong 与日志平台的真实投递输出");

  // ---- 退出 -------------------------------------------------------------
  send({ type: "shutdown", grace_ms: 2_000 });
  const code = await Promise.race([exitPromise, delay(8_000).then(() => -3)]);
  assert(code === 0, `退出码应为 0，实际 ${code}`);
  successCases.push("shutdown 后进程以退出码 0 结束");
} catch (error) {
  console.error(`\n[real] 失败：${error instanceof Error ? error.message : String(error)}`);
  if (stderr) {
    console.error("\n--- 插件 stderr（末尾）---");
    console.error(stderr.slice(-3_000));
  }
  if (!exited) {
    child.kill("SIGKILL");
  }
  server.close();
  process.exit(1);
}

console.log("[real] 通过：");
for (const item of successCases) {
  console.log(`  - ${item}`);
}
console.log(`[real] 插件 stderr 共 ${stderr.length} 字节，退出码 0。`);
server.close();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(`[real] ${message}`);
  process.exit(1);
}