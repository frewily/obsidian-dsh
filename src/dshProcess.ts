/**
 * dsh 进程管理器：spawn `dsh web --port 0`，解析 stdout URL，
 * 维护生命周期状态机，支持崩溃退避重启与进程组清理。
 *
 * 设计依据（开发文档 6.1 / M0 报告）：
 * - `dsh web --port 0` 由系统分配端口，就绪后 stdout 打印 `dsh web: http://127.0.0.1:<port>`
 * - 独立进程组（detached）便于中断时整体清理，防孤儿进程
 * - 60 秒窗口内连续失败 5 次放弃重启
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseDshUrlLine } from "./urlParse";

export type DshProcessState = "stopped" | "starting" | "running" | "restarting" | "stopping";

export interface DshProcessConfig {
  /** dsh 可执行文件路径；留空使用 PATH 中的 dsh。 */
  binaryPath?: string;
  /** 工作目录（vault 根目录）。 */
  cwd: string;
  /** 独立 DSH_HOME；留空复用默认 ~/.dsh（凭证自动可用，见 M0 F1）。 */
  dshHome?: string;
  /**
   * 推荐的启动方式（绕过 Obsidian 受限 PATH 与 shebang 问题）：
   * nodePath + dshEntry 同时提供时，以 `node <dshEntry> web ...` 启动。
   */
  nodePath?: string;
  /** dsh 的 lib/bin.js 入口（由 detectDshEnv 检测）。 */
  dshEntry?: string;
  /** 崩溃后自动重启，默认 true。 */
  restartOnCrash?: boolean;
  /** 等待 URL 行出现的超时（毫秒），默认 30000。 */
  urlTimeoutMs?: number;
  /** 时间窗口内的最大重启次数，默认 5。 */
  maxRestarts?: number;
  /** 重启计数窗口（毫秒），默认 60000。 */
  restartWindowMs?: number;
  /** 退避起始（毫秒），默认 500。 */
  backoffBaseMs?: number;
  /** 退避上限（毫秒），默认 10000。 */
  backoffMaxMs?: number;
}

export interface DshProcessEvents {
  onStateChange?: (state: DshProcessState) => void;
  onUrl?: (url: string) => void;
  onError?: (message: string) => void;
  /** 调试用：进程 stdout 原文。 */
  onStdout?: (chunk: string) => void;
}

/** 可注入的 spawn 产物接口（单测 mock 用）。 */
export interface ChildProcessLike {
  pid?: number;
  exitCode: number | null;
  stdout: { on(event: "data", cb: (d: string | Buffer) => void): void };
  stderr: { on(event: "data", cb: (d: string | Buffer) => void): void };
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal?: string): boolean;
}

type SpawnFn = (command: string, args: string[], options: Record<string, unknown>) => ChildProcessLike;

const DEFAULT_CONFIG: Required<Omit<DshProcessConfig, "binaryPath" | "cwd" | "dshHome" | "nodePath" | "dshEntry">> = {
  restartOnCrash: true,
  urlTimeoutMs: 30000,
  maxRestarts: 5,
  restartWindowMs: 60000,
  backoffBaseMs: 500,
  backoffMaxMs: 10000,
};

export class DshProcessManager {
  private readonly config: DshProcessConfig & Required<Omit<DshProcessConfig, "binaryPath" | "dshHome" | "nodePath" | "dshEntry">>;
  private readonly events: DshProcessEvents;
  private readonly spawnFn: SpawnFn;

  private child: ChildProcessLike | null = null;
  private state: DshProcessState = "stopped";
  private url: string | null = null;
  private stopRequested = false;
  private failureTimes: number[] = [];
  private restartAttempt = 0;
  private urlTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stdoutBuffer = "";

  constructor(config: DshProcessConfig, events: DshProcessEvents = {}, spawnFn?: SpawnFn) {
    if (!config.cwd) throw new Error("dshProcess: cwd is required");
    this.config = { ...DEFAULT_CONFIG, ...config, binaryPath: config.binaryPath ?? "dsh", cwd: config.cwd };
    this.events = events;
    this.spawnFn = spawnFn ?? ((command, args, options) => spawn(command, args, options) as unknown as ChildProcessLike);
  }

  getState(): DshProcessState {
    return this.state;
  }

  getUrl(): string | null {
    return this.url;
  }

  /** 启动进程。已在运行或启动中则忽略。 */
  start(): void {
    if (this.state !== "stopped") return;
    this.stopRequested = false;
    this.restartAttempt = 0;
    this.spawnProcess();
  }

  /** 主动停止：SIGTERM，2 秒未退出则 SIGKILL。 */
  stop(): void {
    if (this.state === "stopped") return;
    this.stopRequested = true;
    this.clearTimers();
    this.setState("stopping");
    this.killChild("SIGTERM");
    // SIGKILL 兜底
    setTimeout(() => {
      if (this.child !== null && (this.child.exitCode ?? null) === null) {
        this.killChild("SIGKILL");
      }
    }, 2000).unref();
  }

