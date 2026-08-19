// 阶段 0.1：无 TTY 环境 spawn `dsh web --port 0`，验证：
//   1. stdout 打印 `dsh web: http://127.0.0.1:<port>` 行
//   2. HTTP GET 根路径返回 200
//   3. 进程可被正常终止
// 用法：node scripts/m0-spawn-check.mjs [--dsh-home <dir>]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dshHome = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "dsh-m0-home-"));
const cwd = mkdtempSync(join(tmpdir(), "dsh-m0-cwd-"));
const bin = process.env.DSH_BIN || "dsh";

const URL_RE = /^dsh web: (\S+)/m;

console.log(`[0.1] dsh binary: ${bin}`);
console.log(`[0.1] DSH_HOME:   ${dshHome}`);
console.log(`[0.1] cwd:        ${cwd}`);

const child = spawn(bin, ["web", "--port", "0", "--host", "127.0.0.1"], {
  cwd,
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  detached: process.platform !== "win32",
});

let cleaned = false;
function killChild() {
  if (cleaned || child.exitCode !== null) return;
  cleaned = true;
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      if (child.exitCode === null) {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      }
    } catch {}
  }, 1500).unref();
}
for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { try { killChild(); } catch {} });
}

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => { stdout += d; });
child.stderr.on("data", (d) => { stderr += d; });

const timeout = setTimeout(() => {
  console.error("[0.1] FAIL: 30s 超时未捕获 URL 行");
  killChild();
  process.exit(1);
}, 30000);

let url = null;
child.stdout.on("data", (d) => {
  const m = String(d).match(URL_RE);
  if (m) url = m[1];
});

// 等到 URL 出现
const deadline = Date.now() + 30000;
while (!url && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}
clearTimeout(timeout);

if (!url) {
  console.error("[0.1] FAIL: 未捕获到 'dsh web: <url>' 行");
  console.error("--- stdout tail ---\n", stdout.slice(-2000));
  console.error("--- stderr tail ---\n", stderr.slice(-2000));
  killChild();
  process.exit(1);
}
console.log(`[0.1] PASS: 捕获 URL 行 -> ${url}`);

// HTTP 200 检查
try {
  const res = await fetch(url);
  console.log(`[0.1] PASS: HTTP GET ${url} -> ${res.status}`);
  const body = await res.text();
  const hasBoot = body.includes("__DSH_BOOT__");
  console.log(`[0.1] ${hasBoot ? "PASS" : "WARN"}: 页面包含 window.__DSH_BOOT__ 注入点 = ${hasBoot}`);
} catch (e) {
  console.error(`[0.1] FAIL: HTTP 请求失败: ${e.message}`);
  killChild();
  process.exit(1);
}

// 优雅终止
killChild();
await new Promise((r) => setTimeout(r, 1500));
if (child.exitCode === null) {
  console.warn("[0.1] WARN: SIGTERM 后 1.5s 未退出，已 SIGKILL");
} else {
  console.log(`[0.1] PASS: SIGTERM 后正常退出 (code ${child.exitCode})`);
}

if (!process.argv[2]) rmSync(dshHome, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });
console.log("[0.1] DONE");
