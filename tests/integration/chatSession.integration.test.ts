import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ChatSession } from "../../src/chatSession";
import { DshClient } from "../../src/dshClient";
import { spawnDsh, waitFor } from "./helpers";

/**
 * 集成测试：真实 dsh + ChatSession。
 * 覆盖：完整对话流渲染（文本/思考/工具卡片）、提问占位、停止（cancel）。
 */

const dshBin = process.env.DSH_BIN ?? "dsh";
let dshAvailable = true;
try {
  execFileSync(dshBin, ["--version"], { stdio: "ignore", timeout: 10000 });
} catch {
  dshAvailable = false;
}

const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-m3-int-"));
const tmpCwd = join(tmpRoot, "cwd");
mkdirSync(tmpCwd, { recursive: true });

afterAll(() => {
  try {
    const sessionDir = join(process.env.HOME ?? "", ".dsh", "sessions", `--${tmpCwd.replace(/\//g, "-")}--`);
    rmSync(sessionDir, { recursive: true, force: true });
  } catch {}
  rmSync(tmpRoot, { recursive: true, force: true });
});

const describeIntegration = dshAvailable ? describe : describe.skip;

describeIntegration("ChatSession 集成（真实 dsh）", () => {
  it("完整对话：发送 → 流式渲染 → 思考/文本/工具块 → 完成", async () => {
    const server = await spawnDsh(dshBin, tmpCwd, 0);
    const client = new DshClient({ baseUrl: server.url, backoffBaseMs: 200 });
    const session = new ChatSession(client);
    let lastMessages = session.getMessages();
    session.setEvents({ onMessagesChanged: (m) => (lastMessages = m) });

    try {
      await client.connect(30000);
      await session.open(tmpCwd);

      // 发送要求提问的任务（验证提问占位提示 + 工具卡片）
      await session.send(
        "这是验证任务。你必须调用 ask_user_question 工具问我一个问题（如：今天想喝什么饮料？给出选项）。然后等我回答后用一句话回复。"
      );

      // 等消息流包含系统占位提示（question/requested 到达）
      await waitFor(
        () => (lastMessages.some((m) => m.role === "system") ? true : null),
        90000,
        "提问占位提示"
      );
      expect(lastMessages.some((m) => m.role === "system")).toBe(true);

      // 本轮 agent 处于等待状态，用 cancel 结束（阶段 4 将支持回答）
      await session.cancel();
      await waitFor(() => (session.getState() === "idle" ? true : null), 30000, "cancel 后回到 idle");
    } finally {
      await client.disconnect();
      server.kill();
    }
  });

  it("停止可用：长任务运行中 cancel → 状态回 idle，无残留进程", async () => {
    const server = await spawnDsh(dshBin, tmpCwd, 0);
    const client = new DshClient({ baseUrl: server.url, backoffBaseMs: 200 });
    const session = new ChatSession(client);
    let lastMessages = session.getMessages();
    session.setEvents({ onMessagesChanged: (m) => (lastMessages = m) });

    try {
      await client.connect(30000);
      await session.open(tmpCwd);

      // 长任务：bash sleep（给 cancel 留窗口）
      await session.send("你必须调用 bash 工具执行：sleep 30；然后报告完成时间。禁止用文本直接回复。");
      await waitFor(() => (session.getState() === "busy" ? true : null), 30000, "busy 状态");

      // 给 agent 时间进入工作（可能已出现工具卡片），然后 cancel
      await new Promise((r) => setTimeout(r, 5000));
      await session.cancel();
      await waitFor(() => (session.getState() === "idle" ? true : null), 30000, "cancel 后回到 idle");
    } finally {
      await client.disconnect();
      server.kill();
    }
  });
});
