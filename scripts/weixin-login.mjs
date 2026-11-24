#!/usr/bin/env node
/**
 * 微信机器人扫码登录（腾讯 iLink 协议）
 *
 * 微信没有「后台复制 token」的入口：bot token 只能由手机扫码后签发一次，
 * 且服务端只把 token 回给发起扫码的进程。插件本身不落盘任何密钥，因此
 * 这一步必须由用户在终端完成，插件只消费结果。
 *
 * 用法：
 *   node scripts/weixin-login.mjs                # 只登录，终端直接显示二维码
 *   node scripts/weixin-login.mjs --apply        # 登录并写入 chat-bridge 配置
 *   node scripts/weixin-login.mjs --verify-pin   # 强制要求输入手机 PIN
 *   node scripts/weixin-login.mjs --plain        # 不绘制二维码，只打印链接
 *   node scripts/weixin-login.mjs --open         # 额外在浏览器打开二维码链接
 *   node scripts/weixin-login.mjs --emit-token --token-file=<path>
 *                                                # 供安装向导调用：二维码照常显示，
 *                                                # token 只写入指定的 0600 文件
 *
 * `--apply` 需要本机有 `mcsup`（PATH 中，或放在 ~/.cargo/bin）；
 * 它依次写入 `weixin.botToken`、把 `weixin` 并入 `platforms`、重启插件。
 *
 * `--emit-token` 不打印 token，也不改配置：安装向导拉起插件时由插件调用，
 * 宿主读回文件后负责写入。
 *
 * 依赖：仅 Node 标准库（Node >= 20 自带 fetch）。二维码由
 * `scripts/lib/qr.mjs` 直接在终端里绘制，不引入 qrcode-terminal 之类的依赖；
 * 终端不支持块字符时可用 `--plain` 退回只打印链接。
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { qrTerminal } from "./lib/qr.mjs";

const DEFAULT_API_BASE = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
/** 服务端单次状态轮询最多挂 35 秒，客户端按同样节奏超时 */
const LONG_POLL_MS = 35_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** 二维码连续过期 / PIN 连续错误的刷新上限，与官方客户端一致 */
const MAX_REFRESH = 3;
const PLUGIN_ID = "chat-bridge";
const APP_ID = "bot";
const CHANNEL_BASE = "3.0.1";
const CLIENT_VERSION = buildClientVersion(CHANNEL_BASE);

const args = process.argv.slice(2);
const options = {
  apply: args.includes("--apply"),
  verifyPin: args.includes("--verify-pin"),
  plain: args.includes("--plain"),
  open: args.includes("--open"),
  emitToken: args.includes("--emit-token"),
  tokenFile: readOption("--token-file") ?? process.env.MCSUP_SETUP_SECRET_FILE,
  // 安装向导的宿主可以接管排版：插件只写界面事件，二维码由宿主居中渲染
  uiFile: readOption("--ui-file") ?? process.env.MCSUP_SETUP_UI_FILE,
  // 新宿主列出本次允许回填的路径；缺省时保持单字符串协议
  setupFields: readSetupFields(process.env.MCSUP_SETUP_FIELDS),
  apiBase: readOption("--api-base") ?? DEFAULT_API_BASE,
};

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "用法：node scripts/weixin-login.mjs [--apply] [--verify-pin] [--plain] [--open] [--emit-token --token-file=路径] [--ui-file=路径] [--api-base=URL]",
      "",
      "  --apply       登录后写入 chat-bridge 配置并重启插件",
      "  --verify-pin  要求输入手机微信显示的数字（PIN）",
      "  --plain       不绘制终端二维码，只打印二维码链接",
      "  --open        额外在浏览器打开二维码链接",
      "  --emit-token  不打印 token，写入 --token-file 指定的文件（安装向导使用）",
      "  --token-file  配合 --emit-token 的文件路径，权限 0600",
      "  --ui-file     把二维码 / 状态写成 JSON 事件交给宿主排版（默认取 MCSUP_SETUP_UI_FILE）",
      "  --api-base    覆盖 iLink 基址（默认 https://ilinkai.weixin.qq.com）",
      "",
      "环境变量（安装向导设置）：MCSUP_SETUP_FIELDS 为允许回填的配置路径 JSON 数组；",
      "设置后密钥文件写成对象（如 weixin.botToken + weixin.apiBase），否则只写 token。",
      ""
    ].join("\n"),
  );
  process.exit(0);
}

