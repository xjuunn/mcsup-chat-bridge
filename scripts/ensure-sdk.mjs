/**
 * 确保本地 SDK 的构建产物是最新的。
 *
 * 插件以 `file:../mcsup/sdks/typescript` 依赖 SDK，`exports` 指向 `dist/`。
 * 仓库里 dist 被忽略，干净检出后需要先构建 SDK。这里比较源码与产物的
 * mtime：缺失或过期才构建，已是最新时零开销。
 *
 * 直接调用 SDK 自带的 tsc，避免 `npm run build` 经 shell 时的引号与
 * 弃用告警问题。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdk = path.resolve(root, "..", "mcsup", "sdks", "typescript");
const built = path.join(sdk, "dist", "index.js");

/** 目录下所有 .ts / .json 的最新修改时间 */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else if (/\.(ts|json)$/.test(entry.name)) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

/** 返回需要构建的原因；已是最新时返回 null */
function staleReason() {
  if (!existsSync(built)) {
    return "dist 缺失";
  }
  if (!existsSync(path.join(sdk, "src"))) {
    console.error(`[ensure-sdk] 未找到 SDK 源码目录：${sdk}`);
    process.exit(1);
  }
  const builtAt = statSync(built).mtimeMs;
  const sourcesAt = Math.max(
    newestMtime(path.join(sdk, "src")),
    statSync(path.join(sdk, "package.json")).mtimeMs,
    statSync(path.join(sdk, "tsconfig.build.json")).mtimeMs,
  );
  return sourcesAt > builtAt ? "SDK 源码比 dist 新" : null;
}

const reason = staleReason();
if (reason !== null) {
  const tsc = path.join(sdk, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) {
    console.error(`[ensure-sdk] 未找到 SDK 的 typescript：${tsc}`);
    console.error("[ensure-sdk] 请先在 SDK 目录执行 npm install");
    process.exit(1);
  }
  console.error(`[ensure-sdk] ${reason}，开始构建 SDK ...`);
  const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: sdk,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error("[ensure-sdk] SDK 构建失败");
    process.exit(result.status ?? 1);
  }
}