/**
 * DSH Web 协议客户端（零依赖：node:http + 手写 WebSocket）。
 *
 * 职责（开发文档 6.2 / M0 报告 / 阶段 3 排障）：
 * - 上行 RPC：HTTP POST /api/<method>（client-request 信封）
 * - 下行事件：WS /api/events.mux 与 /api/events.host（server-request 帧，下行 only）
 * - 提问闭环：question/requested → /api/respond（client-response 信封）→ question/resolved
 * - 断线重连：任一通道断开即整体重连（指数退避）
 *
 * 传输层为何不用全局 fetch / WebSocket：
 * Obsidian/Chromium 会为请求自动附加页面 Origin 头（app://obsidian.md），
 * 与 DSH 的 Host 127.0.0.1 不匹配，被 isTrustedApiRequest 拒绝（403）。
 * 改用 node:http 直连（握手显式 Host、不带 Origin）即可通过信任检查。
 */

import { randomBytes, randomUUID } from "node:crypto";
import * as http from "node:http";
import type { Socket } from "node:net";
import {
  type AskUserQuestionAnswer,
  type HostFrame,
  isServerRequestFrame,
  makeClientRequest,
  type MuxFrame,
  type RpcError,
  type ServerRequestFrame,
} from "./protocolTypes";
import { encodeClientFrame, WS_OP, WsFrameParser } from "./wsFrames";

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

interface HttpResponse {
  status: number;
  body: unknown;
}

/** 手写 WS 连接（服务端未 mask 单文本帧；握手不带 Origin）。 */
class WsSocket {
  private readonly parser = new WsFrameParser();
  private readonly socket: Socket;
  onFrame: ((payload: Buffer) => void) | null = null;
  onClose: (() => void) | null = null;
  closed = false;

  constructor(socket: Socket) {
    this.socket = socket;
    // upgrade 移交后 socket 处于 paused 状态，必须 resume 才能接收数据
    socket.resume();
    socket.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = this.parser.feed(chunk);
      } catch {
        this.close();
        return;
      }
      for (const frame of frames) this.handleFrame(frame);
    });
    socket.on("close", () => {
      this.closed = true;
      this.onClose?.();
    });
    socket.on("error", () => {
      this.closed = true;
      this.onClose?.();
    });
  }

  private handleFrame(frame: { opcode: number; payload: Buffer }): void {
    switch (frame.opcode) {
      case WS_OP.TEXT:
        this.onFrame?.(frame.payload);
        break;
      case WS_OP.PING:
        this.send(WS_OP.PONG, frame.payload);
        break;
      case WS_OP.CLOSE:
        this.close();
        break;
      default:
        break; // CONTINUATION/BINARY 忽略（dsh 为单文本帧）
    }
  }

  send(opcode: number, payload: Buffer | string): void {
    if (this.closed) return;
    this.socket.write(encodeClientFrame(opcode, payload));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {}
  }
}

export class DshClient {
  private readonly config: DshClientConfig & Required<Pick<DshClientConfig, "backoffBaseMs" | "backoffMaxMs">>;
  private readonly events: DshClientEvents;
  private readonly muxListeners = new Set<(frame: ServerRequestFrame<unknown>) => void>();
  private readonly hostListeners = new Set<(frame: ServerRequestFrame<unknown>) => void>();

  private state: DshClientConnectionState = "disconnected";
  private running = false;
  private attempt = 0;
  private muxWs: WsSocket | null = null;
  private hostWs: WsSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private generation = 0;

  constructor(config: DshClientConfig, events: DshClientEvents = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = events;
  }

  getState(): DshClientConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  /** 注册 mux 帧监听（返回取消函数）。 */
  addMuxListener(fn: (frame: ServerRequestFrame<MuxFrame>) => void): () => void {
    this.muxListeners.add(fn as (frame: ServerRequestFrame<unknown>) => void);
    return () => this.muxListeners.delete(fn as (frame: ServerRequestFrame<unknown>) => void);
  }

