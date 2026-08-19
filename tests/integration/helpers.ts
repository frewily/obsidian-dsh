/**
 * 集成测试共享辅助：真实 dsh 进程管理（URL 解析、进程组清理）。
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface DshServer {
  child: ChildProcess;
  url: string;
  port: number;
  kill(): void;
}

export function spawnDsh(dshBin: string, cwd: string, port: number, timeoutMs = 30000): Promise<DshServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(dshBin, ["web", "--port", String(port), "--host", "127.0.0.1"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let buf = "";
    const timeout = setTimeout(() => reject(new Error("dsh 启动超时")), timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      buf += String(d);
      const m = buf.match(/^dsh web: (https?:\/\/\S+)/m);
      if (m) {
        clearTimeout(timeout);
        const server: DshServer = {
          child,
          url: m[1],
          port,
          kill: () => {
            try {
              if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {}
          },
        };
        resolve(server);
      }
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

export async function waitFor<T>(pred: () => T | null | false, timeoutMs = 60000, what = "条件"): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待 ${what} 超时（${timeoutMs}ms）`);
}