  private spawnProcess(): void {
    const cwd = this.config.cwd;
    const dshHome = this.config.dshHome;
    // 推荐路径：node <bin.js>（绕过 Obsidian 受限 PATH 的 shebang 解析）
    const useNodeEntry = Boolean(this.config.nodePath && this.config.dshEntry);
    const command = useNodeEntry ? (this.config.nodePath as string) : (this.config.binaryPath ?? "dsh");
    const args = useNodeEntry
      ? [this.config.dshEntry as string, "web", "--port", "0", "--host", "127.0.0.1"]
      : ["web", "--port", "0", "--host", "127.0.0.1"];
    const opts: Record<string, unknown> = {
      cwd,
      env: dshHome ? { ...process.env, DSH_HOME: dshHome } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    };
    // Windows：.cmd/.bat 包装器需经 shell 启动
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);

    this.setState("starting");
    this.url = null;
    this.stdoutBuffer = "";
    this.child = this.spawnFn(command, args, { ...opts, shell });

    const child = this.child;
    child.stdout?.on("data", (d: string | Buffer) => {
      const text = String(d);
      this.stdoutBuffer += text;
      this.events.onStdout?.(text);
      if (this.url === null) {
        const found = parseDshUrlLine(this.stdoutBuffer);
        if (found) this.onUrlFound(found);
      }
    });
    child.stderr?.on("data", () => {
      /* stderr 仅用于诊断，忽略 */
    });
    child.on("exit", (code: number | null) => this.onExit(code));
    // spawn 失败（如 ENOENT：二进制不存在）不会触发 exit，必须单独处理，
    // 否则状态永远卡在 starting（Obsidian 受限 PATH 下的真实故障）。
    child.on("error", (err: Error) => {
      this.events.onError?.(`dsh 启动失败: ${err.message}`);
      this.child = null;
      this.onExit(null);
    });

    // URL 超时兜底：30 秒未就绪视为一次失败
    this.urlTimer = setTimeout(() => {
      if (this.state === "starting" && this.url === null) {
        this.events.onError?.(`dsh 启动超时（${this.config.urlTimeoutMs}ms 未捕获 URL 行）`);
        this.killChild("SIGKILL");
      }
    }, this.config.urlTimeoutMs);
  }

  private onUrlFound(url: string): void {
    this.url = url;
    if (this.urlTimer) {
      clearTimeout(this.urlTimer);
      this.urlTimer = null;
    }
    this.setState("running");
    this.events.onUrl?.(url);
  }

  private onExit(code: number | null): void {
    this.clearUrlTimer();
    if (this.stopRequested || this.state === "stopping" || this.state === "stopped") {
      this.child = null;
      this.setState("stopped");
      return;
    }
    // 异常退出 → 记录失败并决定是否重启。
    // 失败计数由时间窗口管理（窗口内无新失败自然过期，退避随之重置）；
    // 不在 running 时清空——否则"起来就崩"的循环永远不会触发重启上限。
    const now = Date.now();
    this.failureTimes = this.failureTimes.filter((t) => now - t < this.config.restartWindowMs);
    if (this.failureTimes.length === 0) this.restartAttempt = 0;
    this.failureTimes.push(now);
    this.child = null;
    this.url = null;

    if (!this.config.restartOnCrash || this.failureTimes.length > this.config.maxRestarts) {
      this.setState("stopped");
      this.events.onError?.(`dsh 进程退出（code ${code ?? "?"}），已超过重启上限（${this.config.maxRestarts} 次 / ${this.config.restartWindowMs}ms），停止重试`);
      return;
    }

    this.restartAttempt += 1;
    const backoff = Math.min(this.config.backoffMaxMs, this.config.backoffBaseMs * 2 ** (this.restartAttempt - 1));
    this.setState("restarting");
    this.events.onError?.(`dsh 进程退出（code ${code ?? "?"}），${backoff}ms 后第 ${this.restartAttempt} 次重启`);
    this.restartTimer = setTimeout(() => {
      if (!this.stopRequested) this.spawnProcess();
    }, backoff);
  }

  private killChild(signal: "SIGTERM" | "SIGKILL"): void {
    const child = this.child;
    if (child === null) return;
    try {
      if (process.platform !== "win32" && child.pid !== undefined) {
        // 杀整个进程组（含孙进程），防孤儿
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      /* 进程可能已退出 */
    }
  }

  private setState(state: DshProcessState): void {
    this.state = state;
    this.events.onStateChange?.(state);
  }

  private clearUrlTimer(): void {
    if (this.urlTimer) {
      clearTimeout(this.urlTimer);
      this.urlTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearUrlTimer();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
}

/** 供类型使用（避免未引用告警）。 */
export type { ChildProcessWithoutNullStreams };
