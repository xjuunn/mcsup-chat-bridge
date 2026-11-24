/**
 * 平台适配器共用的取值与解析工具
 *
 * 各平台拿到的都是「未校验的 JSON / 配置片段」，需要同一套宽松解析：
 * 类型不符就返回 undefined，绝不抛错；配置在工厂阶段一次性解析成强类型。
 * 放在 shared 下的原因是这些函数与平台协议无关，新增适配器直接复用，
 * 不必再抄一份 60 行的 `objectOf` / `stringOf`。
 */

import { PluginError } from "mcsup-plugin";

import { CATEGORIES, type MessageCategory } from "../../core/types.js";

/** 会话键：`kind:id`，用于 `exclude` 比较与日志定位 */
export function targetKey(kind: "group" | "private", id: string): string {
  return `${kind}:${id}`;
}

/** JSON 对象视图；数组、null、标量都返回 undefined */
export function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 非空字符串（顺带 trim）；其它类型返回 undefined */
export function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 平台 id：数字按十进制字符串处理，其余按非空字符串 */
export function idOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return stringOf(value);
}

/** 有限数值；不把字符串 "123" 当数字，避免配置里的引号被静默接受 */
export function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 布尔值：其它类型回退默认值 */
export function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** 整数并夹在 `[min, max]`；非数字回退默认值 */
export function intOf(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** 字符串数组：过滤空串并去重，保持首次出现顺序 */
export function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const text = stringOf(item);
    if (text !== undefined && !out.includes(text)) {
      out.push(text);
    }
  }
  return out;
}

/** 消息类别数组；空数组、全部不合法都视为「未配置」 */
export function categoriesOf(value: unknown): MessageCategory[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const out: MessageCategory[] = [];
  for (const item of value) {
    if (
      typeof item === "string" &&
      (CATEGORIES as readonly string[]).includes(item) &&
      !out.includes(item as MessageCategory)
    ) {
      out.push(item as MessageCategory);
    }
  }
  return out.length === 0 ? undefined : out;
}

/**
 * API 基址：必须是 http(s) 且去掉尾部斜杠。
 *
 * `subject` 只用于错误文案（`qq 的 URL ...`），把平台名留给调用方，
 * 避免共享层知道具体有哪些平台。
 */
export function httpUrlOf(value: unknown, subject: string): string | undefined {
  const text = stringOf(value);
  if (text === undefined) {
    return undefined;
  }
  if (!/^https?:\/\//i.test(text)) {
    throw new PluginError(
      "invalid_input",
      `${subject} 的 URL 必须以 http:// 或 https:// 开头，实际为 ${text}`,
    );
  }
  return text.replace(/\/+$/, "");
}