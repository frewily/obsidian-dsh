import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DshProcessManager, type ChildProcessLike, type DshProcessState } from "../src/dshProcess";

/** 可手动驱动的假子进程。 */
function makeFakeChild() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child: ChildProcessLike = {
    pid: undefined, // undefined → killChild 走 child.kill 分支（避免真 process.kill）
    exitCode: null,
    stdout: {
      on: (event, cb) => {
        if (event === "data") {
          const l = listeners.get("stdout") ?? [];
          l.push(cb as (...args: unknown[]) => void);
          listeners.set("stdout", l);
        }
      },
    },
    stderr: { on: () => {} },
    on: (event, cb) => {
      const l = listeners.get(event) ?? [];
      l.push(cb as (...args: unknown[]) => void);
      listeners.set(event, l);
    },
    kill: vi.fn(() => true),
  };
  return {
    child,
    emitStdout(text: string) {
      for (const cb of listeners.get("stdout") ?? []) cb(text);
    },
    emitExit(code: number | null) {
      child.exitCode = code;
      for (const cb of listeners.get("exit") ?? []) cb(code, null);
    },
  };
}

type FakeHandle = ReturnType<typeof makeFakeChild>;

/**
 * 注册 spawn mock：每次调用自动新建假子进程并收集，
 * 覆盖退避重启等多次 spawn 的时序。
 */
function setupSpawn(spawnMock: ReturnType<typeof vi.fn>): FakeHandle[] {
  const fakes: FakeHandle[] = [];
  spawnMock.mockImplementation(() => {
    const fake = makeFakeChild();
    fakes.push(fake);
    return fake.child;
  });
  return fakes;
}