  /** 注册 host 帧监听（返回取消函数）。 */
  addHostListener(fn: (frame: ServerRequestFrame<HostFrame>) => void): () => void {
    this.hostListeners.add(fn as (frame: ServerRequestFrame<unknown>) => void);
    return () => this.hostListeners.delete(fn as (frame: ServerRequestFrame<unknown>) => void);
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
    const req = makeClientRequest(method, payload, randomUUID());
    const res = await this.httpJson(`/api/${method}`, req, signal);
    if (!isServerResponse(res.body)) {
      throw new Error(`dshClient: ${method} 响应格式异常（HTTP ${res.status}）`);
    }
    if (!res.body.result.ok) throw new DshRpcError(res.body.result.error);
    return res.body.result.value as T;
  }

  /** 提问回传：respond 的 rpcId 必须等于 question/requested 帧的 rpcId。 */
  async respondQuestion(rpcId: string, sessionId: string, answer: AskUserQuestionAnswer): Promise<void> {
    const res = await this.httpJson("/api/respond", {
      type: "client-response",
      rpcId,
      result: { ok: true, value: { sessionId, answer } },
    });
    if (res.status >= 400) throw new Error(`dshClient: respond 失败（HTTP ${res.status}）`);
  }

  // ---------- 连接循环 ----------

  private async loop(): Promise<void> {
    while (this.running) {
      const gen = ++this.generation;
      this.setState("connecting");
      try {
        const mux = await this.openWs("/api/events.mux", (payload) => {
          if (gen === this.generation) this.dispatchMux(payload);
        });
        const host = await this.openWs("/api/events.host", (payload) => {
          if (gen === this.generation) this.dispatchHost(payload);
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

  private dispatchMux(payload: Buffer): void {
    const frame = this.parseFrame(payload);
    if (!frame) return;
    this.events.onMuxFrame?.(frame as ServerRequestFrame<MuxFrame>);
    for (const fn of this.muxListeners) fn(frame);
  }

  private dispatchHost(payload: Buffer): void {
    const frame = this.parseFrame(payload);
    if (!frame) return;
    this.events.onHostFrame?.(frame as ServerRequestFrame<HostFrame>);
    for (const fn of this.hostListeners) fn(frame);
  }

  private parseFrame(payload: Buffer): ServerRequestFrame<unknown> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString("utf8"));
    } catch {
      return null;
    }
    return isServerRequestFrame(parsed) ? parsed : null;
  }

  private openWs(path: string, onPayload: (payload: Buffer) => void): Promise<WsSocket> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.baseUrl);
      const req = http.request({
        host: url.hostname,
        port: url.port,
        path,
        // Node 19+ 的 globalAgent 默认 keepAlive:true，会让 server.close 永久等待
        agent: false,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          host: url.host,
          // 故意不带 Origin —— 规避 DSH isTrustedApiRequest 的 origin 检查（阶段 3 根因）
        },
      });
      const timeout = setTimeout(() => {
        try {
          req.destroy();
        } catch {}
        reject(new Error(`dshClient: WebSocket 打开超时: ${path}`));
      }, 10000);
      req.on("upgrade", (_res: http.IncomingMessage, socket: Socket) => {
        clearTimeout(timeout);
        const ws = new WsSocket(socket);
        ws.onFrame = onPayload;
        resolve(ws);
      });
      req.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`dshClient: WebSocket 连接失败: ${path}（${err.message}）`));
      });
      req.end();
    });
  }

  private waitForAnyClose(mux: WsSocket, host: WsSocket): Promise<void> {
    return new Promise((resolve) => {
      const done = () => resolve();
      mux.onClose = done;
      host.onClose = done;
    });
  }

  private closeSockets(): void {
    for (const ws of [this.muxWs, this.hostWs]) {
      if (ws) {
        ws.onClose = null;
        ws.close();
      }
    }
    this.muxWs = null;
    this.hostWs = null;
  }

  private httpJson(path: string, body: unknown, signal?: AbortSignal): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.baseUrl);
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path,
          method: "POST",
          signal,
          // Node 19+ 的 globalAgent 默认 keepAlive:true，会让 server.close 永久等待
          agent: false,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            host: url.host,
          },
        },
        (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = undefined;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        }
      );
      req.on("error", (err) => reject(new Error(`dshClient: HTTP ${path} 失败（${err.message}）`)));
      req.write(payload);
      req.end();
    });
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