if (options.verifyPin) {
  process.stdout.write("[login] 已启用 PIN 校验：扫码后会要求输入手机微信显示的数字\n");
}

if (options.emitToken && (options.tokenFile === undefined || options.tokenFile.trim() === "")) {
  fail("--emit-token 需要 --token-file 或 MCSUP_SETUP_SECRET_FILE；token 不会打印到终端");
}

// ---------------------------------------------------------------------------
// 安装向导的界面文件：插件只描述要显示什么，排版由宿主负责
// ---------------------------------------------------------------------------

/** 追加一条 UI 事件；未设置 UI 文件或写入失败时返回 false，由调用方回退到 stdout */
function emitUi(event) {
  const file = options.uiFile?.trim();
  if (file === undefined || file === "") {
    return false;
  }
  try {
    appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/** 状态行：有 UI 文件时交给宿主，否则直接写终端 */
function say(text) {
  if (!emitUi({ type: "status", text })) {
    process.stdout.write(`${text}\n`);
  }
}

/** 读取宿主允许回填的路径；非法或缺失时退回旧版单字符串协议 */
function readSetupFields(raw) {
  const text = raw?.trim();
  if (text === undefined || text === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed;
    }
  } catch {
    // 落到下面的警告
  }
  process.stderr.write("[login] 忽略非法的 MCSUP_SETUP_FIELDS，按旧版单字段协议继续\n");
  return undefined;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
let currentBaseUrl = options.apiBase.replace(/\/+$/, "");
let qrRefreshCount = 0;
let pendingVerifyCode;

try {
  let qr = await fetchQRCode();
  printQr(qr);

  for (;;) {
    const status = await pollStatus(qr.qrcode, pendingVerifyCode);
    const name = String(status.status ?? "");

    if (name.includes("need_verifycode")) {
      if (!process.stdin.isTTY) {
        fail("服务端要求输入手机 PIN，但当前终端不可交互；请在本地终端重新运行本脚本");
      }
      pendingVerifyCode = await ask(
        pendingVerifyCode === undefined
          ? "输入手机微信显示的数字，以继续连接："
          : "数字不匹配，请重新输入：",
      );
      continue;
    }

    if (name === "wait") {
      continue;
    }

    if (name === "scaned") {
      pendingVerifyCode = undefined;
      say("已扫码，等待手机确认…");
      continue;
    }

    if (name === "scaned_but_redirect") {
      const host = typeof status.redirect_host === "string" ? status.redirect_host.trim() : "";
      if (host !== "") {
        currentBaseUrl = `https://${host}`;
        say(`服务端要求切换到 ${currentBaseUrl}，继续轮询…`);
      } else {
        say("服务端要求切换区域，但没有给出主机名；继续使用当前地址");
      }
      continue;
    }

    if (name === "expired") {
      qrRefreshCount += 1;
      if (qrRefreshCount > MAX_REFRESH) {
        fail(`二维码连续失效 ${MAX_REFRESH} 次，请稍后重试`);
      }
      say(`二维码已过期，正在刷新（${qrRefreshCount}/${MAX_REFRESH}）…`);
      pendingVerifyCode = undefined;
      qr = await fetchQRCode();
      printQr(qr);
      continue;
    }

    if (name === "verify_code_blocked") {
      pendingVerifyCode = undefined;
      qrRefreshCount += 1;
      if (qrRefreshCount > MAX_REFRESH) {
        fail("PIN 连续错误，登录已停止；请稍后再试");
      }
      say(`PIN 输入错误过多，刷新二维码（${qrRefreshCount}/${MAX_REFRESH}）…`);
      qr = await fetchQRCode();
      printQr(qr);
      continue;
    }

    if (name === "binded_redirect") {
      fail(
        "这个微信号已经绑定过微信机器人客户端，服务端不会再签发新 token。\n" +
          "如果 token 已丢失，请先在手机微信里解除绑定，再重新运行本脚本",
      );
    }

    if (name === "confirmed") {
      const token = typeof status.bot_token === "string" ? status.bot_token.trim() : "";
      const botId = typeof status.ilink_bot_id === "string" ? status.ilink_bot_id.trim() : "";
      if (token === "" || botId === "") {
        fail("登录已确认，但服务端没有返回 bot token 或 ilink_bot_id；请重试");
      }
      process.stdout.write("\n登录成功。\n");
      process.stdout.write(`  ilink_bot_id: ${botId}\n`);
      if (typeof status.ilink_user_id === "string" && status.ilink_user_id !== "") {
        process.stdout.write(`  ilink_user_id: ${status.ilink_user_id}\n`);
      }
      if (typeof status.baseurl === "string" && status.baseurl !== "") {
        process.stdout.write(`  baseurl: ${status.baseurl}\n`);
        if (status.baseurl.replace(/\/+$/, "") !== options.apiBase.replace(/\/+$/, "")) {
          process.stdout.write(
            `  ↳ 服务端建议改用 ${status.baseurl}；需要时写入 weixin.apiBase\n`,
          );
        }
      }
      if (options.emitToken) {
        try {
          // 安装向导模式：token 只落进宿主指定的临时文件，不回显
          writeFileSync(options.tokenFile.trim(), buildSetupPayload(token, status.baseurl), {
            mode: 0o600,
            encoding: "utf8",
          });
        } catch (error) {
          fail(
            `写入 token 文件失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        process.stdout.write("\n已把 token 交给安装向导，继续完成剩余配置…\n");
        process.exit(0);
      }

      process.stdout.write(`\nbot token（只显示这一次）：\n${token}\n`);

      if (!options.apply) {
        process.stdout.write(
          "\n下一步：\n" +
            `  mcsup plugin config set ${PLUGIN_ID} weixin.botToken --secret   # 粘贴上面的 token\n` +
            `  mcsup plugin config set ${PLUGIN_ID} platforms '["weixin", ...]'\n` +
            `  mcsup plugin restart ${PLUGIN_ID}\n` +
            "或重新运行本脚本并加 --apply 自动完成\n",
        );
      } else {
        applyConfig(token, status.baseurl);
      }
      process.exit(0);
    }

    say(`未识别的登录状态 ${name}，继续轮询…`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  rl.close();
}

// ---------------------------------------------------------------------------
// 协议
// ---------------------------------------------------------------------------

/** 每个请求都要带的 iLink 头；登录阶段还没有 token，因此不带 Authorization */
function headers(token) {
  const result = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomUin(),
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": String(CLIENT_VERSION),
  };
  if (typeof token === "string" && token !== "") {
    result.Authorization = `Bearer ${token}`;
  }
  return result;
}

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}

async function fetchQRCode() {
  const body = { local_token_list: [] };
  if (options.verifyPin) {
    // 与官方客户端一致：verify_pin=1 要求手机端额外输入 PIN
    body.bot_spam_business_data = Buffer.from(JSON.stringify({ verify_pin: 1 }), "utf8").toString(
      "base64",
    );
  }
  const url = `${currentBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`;
  const response = await request(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const parsed = JSON.parse(await response.text());
  if (typeof parsed.qrcode !== "string" || parsed.qrcode === "") {
    throw new Error("服务端没有返回二维码值");
  }
  return {
    qrcode: parsed.qrcode,
    content: typeof parsed.qrcode_img_content === "string" ? parsed.qrcode_img_content : "",
  };
}

async function pollStatus(qrcode, verifyCode) {
  let url = `${currentBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (typeof verifyCode === "string" && verifyCode !== "") {
    url += `&verify_code=${encodeURIComponent(verifyCode)}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, LONG_POLL_MS);
  try {
    const response = await request(url, {
      method: "GET",
      headers: headers(),
      signal: controller.signal,
    });
    return JSON.parse(await response.text());
  } catch (error) {
    // 客户端超时、网关 524 与网络抖动都按「还没有变化」处理，继续轮询
    if (error instanceof Error && (error.name === "AbortError" || error.transient === true)) {
      return { status: "wait" };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function request(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const wrapped = new Error(`请求 ${url} 失败：${error instanceof Error ? error.message : error}`);
    wrapped.transient = true;
    throw wrapped;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const wrapped = new Error(`请求 ${url} 返回 ${response.status}：${text.slice(0, 200)}`);
    wrapped.transient = response.status >= 500;
    throw wrapped;
  }
  return response;
}

// ---------------------------------------------------------------------------
// 展示与交互
// ---------------------------------------------------------------------------

function printQr(qr) {
  if (qr.content === "") {
    say("服务端没有返回二维码内容；请重试或检查 apiBase");
    say("等待扫码…");
    return;
  }

  // 新宿主接管排版：只交出内容，二维码由宿主按终端宽度居中渲染
  if (emitUi({ type: "qr", content: qr.content, label: "用手机微信扫描下面的二维码" })) {
    if (options.open) {
      openUrl(qr.content);
    }
    say("等待扫码…");
    return;
  }

  process.stdout.write("\n用手机微信扫描下面的二维码：\n");
  if (!options.plain) {
    try {
      process.stdout.write(`\n${qrTerminal(qr.content)}\n\n`);
    } catch (error) {
      process.stdout.write(
        `（终端二维码绘制失败：${error instanceof Error ? error.message : String(error)}；改用链接）\n`,
      );
    }
  }

  process.stdout.write(`二维码链接（终端二维码扫不出时，可用手机直接打开）：\n  ${qr.content}\n`);
  if (options.open) {
    openUrl(qr.content);
  }
  process.stdout.write("\n等待扫码…\n");
}

/**
 * 安装向导回传内容
 *
 * 新宿主经 `MCSUP_SETUP_FIELDS` 声明允许回填的路径：登录一次可以同时写
 * `weixin.botToken` 与服务端建议的 `weixin.apiBase`，避免向导再问一遍基址。
 * 旧宿主不设置该变量，只写单个 token 字符串。基线地址等于默认值时省略，
 * 让配置保持干净。
 */
function buildSetupPayload(token, suggestedBaseUrl) {
  const allowed = options.setupFields;
  if (allowed === undefined) {
    return token;
  }
  const values = { "weixin.botToken": token };
  const base =
    typeof suggestedBaseUrl === "string" ? suggestedBaseUrl.trim().replace(/\/+$/, "") : "";
  const fallback = DEFAULT_API_BASE.replace(/\/+$/, "");
  if (base !== "" && base !== fallback && allowed.includes("weixin.apiBase")) {
    values["weixin.apiBase"] = base;
  }
  return JSON.stringify(values);
}

function openUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    return;
  }
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawnSync(command[0], command[1], { stdio: "ignore", timeout: 5_000 });
    if (child.error !== undefined) {
      process.stdout.write(`（无法自动打开浏览器：${child.error.message}）\n`);
    }
  } catch {
    process.stdout.write("（无法自动打开浏览器，请手动打开上面的链接）\n");
  }
}

async function ask(prompt) {
  const answer = await rl.question(prompt);
  return answer.trim();
}

// ---------------------------------------------------------------------------
// --apply：写入配置并重启插件
// ---------------------------------------------------------------------------

function applyConfig(token, suggestedBaseUrl) {
  const bin = resolveMcsup();
  if (bin === undefined) {
    process.stdout.write(
      "\n没有找到 mcsup 命令，无法自动写入配置。请手动执行：\n" +
        `  mcsup plugin config set ${PLUGIN_ID} weixin.botToken --secret\n`,
    );
    return;
  }

  process.stdout.write("\n正在写入配置…\n");
  const setToken = run(bin, [
    "plugin",
    "config",
    "set",
    PLUGIN_ID,
    "weixin.botToken",
    "--secret",
  ], { input: `${token}\n` });
  if (!setToken.ok) {
    process.stdout.write(
      `写入 weixin.botToken 失败（退出码 ${setToken.code}）。请检查插件是否已安装，或手动写入\n`,
    );
    return;
  }
  process.stdout.write("  ✓ weixin.botToken\n");

  if (typeof suggestedBaseUrl === "string" && suggestedBaseUrl !== "") {
    const current = options.apiBase.replace(/\/+$/, "");
    const suggested = suggestedBaseUrl.replace(/\/+$/, "");
    if (suggested !== current) {
      const setBase = run(bin, [
        "plugin",
        "config",
        "set",
        PLUGIN_ID,
        "weixin.apiBase",
        suggestedBaseUrl,
      ]);
      process.stdout.write(
        setBase.ok ? `  ✓ weixin.apiBase = ${suggestedBaseUrl}\n` : "  ! weixin.apiBase 写入失败，可手动补\n",
      );
    }
  }

  const platforms = readPlatforms(bin);
  if (!platforms.includes("weixin")) {
    platforms.push("weixin");
    const setPlatforms = run(bin, [
      "plugin",
      "config",
      "set",
      PLUGIN_ID,
      "platforms",
      JSON.stringify(platforms),
    ]);
    if (setPlatforms.ok) {
      process.stdout.write(`  ✓ platforms = ${JSON.stringify(platforms)}\n`);
    } else {
      process.stdout.write(
        `  ! platforms 写入失败；手动执行：mcsup plugin config set ${PLUGIN_ID} platforms '${JSON.stringify(platforms)}'\n`,
      );
    }
  } else {
    process.stdout.write("  = platforms 已包含 weixin\n");
  }

  const restart = run(bin, ["plugin", "restart", PLUGIN_ID]);
  if (restart.ok) {
    process.stdout.write("  ✓ 已重启插件；用 `mcsup plugin logs chat-bridge --follow` 查看连接日志\n");
  } else {
    process.stdout.write(
      `  ! 重启失败（退出码 ${restart.code}）；手动执行：mcsup plugin restart ${PLUGIN_ID}\n`,
    );
  }
}

function readPlatforms(bin) {
  const result = run(bin, ["plugin", "config", "get", PLUGIN_ID, "platforms", "--json"]);
  if (!result.ok || typeof result.stdout !== "string") {
    return ["log"];
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const value = parsed.value;
    if (Array.isArray(value)) {
      return value.filter((item) => typeof item === "string");
    }
  } catch {
    // 落到下面的默认值
  }
  return ["log"];
}

function resolveMcsup() {
  const configured = process.env.MCSUP_BIN;
  if (typeof configured === "string" && configured.trim() !== "") {
    return configured.trim();
  }
  for (const candidate of [
    "mcsup",
    `${process.env.HOME ?? ""}/.cargo/bin/mcsup`,
    `${process.env.USERPROFILE ?? ""}\\.cargo\\bin\\mcsup.exe`,
  ]) {
    if (candidate === "" || candidate === "/.cargo/bin/mcsup") {
      continue;
    }
    const probe = run(candidate, ["--version"]);
    if (probe.ok) {
      return candidate;
    }
  }
  return undefined;
}

function run(bin, args, extra = {}) {
  const child = spawnSync(bin, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...extra,
  });
  return {
    ok: child.status === 0,
    code: child.status ?? -1,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

function readOption(name) {
  const prefix = `${name}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

function fail(message) {
  process.stderr.write(`\n登录失败：${message}\n`);
  process.exit(1);
}