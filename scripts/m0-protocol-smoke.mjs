// 阶段 0.3：最小协议冒烟——完整提问闭环验证
//   1. spawn `dsh web --port 0`（临时 DSH_HOME / cwd）
//   2. POST /api/host.describe 握手
//   3. POST /api/session.create → sessionId
//   4. 打开 WS /api/events.mux 收下行帧
//   5. POST /api/session.prompt：要求 agent 必须用 ask_user_question 提问
//   6. 收到 question/requested → POST /api/respond 回传答案（client-response 信封）
//   7. 验证 question/resolved(answered) 与 agent 后续文本输出
// 用法：DSH_BIN=<dsh 路径> node scripts/m0-protocol-smoke.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// 默认复用真实 ~/.dsh（凭证在 ~/.dsh/.env，loadLayeredEnv 自动加载）——与插件真实场景一致。
// 传 --isolated 则使用临时 DSH_HOME（无凭证，仅用于无 LLM 的链路测试）。
const isolated = process.argv.includes("--isolated");
const dshHome = isolated ? mkdtempSync(join(tmpdir(), "dsh-m0-home-")) : undefined;
const cwd = mkdtempSync(join(tmpdir(), "dsh-m0-cwd-"));
const bin = process.env.DSH_BIN || "dsh";
const URL_RE = /^dsh web: (https?:\/\/\S+)/m;

const log = (...a) => console.log("[0.3]", ...a);

// ---------- 1. spawn ----------
const child = spawn(bin, ["web", "--port", "0", "--host", "127.0.0.1"], {
  cwd,
  env: dshHome ? { ...process.env, DSH_HOME: dshHome } : process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  // 独立进程组：脚本被中断/被杀时可按组清理，避免孤儿进程
  detached: process.platform !== "win32",
});
let stdout = "";
child.stdout.on("data", (d) => { stdout += d; });
let stderr = "";
child.stderr.on("data", (d) => { stderr += d; });

let url = null;
child.stdout.on("data", (d) => {
  const m = String(d).match(URL_RE);
  if (m) url = m[1];
});

