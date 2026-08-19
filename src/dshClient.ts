/**
 * DSH Web 协议客户端（零依赖：原生 fetch + WebSocket）。
 *
 * 职责（开发文档 6.2 / M0 报告）：
 * - 上行 RPC：HTTP POST /api/<method>（client-request 信封）
 * - 下行事件：WS /api/events.mux 与 /api/events.host（server-request 帧，下行 only）
 * - 提问闭环：question/requested → /api/respond（client-response 信封）→ question/resolved
 * - 断线重连：任一通道断开即整体重连（指数退避）
 */

import {
  type AskUserQuestionAnswer,
  type HostFrame,
  isServerRequestFrame,
  makeClientRequest,
  type MuxFrame,
  type RpcError,
  type ServerRequestFrame,
} from "./protocolTypes";

export type DshClientConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface DshClientConfig {
  /** 服务根地址，如 http://127.0.0.1:64988 */
  baseUrl: string;
  /** 重连退避起始（毫秒），默认 500。 */
  backoffBaseMs?: number;
  /** 重连退避上限（毫秒），默认 10000。 */
  backoffMaxMs?: number;
}

export interface DshClientEvents {
  onStateChange?: (state: DshClientConnectionState) => void;
  onMuxFrame?: (frame: ServerRequestFrame<MuxFrame>) => void;
  onHostFrame?: (frame: ServerRequestFrame<HostFrame>) => void;
}

/** 可注入依赖（单测用）。 */
export interface DshClientDeps {
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  randomUUID?: () => string;
}

export class DshRpcError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(error: RpcError) {
    super(error.message);
    this.name = "DshRpcError";
    this.code = error.code;
    this.details = error.details;
  }
}

const DEFAULT_CONFIG: Required<Pick<DshClientConfig, "backoffBaseMs" | "backoffMaxMs">> = {
  backoffBaseMs: 500,
  backoffMaxMs: 10000,
};

export class DshClient {
  private readonly config: DshClientConfig & Required<Pick<DshClientConfig, "backoffBaseMs" | "backoffMaxMs">>;
  private readonly events: DshClientEvents;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly uuid: () => string;

  private state: DshClientConnectionState = "disconnected";
  private running = false;
  private attempt = 0;
  private muxWs: WebSocket | null = null;
  private hostWs: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private generation = 0;

  constructor(config: DshClientConfig, events: DshClientEvents = {}, deps: DshClientDeps = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = events;
    this.fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
    this.WebSocketImpl = deps.WebSocketImpl ?? WebSocket;
    this.uuid = deps.randomUUID ?? (() => crypto.randomUUID());
  }

  getState(): DshClientConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  /** 启动连接循环并等待首次连接成功（超时抛错）。 */
  async connect(timeoutMs = 30000): Promise<void> {
    if (this.running) {
      await this.connectPromise;
      return;
    }
    this.running = true;
    this.attempt = 0;
    this.connectPromise = this.loop();
    const t0 = Date.now();
    while (this.running && this.state !== "connected") {
      if (Date.now() - t0 > timeoutMs) {
        this.running = false;
        this.closeSockets();
        this.setState("disconnected");
        throw new Error(`dshClient: 连接超时（${timeoutMs}ms）`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.state !== "connected") throw new Error("dshClient: 连接失败");
  }

  /** 停止连接循环并关闭通道。 */
  async disconnect(): Promise<void> {
    this.running = false;
    this.closeSockets();
    this.setState("disconnected");
  }

  // ---------- 上行 RPC ----------

  /** 通用 RPC：成功返回 result.value，失败抛 DshRpcError。 */
  async call<T = unknown>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const req = makeClientRequest(method, payload, this.uuid());
    const res = await this.fetchImpl(`${this.config.baseUrl}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
    const body: unknown = await res.json();
    if (!isServerResponse(body)) {
      throw new Error(`dshClient: ${method} 响应格式异常（HTTP ${res.status}）`);
    }
    if (!body.result.ok) throw new DshRpcError(body.result.error);
    return body.result.value as T;
  }

  /** 提问回传：respond 的 rpcId 必须等于 question/requested 帧的 rpcId。 */
  async respondQuestion(rpcId: string, sessionId: string, answer: AskUserQuestionAnswer): Promise<void> {
    const res = await this.fetchImpl(`${this.config.baseUrl}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-response",
        rpcId,
        result: { ok: true, value: { sessionId, answer } },
      }),
    });
    if (!res.ok) throw new Error(`dshClient: respond 失败（HTTP ${res.status}）`);
  }

  // ---------- 连接循环 ----------

  private async loop(): Promise<void> {
    while (this.running) {
      const gen = ++this.generation;
      this.setState("connecting");
      try {
        const mux = await this.openSocket<MuxFrame>(`${this.wsUrl()}/api/events.mux`, (frame) => {
          if (gen === this.generation) this.events.onMuxFrame?.(frame);
        });
        const host = await this.openSocket<HostFrame>(`${this.wsUrl()}/api/events.host`, (frame) => {
          if (gen === this.generation) this.events.onHostFrame?.(frame);
        });
        if (!this.running || gen !== this.generation) {
          mux.close();
          host.close();
          return;
        }
        this.muxWs = mux;
        this.hostWs = host;
        // 就绪握手（对齐 ConnectionController 的 host.describe）
        await this.call("host.describe", {});
        if (!this.running || gen !== this.generation) return;
        this.attempt = 0;
        this.setState("connected");
        await this.waitForAnyClose(mux, host);
        if (!this.running || gen !== this.generation) return;
      } catch {
        /* 连接失败或握手失败 → 进入退避重连 */
      }
      if (!this.running || gen !== this.generation) return;
      this.setState("reconnecting");
      this.attempt += 1;
      await this.sleep(this.backoffDelay(this.attempt));
    }
    this.setState("disconnected");
  }

  private openSocket<F>(
    url: string,
    onFrame: (frame: ServerRequestFrame<F>) => void
  ): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(url);
      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`dshClient: WebSocket 打开超时: ${url}`));
      }, 10000);
      ws.onopen = () => {
        clearTimeout(timeout);
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(`dshClient: WebSocket 连接失败: ${url}`));
      };
      ws.onmessage = (ev: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (isServerRequestFrame(parsed)) onFrame(parsed as ServerRequestFrame<F>);
      };
    });
  }

  private waitForAnyClose(mux: WebSocket, host: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      const done = () => resolve();
      mux.onclose = done;
      mux.onerror = done;
      host.onclose = done;
      host.onerror = done;
    });
  }

  private closeSockets(): void {
    for (const ws of [this.muxWs, this.hostWs]) {
      if (ws) {
        try {
          ws.onclose = null;
          ws.close();
        } catch {}
      }
    }
    this.muxWs = null;
    this.hostWs = null;
  }

  private wsUrl(): string {
    return this.config.baseUrl.replace(/^http/, "ws");
  }

  private backoffDelay(attempt: number): number {
    const { backoffBaseMs, backoffMaxMs } = this.config;
    const cap = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, attempt - 1));
    return Math.round(cap / 2 + Math.random() * (cap / 2));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private setState(state: DshClientConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange?.(state);
  }
}

function isServerResponse(x: unknown): x is { type: "server-response"; rpcId: string; result: { ok: true; value?: unknown } | { ok: false; error: RpcError } } {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { type?: unknown }).type === "server-response" &&
    typeof (x as { rpcId?: unknown }).rpcId === "string" &&
    typeof (x as { result?: unknown }).result === "object"
  );
}
