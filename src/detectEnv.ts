/**
 * 自动检测 node 与 dsh 入口。
 *
 * 背景：Obsidian 从 Finder/Dock 启动时 PATH 受限（无 nvm/homebrew 等目录），
 * `spawn("dsh")` 会 ENOENT；即使找到 dsh 脚本，其 shebang `#!/usr/bin/env node`
 * 也会因 PATH 里没有 node 而失败。因此采用 `node <dshEntry(lib/bin.js)>` 启动，
 * 本模块负责在受限环境下定位这两个路径（DeepHarness 同款思路，见其 README）。
 */

import { access, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const WINDOWS = process.platform === "win32";

async function isExecutable(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    if (!s.isFile()) return false;
    if (WINDOWS) return true;
    return (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function pathDirs(pathOverride?: string): Promise<string[]> {
  return (pathOverride ?? process.env.PATH ?? "").split(":").filter(Boolean);
}

/** PATH 中找 node（受限 PATH 下通常失败）。 */
async function findNodeOnPath(pathOverride?: string): Promise<string | null> {
  const name = WINDOWS ? "node.exe" : "node";
  for (const dir of await pathDirs(pathOverride)) {
    const p = join(dir, name);
    if (await isExecutable(p)) return p;
  }
  return null;
}

/** 常见安装目录中找 node（nvm 取最高版本）。 */
async function findNodeCommon(): Promise<string | null> {
  const nvmRoot = join(homedir(), ".nvm", "versions", "node");
  try {
    const versions = await readdir(nvmRoot);
    versions.sort().reverse();
    for (const v of versions) {
      const p = join(nvmRoot, v, "bin", WINDOWS ? "node.exe" : "node");
      if (await isExecutable(p)) return p;
    }
  } catch {
    /* nvm 不存在 */
  }
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
    join(homedir(), ".npm-global", "bin"),
  ];
  for (const dir of dirs) {
    const p = join(dir, WINDOWS ? "node.exe" : "node");
    if (await isExecutable(p)) return p;
  }
  return null;
}

/** 从 PATH 中的 dsh 脚本解析出 lib/bin.js（realpath 后推断）。 */
async function findDshFromPath(pathOverride?: string): Promise<string | null> {
  const name = WINDOWS ? "dsh.cmd" : "dsh";
  for (const dir of await pathDirs(pathOverride)) {
    const candidate = join(dir, name);
    if (!(await isExecutable(candidate))) continue;
    try {
      const real = await realpath(candidate);
      if (real.endsWith("bin.js")) return real; // npm 全局 bin 的 symlink 直指 bin.js
      // .bin/dsh → ../@deepseek-ai/dsh/lib/bin.js（npx 缓存等结构）
      for (const up of [1, 2]) {
        const base = dirname(real);
        const p = join(base, ...Array(up).fill(".."), "@deepseek-ai", "dsh", "lib", "bin.js");
        if (await isFile(p)) return p;
      }
    } catch {
      /* 非符号链接等情况 */
    }
  }
  return null;
}

/** 常见全局安装目录中找 @deepseek-ai/dsh/lib/bin.js。 */
async function findDshCommon(): Promise<string | null> {
  const candidates: string[] = [];
  const nvmRoot = join(homedir(), ".nvm", "versions", "node");
  try {
    const versions = await readdir(nvmRoot);
    versions.sort().reverse();
    for (const v of versions) {
      candidates.push(join(nvmRoot, v, "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
    }
  } catch {}
  candidates.push(
    "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
    "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
    join(homedir(), ".local", "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    join(homedir(), ".npm-global", "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
  );
  // npx 缓存（目录名含 hash，扫描匹配）
  try {
    const npxRoot = join(homedir(), ".npm", "_npx");
    for (const hash of await readdir(npxRoot)) {
      candidates.push(join(npxRoot, hash, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
    }
  } catch {}
  for (const p of candidates) {
    if (await isFile(p)) return p;
  }
  return null;
}

export interface DshEnv {
  nodePath: string;
  dshEntry: string;
}

export interface DetectOptions {
  /** 注入 PATH（单测用）。 */
  pathOverride?: string;
}

/**
 * 检测 node 与 dsh 入口。找不到返回 null（引导用户安装）。
 */
export async function detectDshEnv(options: DetectOptions = {}): Promise<DshEnv | null> {
  const nodePath = (await findNodeOnPath(options.pathOverride)) ?? (await findNodeCommon());
  if (!nodePath) return null;
  const dshEntry = (await findDshFromPath(options.pathOverride)) ?? (await findDshCommon());
  if (!dshEntry) return null;
  return { nodePath, dshEntry };
}

/** 仅探测 node（供错误提示区分场景）。 */
export async function detectNodeOnly(): Promise<string | null> {
  return (await findNodeOnPath()) ?? (await findNodeCommon());
}
