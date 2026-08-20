/**
 * 聊天会话层：把 DshClient 的下行帧流翻译成消息列表状态机。
 *
 * 设计（开发文档 6.3 / M0 F2）：
 * - 事件→消息：user/message 追加用户消息；assistant/chunk 的
 *   data.chunk（block-start / reasoning-delta / text-delta / finish）驱动
 *   当前 assistant 消息的块渲染；tool/call + tool/result 渲染工具卡片
 * - 错误呈现：finish chunk 的 reason.kind === "error"（M0 F3）
 * - 提问占位：question/requested 在阶段 3 显示系统提示（阶段 4 做弹窗闭环）
 * - 帧处理通过 handleFrame(frame) 暴露，便于单测直接注入帧
 */

import type { DshClient } from "./dshClient";
import type { MuxFrame, ServerRequestFrame } from "./protocolTypes";

export type ChatBlockKind = "text" | "reasoning" | "tool";

export interface ChatBlock {
  kind: ChatBlockKind;
  /** text / reasoning 的增量累积文本。 */
  text?: string;
  /** tool 卡片。 */
  toolName?: string;
  toolArgs?: string;
  toolStatus?: "running" | "done" | "error";
  toolResult?: string;
}

export type ChatMessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  blocks: ChatBlock[];
  status: "streaming" | "done" | "error";
  error?: string;
}

export type ChatSessionState = "idle" | "busy";

export interface ChatSessionEvents {
  onMessagesChanged?: (messages: ChatMessage[]) => void;
  onSessionId?: (sessionId: string) => void;
  onStateChange?: (state: ChatSessionState) => void;
  onError?: (message: string) => void;
}

export class ChatSession {
  readonly client: DshClient;
  private readonly events: ChatSessionEvents;
  private readonly unsubscribe: () => void;
  private sessionId: string | null = null;
  private messages: ChatMessage[] = [];
  private state: ChatSessionState = "idle";
  private currentAssistant: ChatMessage | null = null;
  private msgSeq = 0;

  constructor(client: DshClient, events: ChatSessionEvents = {}) {
    this.client = client;
    this.events = events;
    // 订阅 mux 帧流（帧入口）
    this.unsubscribe = client.addMuxListener((frame) => this.handleFrame(frame));
  }