const deadline = Date.now() + 30000;
while (!url && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
if (!url) {
  console.error("[0.3] FAIL: 未捕获 URL\nstdout:\n", stdout.slice(-2000), "\nstderr:\n", stderr.slice(-2000));
  child.kill("SIGKILL");
  process.exit(1);
}
log(`服务就绪: ${url}`);

// ---------- 2. host.describe 握手 ----------
async function rpc(method, payload, signal) {
  const res = await fetch(`${url}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload }),
    signal,
  });
  return res.json();
}
const desc = await rpc("host.describe", {});
if (!desc.result?.ok) { console.error("[0.3] FAIL: host.describe", JSON.stringify(desc)); cleanup(1); }
log(`host.describe OK (version=${desc.result.value?.version ?? "?"})`);

// ---------- 3. session.create ----------
const created = await rpc("session.create", { cwd });
if (!created.result?.ok) { console.error("[0.3] FAIL: session.create", JSON.stringify(created)); cleanup(1); }
const sessionId = created.result.value.sessionId;
log(`session.create OK: ${sessionId}`);

// ---------- 4. WS mux 下行 ----------
const ws = new WebSocket(`${url.replace("http", "ws")}/api/events.mux`);
const seen = new Set();
const textParts = [];
const reasoningParts = [];
let questionFrame = null;

const frameQueue = [];
const waiters = [];
let chunkDebugCount = 0;
ws.onmessage = (ev) => {
  let env;
  try { env = JSON.parse(ev.data); } catch { return; }
  const p = env.payload ?? {};
  seen.add(p.type);
  if (p.type === "question/requested") questionFrame = { rpcId: env.rpcId, ...p };
  if (p.type === "session/event" && p.event) {
    seen.add(`session/event:${p.event.type}`);
    const ev = p.event;
    if (ev.type === "assistant/chunk" && ev.data?.chunk?.type === "text-delta") {
      textParts.push(ev.data.chunk.text ?? "");
    }
    if (ev.type === "assistant/chunk" && ev.data?.chunk?.type === "reasoning-delta") {
      reasoningParts.push(ev.data.chunk.text ?? "");
    }
    if (ev.type === "assistant/chunk" && chunkDebugCount < 3) {
      chunkDebugCount += 1;
      log(`assistant/chunk 原始结构: ${JSON.stringify(ev).slice(0, 300)}`);
    }
    if (ev.type === "request/header" && ev.data?.header?.tools) {
      log(`request/header: model=${ev.data.header.config?.model} effort=${ev.data.header.config?.reasoningEffort} tools=${ev.data.header.tools.length} 个`);
      const names = ev.data.header.tools.map((t) => t.name);
      log(`工具列表: ${names.join(", ")}`);
    }
  }
  frameQueue.push(env);
  while (waiters.length) waiters.shift()();
};
await new Promise((res) => (ws.onopen = res));
log("WS /api/events.mux 已连接");

const waitFor = async (pred, timeoutMs, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = frameQueue.find(pred);
    if (hit) return hit;
    if (questionFrame && pred(questionFrame)) return questionFrame;
    await Promise.race([new Promise((r) => waiters.push(r)), new Promise((r) => setTimeout(r, 200))]);
  }
  throw new Error(`等待 ${what} 超时（${timeoutMs}ms）`);
};

// ---------- 5. session.prompt（要求提问） ----------
const PROMPT = "这是协议验证任务。你必须调用 ask_user_question 工具向我提一个问题（问题：今天想喝什么饮料？给出 2-3 个选项）。如果你不调用该工具、而是把问题写进文本回复，任务就算失败。等我回答后，用一句话回复我。";
const sent = await rpc("session.prompt", { sessionId, mode: "queue", content: [{ type: "text", text: PROMPT }] });
if (!sent.result?.ok) { console.error("[0.3] FAIL: session.prompt", JSON.stringify(sent)); cleanup(1); }
log("session.prompt 已发送，等待 agent 提问…");

// ---------- 6. 等 question/requested → respond ----------
try {
  await waitFor((f) => f.payload?.type === "question/requested", 120000, "question/requested");
} catch (e) {
  console.error(`[0.3] FAIL: ${e.message}`);
  console.error("已见事件:", [...seen].join(", "));
  console.error("agent 文本:", textParts.join("").slice(0, 800));
  console.error("agent reasoning 摘要:", reasoningParts.join("").slice(0, 800));
  cleanup(1);
}
const q = questionFrame.questions[0];
log(`收到提问: [${q.id}] ${q.question}${q.options?.length ? "（选项: " + q.options.map((o) => o.label).join(" / ") + "）" : ""}`);

const answerValue = {
  sessionId,
  answer: { answers: [{ id: q.id, selected: ["奶茶"], custom: undefined }] },
};
const respondRes = await fetch(`${url}/api/respond`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "client-response", rpcId: questionFrame.rpcId, result: { ok: true, value: answerValue } }),
});
log(`/api/respond -> HTTP ${respondRes.status}`);

// ---------- 7. 等 question/resolved + agent 继续输出 ----------
let resolved = null;
try {
  resolved = await waitFor((f) => f.payload?.type === "question/resolved", 30000, "question/resolved");
} catch (e) {
  console.error(`[0.3] FAIL: ${e.message}`);
  cleanup(1);
}
log(`question/resolved: outcome=${resolved.payload.outcome}`);

// 等 agent 的最终文本输出（含回答内容）
try {
  await waitFor(() => textParts.join("").includes("奶茶"), 90000, "agent 引用回答的最终文本");
} catch (e) {
  console.error(`[0.3] FAIL: ${e.message}`);
  console.error("已见事件:", [...seen].join(", "));
  console.error("agent 文本:", textParts.join("").slice(0, 500));
  cleanup(1);
}

const finalText = textParts.join("");
log(`PASS: 提问闭环完整跑通`);
log(`agent 最终回复: ${finalText.slice(0, 200)}`);
log(`事件流摘要: ${[...seen].slice(0, 20).join(", ")}${seen.size > 20 ? "…" : ""}`);

cleanup(0);

function cleanup(code) {
  try { ws?.close(); } catch {}
  killChild();
  if (dshHome) rmSync(dshHome, { recursive: true, force: true });
  // 清理测试会话归档（~/.dsh/sessions/--<tmp-cwd>--）与临时 cwd
  try {
    const sessionDir = join(homedir(), ".dsh", "sessions", `--${cwd.replace(/\//g, "-")}--`);
    if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
  } catch {}
  rmSync(cwd, { recursive: true, force: true });
  process.exit(code);
}

function killChild() {
  if (!child || child.exitCode !== null) return;
  try {
    if (child.pid !== undefined && process.platform !== "win32") {
      // 杀整个进程组（含孙进程）
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {}
  setTimeout(() => {
    try {
      if (child.exitCode === null) {
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      }
    } catch {}
  }, 1500).unref();
}

// 兜底：任何退出路径（正常/异常/信号）都清理子进程，防止孤儿
for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { try { killChild(); } catch {} });
}
