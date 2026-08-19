/**
 * DSH Web 协议类型定义。
 *
 * 依据 M0 验证报告（docs/reports/M0.md）：协议在 `dsh-host-apiproxy` /
 * `dsh-client-connection` 源码与真实会话文件中核实。
 *
 * 传输模型：
 * - 上行：HTTP POST /api/<method>，body 为 client-request 信封
 * - 下行：WebSocket /api/events.mux（会话事件）与 /api/events.host（系统事件），
 *   帧为 server-request 信封（method = payload.type）；下行 only
 */

// ---------- RPC 信封 ----------

export interface RpcError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type RpcResult<T = unknown> =
  | { ok: true; value?: T }
  | { ok: false; error: RpcError };

export interface ClientRequest {
  type: "client-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

export interface ServerResponse<T = unknown> {
  type: "server-response";
  rpcId: string;
  result: RpcResult<T>;
}

export interface ServerRequestFrame<P = unknown> {
  type: "server-request";
  rpcId: string;
  method: string;
  payload: P;
}

export interface ClientResponse {
  type: "client-response";
  rpcId: string;
  result: RpcResult;
}

/** 上行请求的统一构造。 */
export function makeClientRequest(method: string, payload: unknown, rpcId: string = crypto.randomUUID()): ClientRequest {
  return { type: "client-request", rpcId, method, payload };
}

// ---------- 下行帧（mux / host） ----------

/** ask_user_question 单条问题（提问闭环核心）。 */
export interface AskUserQuestionItem {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** 提问回答负载（respond 的 value 内部结构）。 */
export interface AskUserQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>;
}

/** mux 通道帧（payload 槽位）。 */
export type MuxFrame =
  | { type: "session/event"; sessionId: string; event: SessionEvent; view?: unknown }
  | { type: "session/subscribed"; sessionId: string; lastSeq: number }
  | { type: "approval/requested"; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: "approval/resolved"; sessionId: string; approvalId: string; outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable" }
  | { type: "question/requested"; sessionId: string; questions: AskUserQuestionItem[] }
  | { type: "question/resolved"; sessionId: string; questionRpcId: string; outcome: "answered" | "cancelled" }
  | { type: "session/queue"; sessionId: string; items: unknown[] }
  | { type: "session/jobs"; sessionId: string; jobs: unknown[] }
  | { type: "session/projection"; sessionId: string; key: string; value: unknown; seq: number }
  | { type: "stream/error"; error: RpcError };

/** host 通道帧（宽结构，仅识别类型）。 */
export type HostFrame =
  | { type: "slots/changed"; payload?: unknown }
  | { type: "stream/error"; error: RpcError }
  | { type: string; [k: string]: unknown };

/** 会话事件（宽结构：类型驱动，data 透传）。 */
export interface SessionEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
}

// ---------- 会话 RPC 负载 ----------

export interface SessionCreateRequest {
  cwd?: string;
  workspaceId?: string;
  sessionId?: string;
  agentPreset?: string;
}

export interface SessionCreateValue {
  sessionId: string;
  agentPreset?: string;
}

export interface SessionPromptRequest {
  sessionId: string;
  mode: "queue" | "steer";
  content: Array<{ type: "text"; text: string } | { type: "image"; mediaType: string; data: string; name?: string }>;
  clientTimeZone?: string;
}

export interface QuestionResponsePayload {
  sessionId: string;
  answer: AskUserQuestionAnswer;
}

// ---------- 类型守卫 ----------

export function isServerRequestFrame(x: unknown): x is ServerRequestFrame {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { type?: unknown }).type === "server-request" &&
    typeof (x as { rpcId?: unknown }).rpcId === "string" &&
    typeof (x as { method?: unknown }).method === "string"
  );
}

export function isQuestionRequested(frame: ServerRequestFrame): frame is ServerRequestFrame<MuxFrame & { type: "question/requested" }> {
  return (frame.payload as { type?: string } | undefined)?.type === "question/requested";
}

export function isSessionEventFrame(frame: ServerRequestFrame): frame is ServerRequestFrame<MuxFrame & { type: "session/event" }> {
  return (frame.payload as { type?: string } | undefined)?.type === "session/event";
}
