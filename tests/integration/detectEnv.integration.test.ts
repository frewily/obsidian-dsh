import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectDshEnv } from "../../src/detectEnv";

/**
 * 集成测试：真实环境下检测 node 与 dsh 入口。
 * 本机必须有 node + 全局 dsh（CI 无 dsh 时跳过）。
 */

const dshBin = process.env.DSH_BIN ?? "dsh";
let dshAvailable = true;
try {
  execFileSync(dshBin, ["--version"], { stdio: "ignore", timeout: 10000 });
} catch {
  dshAvailable = false;
}

const describeIntegration = dshAvailable ? describe : describe.skip;

describeIntegration("detectDshEnv 集成（真实环境）", () => {
  it("检测到 node 与 dsh 且路径真实存在", async () => {
    const env = await detectDshEnv();
    expect(env).not.toBeNull();
    expect(env?.nodePath).toBeTruthy();
    expect(env?.dshEntry).toBeTruthy();
    expect(() => statSync(env!.nodePath)).not.toThrow();
    expect(() => statSync(env!.dshEntry)).not.toThrow();
  });
});
