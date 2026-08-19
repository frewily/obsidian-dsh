/**
 * 聊天面板视图（阶段 3）。
 *
 * 结构：工具栏（模型 / 推理强度 / 权限 / 停止）→ 消息流 → 输入区。
 * 渲染策略：订阅 ChatSession 的消息快照，全量重渲染消息区（消息量小，简单可靠）。
 * 会话懒绑定：dsh 服务启动是异步的，视图先渲染占位，main 就绪后 bindSession。
 */

import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import { ChatSession, type ChatMessage } from "./chatSession";

export const CHAT_VIEW_TYPE = "obsidian-dsh-chat";

export const MODEL_OPTIONS = [
  { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

export const EFFORT_OPTIONS = [
  { value: "off", label: "思考: 关闭" },
  { value: "high", label: "思考: 高" },
  { value: "max", label: "思考: 最大" },
];

export const PERMISSION_OPTIONS = [
  { value: "workspace-write", label: "权限: 工作区写入" },
  { value: "danger-full-access", label: "权限: 完全访问" },
];

export class ChatView extends ItemView {
  private session: ChatSession | null;

  private toolbarEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;
  private stopBtnEl!: HTMLButtonElement;
  private statusEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, session: ChatSession | null = null) {
    super(leaf);
    this.session = session;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "DeepSeek Harness";
  }

  getIcon(): string {
    return "bot";
  }

  /** main 在 dsh 服务就绪后调用，绑定会话并恢复渲染。 */
  bindSession(session: ChatSession): void {
    this.session = session;
    if (this.statusEl) {
      this.setSessionHandlers();
      this.renderMessages(session.getMessages());
      this.statusEl.setText("就绪");
      this.sendBtnEl.disabled = false;
    }
  }

  /** 服务未就绪/断线时由 main 调用。 */
  setDisconnected(disconnected: boolean): void {
    this.setStatusText(disconnected ? "正在启动/重连 dsh 服务…" : "就绪");
    if (this.sendBtnEl) {
      this.sendBtnEl.disabled = disconnected;
    }
  }

  /** 直接设置状态行文案（如环境检测失败等）。 */
  setStatusText(text: string): void {
    if (this.statusEl) {
      this.statusEl.setText(text);
    }
  }

  async onOpen(): Promise<void> {
    this.render();
    if (this.session) {
      this.setSessionHandlers();
      this.renderMessages(this.session.getMessages());
      this.statusEl.setText("就绪");
      this.sendBtnEl.disabled = false;
    } else {
      this.statusEl.setText("正在启动 dsh 服务…");
      this.sendBtnEl.disabled = true;
    }
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  // ---------- DOM ----------

  private setSessionHandlers(): void {
    const session = this.session;
    if (!session) return;
    session.setEvents({
      onMessagesChanged: (messages) => this.renderMessages(messages),
      onStateChange: (state) => {
        this.statusEl.setText(state === "busy" ? "agent 工作中…" : "就绪");
        this.stopBtnEl.disabled = state !== "busy";
      },
      onError: (message) => {
        this.statusEl.setText(message);
      },
    });
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("dsh-chat");

    this.toolbarEl = root.createDiv({ cls: "dsh-chat-toolbar" });
    this.renderToolbar();

    this.messagesEl = root.createDiv({ cls: "dsh-chat-messages" });

    this.statusEl = root.createDiv({ cls: "dsh-chat-status" });

    const inputRow = root.createDiv({ cls: "dsh-chat-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "dsh-chat-input",
      attr: { placeholder: "输入任务，Enter 发送，Shift+Enter 换行" },
    });
    this.sendBtnEl = inputRow.createEl("button", { cls: "dsh-chat-send", text: "发送" });
    this.sendBtnEl.addEventListener("click", () => this.submitInput());

    this.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        this.submitInput();
      }
    });
  }

  private renderToolbar(): void {
    this.toolbarEl.empty();

    const modelSelect = this.toolbarEl.createEl("select", { cls: "dsh-chat-select" });
    for (const opt of MODEL_OPTIONS) {
      modelSelect.createEl("option", { value: opt.value, text: opt.label });
    }
    modelSelect.addEventListener("change", () => {
      void this.session?.setModel(modelSelect.value).catch((e) => this.showError(e));
    });

    const effortSelect = this.toolbarEl.createEl("select", { cls: "dsh-chat-select" });
    for (const opt of EFFORT_OPTIONS) {
      effortSelect.createEl("option", { value: opt.value, text: opt.label });
    }
    effortSelect.addEventListener("change", () => {
      void this.session?.setReasoningEffort(effortSelect.value).catch((e) => this.showError(e));
    });

    const permSelect = this.toolbarEl.createEl("select", { cls: "dsh-chat-select" });
    for (const opt of PERMISSION_OPTIONS) {
      permSelect.createEl("option", { value: opt.value, text: opt.label });
    }
    permSelect.addEventListener("change", () => {
      void this.session?.setPermissionPreset(permSelect.value).catch((e) => this.showError(e));
    });

    this.stopBtnEl = this.toolbarEl.createEl("button", { cls: "dsh-chat-stop" });
    setIcon(this.stopBtnEl, "square");
    this.stopBtnEl.title = "停止当前任务";
    this.stopBtnEl.disabled = true;
    this.stopBtnEl.addEventListener("click", () => {
      void this.session?.cancel().catch((e) => this.showError(e));
    });
  }

  private renderMessages(messages: ChatMessage[]): void {
    this.messagesEl.empty();
    for (const message of messages) {
      this.renderMessage(message);
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderMessage(message: ChatMessage): void {
    const row = this.messagesEl.createDiv({ cls: `dsh-msg dsh-msg-${message.role}` });
    const roleLabel = message.role === "user" ? "你" : message.role === "assistant" ? "Agent" : "系统";
    row.createDiv({ cls: "dsh-msg-role", text: roleLabel });

    const body = row.createDiv({ cls: "dsh-msg-body" });
    for (const block of message.blocks) {
      if (block.kind === "text" && block.text) {
        body.createDiv({ cls: "dsh-block-text", text: block.text });
      } else if (block.kind === "reasoning" && block.text) {
        const details = body.createEl("details", { cls: "dsh-block-reasoning" });
        details.createEl("summary", { text: "思考过程" });
        details.createDiv({ cls: "dsh-reasoning-text", text: block.text });
      } else if (block.kind === "tool") {
        const card = body.createDiv({ cls: "dsh-block-tool" });
        const head = card.createDiv({ cls: "dsh-tool-head" });
        head.createSpan({ cls: "dsh-tool-name", text: `工具: ${block.toolName ?? "?"}` });
        if (block.toolStatus === "running") head.createSpan({ cls: "dsh-tool-status", text: "运行中…" });
        else if (block.toolStatus === "error") head.createSpan({ cls: "dsh-tool-status dsh-tool-status-error", text: "失败" });
        if (block.toolArgs) {
          card.createDiv({ cls: "dsh-tool-args", text: block.toolArgs });
        }
        if (block.toolResult) {
          card.createDiv({ cls: "dsh-tool-result", text: block.toolResult });
        }
      }
    }
    if (message.status === "error") {
      body.createDiv({ cls: "dsh-block-error", text: message.error ?? "发生错误" });
    } else if (message.status === "streaming") {
      body.createDiv({ cls: "dsh-streaming-caret", text: "▌" });
    }
  }

  private submitInput(): void {
    if (!this.session) return;
    const text = this.inputEl.value;
    if (!text.trim()) return;
    this.inputEl.value = "";
    void this.session.send(text).catch((e) => this.showError(e));
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.statusEl.setText(`错误: ${message}`);
  }
}