  /** 取消帧订阅（生命周期清理）。 */
  dispose(): void {
    this.unsubscribe();
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getState(): ChatSessionState {
    return this.state;
  }

  /** 替换事件回调（视图绑定/解绑用）。 */
  setEvents(events: ChatSessionEvents): void {
    this.events.onMessagesChanged = events.onMessagesChanged ?? this.events.onMessagesChanged;
    this.events.onSessionId = events.onSessionId ?? this.events.onSessionId;
    this.events.onStateChange = events.onStateChange ?? this.events.onStateChange;
    this.events.onError = events.onError ?? this.events.onError;
  }

  /** 创建会话（cwd 为 agent 工作目录）并进入就绪。 */
  async open(cwd: string): Promise<string> {
    const created = await this.client.call<{ sessionId: string }>("session.create", { cwd });
    this.sessionId = created.sessionId;
    this.events.onSessionId?.(created.sessionId);
    return created.sessionId;
  }

  /** 发送一条用户消息（queue 模式，允许排队）。 */
  async send(text: string): Promise<void> {
    if (this.sessionId === null) throw new Error("chatSession: 会话未就绪");
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    await this.client.call("session.prompt", {
      sessionId: this.sessionId,
      mode: "queue",
      content: [{ type: "text", text: trimmed }],
    });
  }

  /** 停止当前轮次。 */
  async cancel(): Promise<void> {
    if (this.sessionId === null) return;
    await this.client.call("session.cancel", { sessionId: this.sessionId });
  }

  /** 切换默认模型（settings.update，实时生效）。 */
  async setModel(model: string): Promise<void> {
    await this.client.call("settings.update", { ns: "agent-default-model", patch: { model } });
  }

  /** 切换推理强度（off / high / max）。 */
  async setReasoningEffort(effort: string): Promise<void> {
    await this.client.call("settings.update", { ns: "agent-default-model", patch: { reasoningEffort: effort } });
  }

  /** 切换权限预设（workspace-write / danger-full-access）。 */
  async setPermissionPreset(preset: string): Promise<void> {
    await this.client.call("settings.update", { ns: "permission", patch: { defaultPreset: preset } });
  }

  /** 帧入口：由外部把 DshClient 的 onMuxFrame 转发进来（也便于单测注入）。 */
  handleFrame(frame: ServerRequestFrame<MuxFrame>): void {
    const p = frame.payload;
    switch (p.type) {
      case "session/event":
        this.handleSessionEvent(p.event);
        break;
      case "question/requested":
        this.pushSystemMessage(`agent 正在等待你的回答：「${p.questions[0]?.question ?? "…"}」（提问交互将在下一阶段支持）`);
        break;
      case "stream/error":
        this.events.onError?.(`事件流错误: ${p.error.message}`);
        break;
      default:
        break;
    }
  }

  // ---------- 内部状态机 ----------

  private handleSessionEvent(event: { type: string; data?: Record<string, unknown> }): void {
    switch (event.type) {
      case "user/message": {
        // 系统注入消息（runtime context / system-reminder 等）带 source.kind
        // plugin / skill-catalog，是发给 agent 的上下文，不是用户输入，不渲染
        const source = (event.data as { source?: { kind?: string } } | undefined)?.source;
        if (source?.kind !== undefined && source.kind !== "user") return;
        const text = extractText(event.data);
        this.pushMessage({ id: `m${++this.msgSeq}`, role: "user", blocks: [{ kind: "text", text }], status: "done" });
        break;
      }
      case "turn/start":
        this.setState("busy");
        this.currentAssistant = { id: `m${++this.msgSeq}`, role: "assistant", blocks: [], status: "streaming" };
        this.messages.push(this.currentAssistant);
        this.emit();
        break;
      case "assistant/chunk": {
        const chunk = event.data?.chunk as
          | {
              type?: string;
              text?: string;
              blockType?: string;
              index?: number;
              block?: { type?: string; text?: string; name?: string; id?: string };
              name?: string;
              reason?: { kind?: string; failure?: { message?: string } };
            }
          | undefined;
        if (!chunk || !this.currentAssistant) return;
        const msg = this.currentAssistant;
        switch (chunk.type) {
          case "block-start": {
            // 按类型建块（text 块必须有占位，否则 text-delta 会错位）
            if (chunk.blockType === "reasoning") msg.blocks.push({ kind: "reasoning", text: "" });
            else if (chunk.blockType === "text") msg.blocks.push({ kind: "text", text: "" });
            else if (chunk.blockType === "tool-call") msg.blocks.push({ kind: "tool", toolName: "…", toolStatus: "running" });
            break;
          }
          case "reasoning-delta": {
            const last = msg.blocks[msg.blocks.length - 1];
            if (last?.kind === "reasoning") last.text = (last.text ?? "") + (chunk.text ?? "");
            break;
          }
          case "text-delta": {
            const last = msg.blocks[msg.blocks.length - 1];
            if (last?.kind === "text") last.text = (last.text ?? "") + (chunk.text ?? "");
            else msg.blocks.push({ kind: "text", text: chunk.text ?? "" });
            break;
          }
          case "tool-call-delta": {
            // 工具增量：补全工具名
            const last = msg.blocks[msg.blocks.length - 1];
            if (last?.kind === "tool" && chunk.name) last.toolName = chunk.name;
            break;
          }
          case "block-end": {
            // 完整块内容兜底：流式增量可能缺失（实测 text-delta 仅开头片段），
            // block-end 携带权威内容，按 index 覆盖
            const block = chunk.block;
            if (!block) break;
            const target = msg.blocks[chunk.index ?? -1];
            if (block.type === "text" && block.text) {
              if (target?.kind === "text") target.text = block.text;
              else msg.blocks.push({ kind: "text", text: block.text });
            } else if (block.type === "reasoning" && block.text) {
              if (target?.kind === "reasoning") target.text = block.text;
            } else if (block.type === "tool-call") {
              if (target?.kind === "tool") {
                target.toolName = block.name ?? target.toolName ?? "?";
                target.toolStatus = "running";
              }
            }
            break;
          }
          case "finish": {
            if (chunk.reason?.kind === "error") {
              msg.status = "error";
              msg.error = chunk.reason.failure?.message ?? "LLM 调用失败";
            }
            break;
          }
          default:
            break;
        }
        this.emit();
        break;
      }
      case "tool/call": {
        if (!this.currentAssistant) return;
        const call = event.data as { name?: string; arguments?: string };
        // block-start(tool-call) 可能已建块（含 tool-call-delta），复用而非重复 push
        const existing = [...this.currentAssistant.blocks].reverse().find((b) => b.kind === "tool" && b.toolStatus === "running");
        if (existing?.kind === "tool") {
          existing.toolName = call.name ?? existing.toolName;
          existing.toolArgs = formatToolArgs(call.arguments);
        } else {
          this.currentAssistant.blocks.push({
            kind: "tool",
            toolName: call.name ?? "?",
            toolArgs: formatToolArgs(call.arguments),
            toolStatus: "running",
          });
        }
        this.emit();
        break;
      }
      case "tool/result": {
        if (!this.currentAssistant) return;
        const result = event.data as { message?: { content?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> } };
        const toolBlock = [...this.currentAssistant.blocks].reverse().find((b) => b.kind === "tool" && b.toolStatus === "running");
        if (toolBlock && toolBlock.kind === "tool") {
          toolBlock.toolStatus = "done";
          toolBlock.toolResult = summarizeToolResult(result.message?.content);
        }
        this.emit();
        break;
      }
      case "assistant/message": {
        if (this.currentAssistant && this.currentAssistant.status === "streaming") {
          this.currentAssistant.status = "done";
        }
        this.currentAssistant = null;
        this.emit();
        break;
      }
      case "turn/end":
        this.setState("idle");
        break;
      default:
        break;
    }
  }

  private pushMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.emit();
  }

  private pushSystemMessage(text: string): void {
    this.messages.push({ id: `m${++this.msgSeq}`, role: "system", blocks: [{ kind: "text", text }], status: "done" });
    this.emit();
  }

  private setState(state: ChatSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange?.(state);
  }

  private emit(): void {
    this.events.onMessagesChanged?.(this.messages);
  }
}

function extractText(data: Record<string, unknown> | undefined): string {
  const content = data?.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c !== null && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return String(data?.text ?? "");
}

function formatToolArgs(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const brief = Object.entries(parsed)
      .map(([k, v]) => `${k}: ${typeof v === "string" && v.length > 120 ? `${v.slice(0, 120)}…` : String(v).slice(0, 200)}`)
      .join(", ");
    return brief || raw;
  } catch {
    return raw.slice(0, 200);
  }
}

function summarizeToolResult(content: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> | undefined): string {
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (part.type === "tool-result" && Array.isArray(part.content)) {
      const texts = part.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      if (texts) return texts.length > 400 ? `${texts.slice(0, 400)}…` : texts;
    }
  }
  return "";
}
