/**
 * 出站会话目标：留空配置时「发给谁」的记忆
 *
 * 平台不保证配置里能写出目标 id：QQ 官方不给「群号 → group_openid」的换算，
 * 只能在收到群消息或入群事件时才知道那个 openid；Telegram 的 chat_id 虽然
 * 能从客户端里查，但绝大多数用户不知道去哪里找。`groups` / `privateUsers`
 * 留空时，出站目标就取这些「见过的会话」——所以这份记忆必须是**持久的**：
 * 进程重启（插件升级、宿主重启、`config set` 触发的平台重建）后清空的话，
 * 群里没先说话之前，私聊镜像就无处可发，而且是静默丢弃。
 *
 * 存储走宿主的 `storage:kv`（`plugin-data/<id>/kv/`，按插件 id 而非版本划分，
 * 升级不丢）。未授予该能力时退化为进程内记忆：行为与旧版一致，不阻塞启动。
 *
 * 写入策略：只在「真的新增/淘汰了会话」时写一次。会话数量是人的数量级（≤
 * `limit`），不需要防抖或批量；反过来，每条消息都写盘才是浪费。
 */

import type { LogClient } from "mcsup-plugin";

/** 宿主 `storage:kv` 的最小形状；与 SDK 的 `KvClient` 结构兼容 */
export interface KvLike {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: string | Uint8Array): Promise<void>;
}

/** 单类（群 / 私聊）的会话上限：超过丢最早学到的 */
export const DEFAULT_LEARNED_LIMIT = 64;

/** 快照版本；结构变更时递增，读到不认识的版本按空处理 */
const SNAPSHOT_VERSION = 1;

interface Snapshot {
  readonly groups: readonly string[];
  readonly users: readonly string[];
}

export interface LearnedTargetsOptions {
  /**
   * KV 键；同一插件的不同平台各用一个。
   *
   * 按 SDK 习惯写成 `<命名空间>:<键>`（同 `cache:` / `stats:` 前缀），
   * 这样 `kv.list("<命名空间>:")` 能列全、`purge` 也能按前缀清理。
   */
  readonly key: string;
  /** 宿主 KV；未授予 `storage:kv` 时为 undefined */
  readonly kv?: KvLike;
  readonly log: LogClient;
  /** 日志前缀里的平台名，默认 `qq`（保持既有日志不变） */
  readonly tag?: string;
  /** 每类会话的上限，默认 {@link DEFAULT_LEARNED_LIMIT} */
  readonly limit?: number;
}

/** 见过的会话（群 + 私聊），可持久化 */
export class LearnedTargets {
  private readonly key: string;
  private readonly kv: KvLike | undefined;
  private readonly log: LogClient;
  private readonly tag: string;
  private readonly limit: number;
  private readonly groupList: string[] = [];
  private readonly userList: string[] = [];
  private loadWarned = false;
  private saveWarned = false;

  public constructor(options: LearnedTargetsOptions) {
    this.key = options.key;
    this.kv = options.kv;
    this.log = options.log;
    this.tag = options.tag ?? "qq";
    this.limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_LEARNED_LIMIT));
  }

  /** 读回上次记住的会话；失败只告警一次，桥按「还没有目标」继续跑 */
  public async load(): Promise<void> {
    if (this.kv === undefined) {
      return;
    }
    try {
      const raw = await this.kv.get(this.key);
      if (raw === null || raw.length === 0) {
        return;
      }
      const snapshot = parseSnapshot(Buffer.from(raw).toString("utf8"), this.limit);
      if (snapshot === undefined) {
        this.log.warn(`[${this.tag}] 出站目标记录不可读，按空处理（键 ${this.key}）`);
        return;
      }
      // 先读到的算最早：之后新学到的追加在后面，淘汰时仍按「最早先丢」
      for (const id of snapshot.groups) {
        this.push(this.groupList, id);
      }
      for (const id of snapshot.users) {
        this.push(this.userList, id);
      }
      if (this.groupList.length + this.userList.length > 0) {
        this.log.info(
          `[${this.tag}] 恢复出站目标：群 ${this.groupList.length} 个、私聊 ${this.userList.length} 个`,
        );
      }
    } catch (error) {
      if (!this.loadWarned) {
        this.loadWarned = true;
        this.log.warn(`[${this.tag}] 读取出站目标失败，按空处理：${errorText(error)}`);
      }
    }
  }

  /** 记住一个会话；只有真的变化才落盘 */
  public remember(kind: "group" | "private", id: string): void {
    const list = kind === "group" ? this.groupList : this.userList;
    if (!this.push(list, id)) {
      return;
    }
    void this.persist();
  }

  /** 群聊目标（按首次出现顺序） */
  public groups(): readonly string[] {
    return [...this.groupList];
  }

  /** 忘记一个会话（例如机器人被移出群）；只有真的存在才落盘 */
  public forget(kind: "group" | "private", id: string): void {
    const list = kind === "group" ? this.groupList : this.userList;
    const index = list.indexOf(id);
    if (index === -1) {
      return;
    }
    list.splice(index, 1);
    void this.persist();
  }

  /** 私聊目标（按首次出现顺序） */
  public users(): readonly string[] {
    return [...this.userList];
  }

  /** 记住的会话总数 */
  public get size(): number {
    return this.groupList.length + this.userList.length;
  }

  /** 追加；已存在或超过上限时返回 false */
  private push(list: string[], id: string): boolean {
    if (id === "" || list.includes(id)) {
      return false;
    }
    list.push(id);
    // 超上限丢最早：与旧版 Set 的淘汰口径一致
    while (list.length > this.limit) {
      list.shift();
    }
    return true;
  }

  private async persist(): Promise<void> {
    if (this.kv === undefined) {
      return;
    }
    const body = JSON.stringify({
      v: SNAPSHOT_VERSION,
      groups: this.groupList,
      users: this.userList,
    } satisfies Snapshot & { readonly v: number });
    try {
      await this.kv.set(this.key, body);
    } catch (error) {
      // 落盘失败不影响收发：本次会话仍在内存里，下次新增时会再试
      if (!this.saveWarned) {
        this.saveWarned = true;
        this.log.warn(`[${this.tag}] 保存出站目标失败（重启后会丢）：${errorText(error)}`);
      }
    }
  }
}

/** 解析快照；结构不认识时返回 undefined，由调用方按空处理 */
function parseSnapshot(text: string, limit: number): Snapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record["v"] !== SNAPSHOT_VERSION) {
    return undefined;
  }
  return {
    groups: idsOf(record["groups"], limit),
    users: idsOf(record["users"], limit),
  };
}

function idsOf(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item !== "" && !out.includes(item)) {
      out.push(item);
    }
  }
  // 只保留最新的 `limit` 条（数组尾部是后学到的）
  return out.slice(-limit);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
