#!/usr/bin/env node
/**
 * 生成可直接 `mcsup plugin install --from` 的产物目录 `artifact/`。
 *
 * 为什么需要这一步：
 * - `mcsup-plugin build` 只做 tsc + 生成 manifest/descriptor，不做依赖打包；
 * - `build/` 里的 entry.mjs 与 dist/*.js 都有裸导入（`mcsup-plugin`、`ws`、`zod`），
 *   运行期要靠 Node 的 node_modules 解析；
 * - 而本仓库的 `mcsup-plugin` 是 `file:../mcsup/sdks/typescript`，npm 在 Windows 上
 *   会物化成 Junction。宿主把任何符号链接视为不可信产物，直接拒绝
 *   （`denied: symbolic link in artifact`），所以不能从仓库根目录安装。
 *
 * 做法：复制 `build/`，再把运行期依赖以「真实目录」复制进去，最后断言目录内
 * 没有任何符号链接，并用一次真实 ESM 解析自检。SDK 只复制 dist 与 package.json，
 * 避免把 57 MB 的源码与测试目录塞进产物。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "build");
const OUT = path.join(ROOT, "artifact");

/** 运行时必须存在的裸导入：包名 → 只复制这些子路径（空表示整包） */
const RUNTIME_DEPS = new Map([
  // SDK 只需要发布出来的 dist 与 package.json（name/exports 供自引用解析）
  ["mcsup-plugin", ["dist", "package.json"]],
  ["ws", []],
  ["zod", []],
]);

function fail(message) {
  console.error(`[stage] ${message}`);
  process.exit(1);
}

function copyDir(from, to, options = {}) {
  const { skip = new Set() } = options;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) {
      continue;
    }
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      // 绝不把链接带进产物：宿主会拒绝整个安装
      fail(`源目录含符号链接，拒绝复制：${source}`);
    }
    if (stat.isDirectory()) {
      copyDir(source, target, options);
    } else if (stat.isFile()) {
      fs.copyFileSync(source, target);
    }
  }
}

function copySelected(from, to, entries) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of entries) {
    const source = path.join(from, name);
    const target = path.join(to, name);
    const stat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (stat === undefined) {
      fail(`依赖 ${path.basename(from)} 缺少 ${name}`);
    }
    if (stat.isSymbolicLink()) {
      fail(`依赖 ${path.basename(from)} 的 ${name} 是符号链接`);
    }
    if (stat.isDirectory()) {
      copyDir(source, target);
    } else {
      fs.copyFileSync(source, target);
    }
  }
}

/** 递归统计并对任何链接直接报错 */
function audit(dir) {
  let files = 0;
  let bytes = 0;
  const links = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        links.push(full);
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else {
        files += 1;
        bytes += stat.size;
      }
    }
  };
  walk(dir);
  return { files, bytes, links };
}

// ---- 1. 前置检查 ---------------------------------------------------------
for (const required of ["manifest.json", "descriptor.json", "bin", "dist"]) {
  if (!fs.existsSync(path.join(BUILD, required))) {
    fail(`build/ 缺少 ${required}；先运行 npm run build`);
  }
}

// ---- 2. 复制编译产物 -----------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
copyDir(BUILD, OUT);

// ---- 3. 复制运行期依赖（真实目录，不带链接） -----------------------------
for (const [name, entries] of RUNTIME_DEPS) {
  const resolved = path.join(ROOT, "node_modules", name);
  if (!fs.existsSync(resolved)) {
    fail(`缺少运行期依赖 ${name}；先运行 npm install`);
  }
  // realpath 穿透 file: 依赖的 Junction，避免复制到链接本身
  const real = fs.realpathSync(resolved);
  const target = path.join(OUT, "node_modules", name);
  if (entries.length === 0) {
    copyDir(real, target, { skip: new Set(["node_modules"]) });
  } else {
    copySelected(real, target, entries);
  }
}

// ---- 4. 断言：产物内没有任何符号链接 ------------------------------------
const summary = audit(OUT);
if (summary.links.length > 0) {
  fail(`产物含符号链接，宿主会拒绝安装：\n  ${summary.links.join("\n  ")}`);
}
if (summary.files > 5000) {
  fail(`产物文件数 ${summary.files} 超过宿主上限 5000`);
}
if (summary.bytes > 512 * 1024 * 1024) {
  fail(`产物大小 ${(summary.bytes / 1024 / 1024).toFixed(1)} MB 超过宿主上限 512 MB`);
}

// ---- 5. 自检：用真实 ESM 解析确认依赖可加载 ------------------------------
const probe = [
  "await import('./dist/index.js');",
  "await import('mcsup-plugin');",
  "await import('ws');",
  "await import('zod');",
  "console.log('resolve-ok');",
].join(" ");
try {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: OUT,
    encoding: "utf8",
  });
  if (!out.includes("resolve-ok")) {
    fail(`依赖自检未通过：${out.trim()}`);
  }
} catch (error) {
  fail(`依赖自检失败：${error instanceof Error ? error.message : String(error)}`);
}

console.log(
  `[stage] 完成：${OUT}\n` +
    `[stage] ${summary.files} 个文件，${(summary.bytes / 1024 / 1024).toFixed(1)} MB，无符号链接\n` +
    `[stage] 安装：mcsup plugin install --from .\\artifact --yes`,
);