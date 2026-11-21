/**
 * 分类层：把聊天 / 控制台行 / 生命周期事件归一为 `MessageDraft`
 *
 * 规则以「有序正则」表达，新增类别只需在这里加一条规则，或新增类别枚举。
 * 结构化聊天与玩家加入 / 离开由宿主单独投递，控制台行里的同名投影会被
 * 丢弃（返回 `skip`），避免同一条消息进两次。
 */

import { sanitizeChat, stripColorCodes } from "mcsup-plugin";

import type { MessageDraft } from "./types.js";

/** ANSI 转义（部分服务器日志会带颜色） */
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** 除制表符外的控制字符：控制台行可能混入，转发到聊天平台前要清掉 */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** 去掉日志前缀后的聊天行：`<Steve> 文本` */
const CHAT_BODY = /^<([^>]{1,64})>\s?(.*)$/;
const JOIN_BODY = /^([A-Za-z0-9_]{1,16}) joined the game\.?$/;
const LEAVE_BODY = /^([A-Za-z0-9_]{1,16}) left the game\.?$/;

/** 日志级别：兼容 `[Server thread/INFO]:` 与 `[09:30:00 INFO]:` 两种前缀 */
const LEVEL = /\[(?:[^\]]*\/)?(INFO|WARN|WARNING|ERROR|FATAL|SEVERE|DEBUG|TRACE)\]:?\s?/;

/** 异常栈（`\tat ...` / `java.lang.XxxException:` / `Caused by:`） */
const STACK = /^(?:\s+at\s|[A-Za-z0-9_$.]+(?:Exception|Error)(?::|\s|$)|Caused by:)/;

/** 玩家执行命令 */
const COMMAND = /^([A-Za-z0-9_]{1,16}) issued server command:\s?(.*)$/;

/** 进度 / 挑战 */
const ADVANCEMENT =
  /^([A-Za-z0-9_]{1,16}) (?:has made the advancement|has completed the challenge|has reached the goal)\b/;

/** 死亡消息：覆盖原版常见句式，未知句式仍会落到 `system` */
const DEATH =
  /^([A-Za-z0-9_]{1,16}) (?:was (?:slain|shot|killed|blown up|poked|impaled|fireballed|struck|doomed|obliterated|squashed|pricked)|died|drowned|blew up|fell|burned|starved|suffocated|withered|froze|hit the ground|walked into|tried to swim|went up in flames|experienced kinetic energy|discovered the floor was lava)\b/;

/** 服务器自身状态行 */
const SYSTEM =
  /^(?:Starting minecraft server|Loading properties|Preparing |Done \(|Stopping (?:the )?server|Saving (?:the game|players|chunks)|Server (?:started|stopped)|Using .+ as config|Generating keypair|Environment: )/;

export type ConsoleResult =
  | { readonly kind: "message"; readonly draft: MessageDraft }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * 去掉日志前缀（可叠加：`[时间] [线程/级别]: ` 或 `[时间 级别]: [线程/级别]: `）
 *
 * 最多剥四层，避免把正文里以 `[...]` 开头的正常内容削掉。
 */
function bodyOf(line: string): string {
  let body = line;
  for (let i = 0; i < 4; i += 1) {
    const next = body.replace(/^\[[^\]]*\]:?\s?/, "");
    if (next === body) {
      break;
    }
    body = next;
  }
  return body.trim();
}

function levelOf(line: string): string | undefined {
  return LEVEL.exec(line.slice(0, 160))?.[1]?.toUpperCase();
}

