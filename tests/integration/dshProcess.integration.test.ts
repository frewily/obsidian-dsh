import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DshProcessManager } from "../../src/dshProcess";

/**
 * 集成测试：真实 spawn dsh web。
 * 需要本机安装 dsh（DSH_BIN 或 PATH）；CI 环境无 dsh 时自动跳过。
 * 覆盖：URL 解析、HTTP 200、stop 后进程组清理（无残留）。
 */

const dshBin = process.env.DSH_BIN ?? "dsh";
let dshAvailable = true;
try {
  execFileSync(dshBin, ["--version"], { stdio: "ignore", timeout: 10000 });
} catch {
  dshAvailable = false;
}

const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-m1-int-"));
const tmpHome = join(tmpRoot, "home");
const tmpCwd = join(tmpRoot, "cwd");
for (const dir of [tmpHome, tmpCwd]) {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(dir, { recursive: true });
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const describeIntegration = dshAvailable ? describe : describe.skip;

describeIntegration("DshProcessManager 集成（真实 dsh）", () => {
  it("启动 → 捕获 URL → HTTP 200 → stop 后无残留进程", async () => {
    const states: string[] = [];
    let url: string | null = null;
    const errors: string[] = [];

    const manager = new DshProcessManager(
      {
        binaryPath: dshBin,
        cwd: tmpCwd,
        dshHome: tmpHome,
        urlTimeoutMs: 30000,
        backoffBaseMs: 200,
      },
      {
        onStateChange: (s) => states.push(s),
        onUrl: (u) => (url = u),
        onError: (m) => errors.push(m),
      }
    );

    manager.start();

    // 等待 running
    const deadline = Date.now() + 40000;
    while (states[states.length - 1] !== "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(states[states.length - 1]).toBe("running");
    expect(url).toBeTruthy();
    expect(errors).toHaveLength(0);

    // HTTP 200
    const res = await fetch(url as string);
    expect(res.status).toBe(200);

    // stop → 干净退出
    manager.stop();
    await new Promise((r) => setTimeout(r, 3000));
    expect(states[states.length - 1]).toBe("stopped");

    // 无残留：端口不再监听（HTTP 请求应失败）
    await expect(fetch(url as string)).rejects.toThrow();
  });
});