function makeManager(overrides: Record<string, unknown> = {}) {
  const spawnMock = vi.fn();
  const states: DshProcessState[] = [];
  let url: string | null = null;
  const errors: string[] = [];
  const manager = new DshProcessManager(
    { cwd: "/tmp/fake-vault", ...overrides } as Parameters<typeof DshProcessManager.prototype.constructor>[0],
    {
      onStateChange: (s) => states.push(s),
      onUrl: (u) => (url = u),
      onError: (m) => errors.push(m),
    },
    spawnMock as never
  );
  return { manager, spawnMock, states: () => states, getUrl: () => url, errors };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DshProcessManager 状态机", () => {
  it("start → 解析 URL → running，并回调 onUrl", () => {
    const { manager, spawnMock, states, getUrl } = makeManager();
    const fakes = setupSpawn(spawnMock);
    manager.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(states()).toEqual(["starting"]);
    expect(spawnMock.mock.calls[0][0]).toBe("dsh");
    expect(spawnMock.mock.calls[0][1]).toEqual(["web", "--port", "0", "--host", "127.0.0.1"]);

    fakes[0].emitStdout("dsh web: http://127.0.0.1:12345\n");
    expect(states()).toEqual(["starting", "running"]);
    expect(getUrl()).toBe("http://127.0.0.1:12345");
  });

  it("stdout 跨 chunk 累积后解析 URL", () => {
    const { manager, spawnMock, states, getUrl } = makeManager();
    const fakes = setupSpawn(spawnMock);
    manager.start();
    fakes[0].emitStdout("dsh we");
    expect(getUrl()).toBeNull();
    fakes[0].emitStdout("b: http://127.0.0.1:4321\n");
    expect(states()).toEqual(["starting", "running"]);
    expect(getUrl()).toBe("http://127.0.0.1:4321");
  });

  it("重复 start 幂等（running 时忽略）", () => {
    const { manager, spawnMock } = makeManager();
    const fakes = setupSpawn(spawnMock);
    manager.start();
    fakes[0].emitStdout("dsh web: http://127.0.0.1:1\n");
    manager.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("running 中崩溃 → restarting → 退避后重新 spawn → starting", () => {
    const { manager, spawnMock, states } = makeManager({ backoffBaseMs: 500 });
    const fakes = setupSpawn(spawnMock);
    manager.start();
    fakes[0].emitStdout("dsh web: http://127.0.0.1:1\n");

    fakes[0].emitExit(1);
    expect(states()).toEqual(["starting", "running", "restarting"]);
    expect(spawnMock).toHaveBeenCalledTimes(1); // 退避期未到

    vi.advanceTimersByTime(500);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(states().slice(-1)).toEqual(["starting"]);
  });

  it("重启超限（maxRestarts=2）→ stopped + onError", () => {
    const { manager, spawnMock, states, errors } = makeManager({ maxRestarts: 2, backoffBaseMs: 100 });
    const fakes = setupSpawn(spawnMock);
    manager.start();
    for (let i = 0; i < 3; i++) {
      fakes[i].emitStdout(`dsh web: http://127.0.0.1:${i + 1}\n`);
      fakes[i].emitExit(1);
      // 退避指数增长（100/200/400），一次性推进足够时间
      vi.advanceTimersByTime(1000);
    }
    expect(states().slice(-1)).toEqual(["stopped"]);
    expect(errors.some((m) => m.includes("重启上限"))).toBe(true);
  });

  it("stop() → SIGTERM → 子进程退出 → stopped", () => {
    const { manager, spawnMock, states } = makeManager();
    const fakes = setupSpawn(spawnMock);
    manager.start();
    fakes[0].emitStdout("dsh web: http://127.0.0.1:1\n");

    manager.stop();
    expect(fakes[0].child.kill).toHaveBeenCalledWith("SIGTERM");
    fakes[0].emitExit(0);
    expect(states().slice(-1)).toEqual(["stopped"]);
  });

  it("stop() 后子进程 2 秒未退出 → SIGKILL 兜底", () => {
    const { manager, spawnMock } = makeManager();
    const fakes = setupSpawn(spawnMock);
    manager.start();
    manager.stop();
    vi.advanceTimersByTime(2000);
    expect(fakes[0].child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("stop 后不重启（stopRequested 抑制 onExit 重启逻辑）", () => {
    const { manager, spawnMock, states } = makeManager();
    const fakes = setupSpawn(spawnMock);
    manager.start();
    fakes[0].emitStdout("dsh web: http://127.0.0.1:1\n");
    manager.stop();
    fakes[0].emitExit(1);
    expect(states().slice(-1)).toEqual(["stopped"]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("URL 超时（urlTimeoutMs=200）未就绪 → 按失败处理并重启", () => {
    const { manager, spawnMock, states } = makeManager({ urlTimeoutMs: 200, backoffBaseMs: 100 });
    const fakes = setupSpawn(spawnMock);
    manager.start();
    vi.advanceTimersByTime(200); // 超时 → SIGKILL
    expect(fakes[0].child.kill).toHaveBeenCalledWith("SIGKILL");
    fakes[0].emitExit(null);

    vi.advanceTimersByTime(100);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(states().slice(-1)).toEqual(["starting"]);
    fakes[1].emitStdout("dsh web: http://127.0.0.1:9\n");
    expect(states().slice(-1)).toEqual(["running"]);
  });

  it("独立 DSH_HOME 传入环境变量", () => {
    const { manager, spawnMock } = makeManager({ dshHome: "/tmp/iso-home" });
    const fakes = setupSpawn(spawnMock);
    manager.start();
    const env = spawnMock.mock.calls[0][2].env as Record<string, string>;
    expect(env.DSH_HOME).toBe("/tmp/iso-home");
  });

  it("Windows .cmd 包装器以 shell 启动", () => {
    // 模拟 win32（仅断言参数构造，不实际执行）
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { manager, spawnMock } = makeManager({ binaryPath: "C:\\dsh.cmd" });
      const fakes = setupSpawn(spawnMock);
      manager.start();
      expect(spawnMock.mock.calls[0][2].shell).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", origPlatform ?? { value: "darwin" });
    }
  });
});