/** 单行纯文本：去颜色码与控制字符，折叠空白 */
function cleanText(text: string): string {
  return stripColorCodes(text)
    .replace(CONTROL, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function draftOf(
  input: { readonly server: string; readonly at: string; readonly line: string },
  category: MessageDraft["category"],
  from: string | null,
  text: string,
  rule: string,
): ConsoleResult {
  return {
    kind: "message",
    draft: {
      category,
      source: "console",
      server: input.server,
      at: input.at,
      from,
      text,
      raw: input.line,
      rule,
    },
  };
}

/**
 * 分类一条控制台行。
 *
 * 返回 `skip` 表示这一行已由结构化事件覆盖（聊天 / 加入 / 离开），
 * 或为空行；调用方会计入 `skipped`，但不会入库。
 */
export function classifyConsoleLine(input: {
  readonly server: string;
  readonly line: string;
  readonly at: string;
}): ConsoleResult {
  const line = input.line.replace(ANSI, "").replace(/\r$/, "");
  const body = bodyOf(line);
  if (body === "") {
    return { kind: "skip", reason: "empty" };
  }

  // 聊天 / 加入 / 离开由宿主同时投递结构化事件，控制台层不再重复
  if (CHAT_BODY.test(body)) {
    return { kind: "skip", reason: "structured:chat" };
  }
  if (JOIN_BODY.test(body)) {
    return { kind: "skip", reason: "structured:join" };
  }
  if (LEAVE_BODY.test(body)) {
    return { kind: "skip", reason: "structured:leave" };
  }

  const level = levelOf(line);
  const text = cleanText(body);

  if (level === "ERROR" || level === "FATAL" || level === "SEVERE") {
    return draftOf(input, "error", null, text, "console.error");
  }
  if (level === "WARN" || level === "WARNING") {
    return draftOf(input, "warning", null, text, "console.warning");
  }
  if (STACK.test(body)) {
    return draftOf(input, "error", null, text, "console.stack");
  }

  const command = COMMAND.exec(body);
  if (command !== null) {
    return draftOf(input, "command", command[1] ?? null, (command[2] ?? "").trim(), "console.command");
  }

  const advancement = ADVANCEMENT.exec(body);
  if (advancement !== null) {
    return draftOf(input, "advancement", advancement[1] ?? null, text, "console.advancement");
  }

  const death = DEATH.exec(body);
  if (death !== null) {
    return draftOf(input, "death", death[1] ?? null, text, "console.death");
  }

  if (SYSTEM.test(body)) {
    return draftOf(input, "system", null, text, "console.system");
  }
  if (level === "INFO") {
    return draftOf(input, "system", null, text, "console.system");
  }
  return draftOf(input, "other", null, text, "console.other");
}

/** 分类一条结构化聊天；以 `/` 开头的内容视为命令 */
export function classifyChat(input: {
  readonly server: string;
  readonly from: string;
  readonly text: string;
  readonly at: string;
}): MessageDraft {
  const text = sanitizeChat(input.text);
  const from = input.from.trim();
  const command = text.startsWith("/");
  return {
    category: command ? "command" : "chat",
    source: "chat",
    server: input.server,
    at: input.at,
    from: from === "" ? null : from,
    text,
    raw: input.text,
    rule: command ? "chat.command" : "chat.message",
  };
}

/** 服务器生命周期事件的固定文案 */
const LIFECYCLE: Readonly<Record<string, string>> = {
  "server:starting": "服务器开始启动",
  "server:started": "服务器已就绪",
  "server:stopped": "服务器已停止",
  "server:crashed": "服务器崩溃",
};

/** 生命周期事件 → 系统消息；未登记的事件返回 null */
export function classifyLifecycle(
  kind: string,
  server: string,
  at: string,
): MessageDraft | null {
  const text = LIFECYCLE[kind];
  if (text === undefined) {
    return null;
  }
  return {
    category: "system",
    source: "event",
    server,
    at,
    from: null,
    text,
    raw: null,
    rule: kind,
  };
}

/** 玩家加入 / 离开的结构化事件 */
export function classifyPlayer(
  kind: "player:joined" | "player:left",
  player: string,
  server: string,
  at: string,
): MessageDraft {
  const joined = kind === "player:joined";
  return {
    category: joined ? "join" : "leave",
    source: "event",
    server,
    at,
    from: player,
    text: joined ? `${player} 加入了游戏` : `${player} 离开了游戏`,
    raw: null,
    rule: kind,
  };
}