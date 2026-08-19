import { FileSystemAdapter, Notice, Plugin } from "obsidian";
import { DshProcessManager, type DshProcessConfig, type DshProcessState } from "./dshProcess";
import { DshClient, type DshClientConnectionState } from "./dshClient";
import { ChatSession } from "./chatSession";
import { CHAT_VIEW_TYPE, ChatView } from "./chatView";

/**
 * 插件入口（阶段 3）：装配 进程管理器 → 协议客户端 → 会话 → 聊天视图。
 */
export default class ObsidianDshPlugin extends Plugin {
  private processManager: DshProcessManager | null = null;
  private client: DshClient | null = null;
  private session: ChatSession | null = null;
  private statusBarEl: HTMLElement | null = null;
  private vaultPath = "";
  private view: ChatView | null = null;

  async onload(): Promise<void> {
    this.vaultPath = this.getVaultPath();

    // 状态栏（阶段 3 简化版）
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText("DSH: 启动中…");

    // 进程管理器
    this.processManager = new DshProcessManager(this.processConfig(), {
      onStateChange: (state) => this.onProcessState(state),
      onUrl: (url) => void this.onServerReady(url),
      onError: (message) => {
        this.statusBarEl?.setText(`DSH: ${message}`);
      },
    });

    // 视图与命令
    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf) => {
        this.view = new ChatView(leaf, this.session);
        return this.view;
      }
    );
    this.addRibbonIcon("bot", "打开 DeepSeek Harness", () => void this.openChat());
    this.addCommand({
      id: "open-chat",
      name: "打开 DSH 聊天",
      callback: () => void this.openChat(),
    });

    this.processManager.start();
  }

  onunload(): void {
    this.session?.dispose();
    this.session = null;
    this.client?.disconnect().catch(() => {});
    this.client = null;
    this.processManager?.stop();
    this.processManager = null;
  }

  // ---------- 生命周期装配 ----------

  private processConfig(): DshProcessConfig {
    return {
      cwd: this.vaultPath,
      // 默认复用 ~/.dsh：凭证（DEEPSEEK_API_KEY）自动可用（M0 F1）
    };
  }

  private onProcessState(state: DshProcessState): void {
    switch (state) {
      case "starting":
      case "restarting":
        this.statusBarEl?.setText("DSH: 启动中…");
        this.view?.setDisconnected(true);
        break;
      case "running":
        break; // URL 就绪后由 onServerReady 处理
      case "stopped":
        this.statusBarEl?.setText("DSH: 已停止");
        this.view?.setDisconnected(true);
        break;
      default:
        break;
    }
  }

  private async onServerReady(url: string): Promise<void> {
    this.statusBarEl?.setText("DSH: 连接中…");
    try {
      const client = new DshClient(
        { baseUrl: url },
        {
          onStateChange: (state) => this.onClientState(state),
        }
      );
      this.client = client;
      await client.connect(30000);

      const session = new ChatSession(client);
      await session.open(this.vaultPath);
      this.session = session;
      this.view?.bindSession(session);
      this.statusBarEl?.setText("DSH: 就绪");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusBarEl?.setText("DSH: 连接失败");
      new Notice(`DSH 连接失败: ${message}`);
    }
  }

  private onClientState(state: DshClientConnectionState): void {
    if (state === "reconnecting") {
      this.statusBarEl?.setText("DSH: 重连中…");
      this.view?.setDisconnected(true);
    } else if (state === "connected") {
      this.statusBarEl?.setText("DSH: 就绪");
      this.view?.setDisconnected(false);
    }
  }

  private async openChat(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  private getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return process.cwd();
  }
}
