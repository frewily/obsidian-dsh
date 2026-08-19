import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DshClient } from "../../src/dshClient";
import type { AskUserQuestionItem, MuxFrame, ServerRequestFrame, SessionCreateValue } from "../../src/protocolTypes";

/**
 * 集成测试：真实 dsh + DshClient。
 * 复用真实 ~/.dsh（凭证自动加载，见 M0 F1）；cwd 用临时目录。
 * CI 环境无 dsh 时自动跳过。
 */

const dshBin = process.env.DSH_BIN ?? "dsh";
let dshAvailable = true;
try {
  execFileSync(dshBin, ["--version"], { stdio: "ignore", timeout: 10000 });
} catch {
  dshAvailable = false;
}

const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-m2-int-"));
const tmpCwd = join(tmpRoot, "cwd");
mkdirSync(tmpCwd, { recursive: true });

const servers: Array<{ child: ChildProcess; port: number }> = [];

function spawnDsh(port: number): Promise<{ child: ChildProcess; url: string; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(dshBin, ["web", "--port", String(port), "--host", "127.0.0.1"], {
      cwd: tmpCwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    servers.push({ child, port });
    let buf = "";
    const timeout = setTimeout(() => reject(new Error("dsh 启动超时")), 30000);
    child.stdout?.on("data", (d: Buffer) => {
      buf += String(d);
      const m = buf.match(/^dsh web: (https?:\/\/\S+)/m);
      if (m) {
        clearTimeout(timeout);
        resolve({ child, url: m[1], port });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

function killServer(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {}
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitFor<T>(pred: () => T | null | false, timeoutMs = 60000, what = "条件"): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待 ${what} 超时（${timeoutMs}ms）`);
}

const PROMPT =
  "这是协议验证任务。你必须调用 ask_user_question 工具向我提一个问题（问题：今天想喝什么饮料？给出 2-3 个选项）。" +
  "如果你不调用该工具、而是把问题写进文本回复，任务就算失败。等我回答后，用一句话回复我。";

afterAll(() => {
  for (const s of servers) killServer(s.child);
  // 清理临时 cwd 及其会话归档
  try {
    const sessionDir = join(process.env.HOME ?? "", ".dsh", "sessions", `--${tmpCwd.replace(/\//g, "-")}--`);
    rmSync(sessionDir, { recursive: true, force: true });
  } catch {}
  rmSync(tmpRoot, { recursive: true, force: true });
});

const describeIntegration = dshAvailable ? describe : describe.skip;

describeIntegration("DshClient 集成（真实 dsh）", () => {
  it("连接 → 完整对话 → 提问闭环 → 干净断开", async () => {
    const server = await spawnDsh(0);
    const events: unknown[] = [];
    let questionFrame: (ServerRequestFrame & { payload: MuxFrame & { type: "question/requested" } }) | null = null;
    const textParts: string[] = [];
    let resolvedOutcome: string | null = null;

    const client = new DshClient(
      { baseUrl: server.url, backoffBaseMs: 200 },
      {
        onMuxFrame: (frame) => {
          events.push(frame);
          const p = frame.payload;
          if (p.type === "question/requested") questionFrame = frame as never;
          if (p.type === "question/resolved") resolvedOutcome = p.outcome;
          if (p.type === "session/event" && p.event?.type === "assistant/chunk") {
            const chunk = p.event.data?.chunk as { type?: string; text?: string } | undefined;
            if (chunk?.type === "text-delta") textParts.push(chunk.text ?? "");
          }
        },
      }
    );

    try {
      await client.connect(30000);
      expect(client.isConnected()).toBe(true);

      // 握手
      const desc = await client.call<{ version: string }>("host.describe", {});
      expect(desc).toBeTruthy();

      // 建会话
      const created = await client.call<SessionCreateValue>("session.create", { cwd: tmpCwd });
      const sessionId = created.sessionId;
      expect(sessionId).toBeTruthy();

      // 发送要求提问的任务
      await client.call("session.prompt", { sessionId, mode: "queue", content: [{ type: "text", text: PROMPT }] });

      // 等提问帧
      const q = await waitFor(() => questionFrame, 90000, "question/requested");
      const item: AskUserQuestionItem = q.payload.questions[0];
      expect(item.question).toBeTruthy();

      // 回传答案
      await client.respondQuestion(q.rpcId, sessionId, {
        answers: [{ id: item.id, selected: ["奶茶"] }],
      });

      // 等 resolved + agent 文本包含答案（LLM 轮次可能较慢，放宽超时）
      try {
        await waitFor(() => resolvedOutcome === "answered", 60000, "question/resolved");
      } catch (e) {
        const types = (events as Array<{ payload?: { type?: string } }>).map((f) => f.payload?.type ?? "?").join(", ");
        const text = textParts.join("");
        console.error(`[diag] resolved 超时。帧类型: ${types}`);
        console.error(`[diag] agent 文本: ${text.slice(0, 300)}`);
        throw e;
      }
      const finalText = await waitFor(() => (textParts.join("").includes("奶茶") ? textParts.join("") : null), 90000, "agent 引用回答的最终文本");
      expect(finalText).toContain("奶茶");
    } finally {
      await client.disconnect();
      killServer(server.child);
    }
  });

  it("断线重连：后端被杀 → reconnecting → 同端口重启 → connected", async () => {
    const port = await getFreePort();
    const server1 = await spawnDsh(port);
    const states: string[] = [];

    const client = new DshClient(
      { baseUrl: `http://127.0.0.1:${port}`, backoffBaseMs: 200 },
      { onStateChange: (s) => states.push(s) }
    );

    try {
      await client.connect(30000);
      expect(client.isConnected()).toBe(true);

      // 杀掉后端
      killServer(server1.child);
      await waitFor(() => (states.includes("reconnecting") ? true : null), 30000, "reconnecting 状态");

      // 同端口重启后端
      await spawnDsh(port);
      await waitFor(() => (client.isConnected() ? true : null), 60000, "重连成功");
      expect(client.isConnected()).toBe(true);
    } finally {
      await client.disconnect();
    }
  });
});
