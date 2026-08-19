import { FileSystemAdapter, Plugin } from "obsidian";
import { DshProcessManager, type DshProcessConfig } from "./dshProcess";

/**
 * 插件入口（阶段 1）：挂载进程管理器。
 * 视图、命令、设置、状态栏在后续阶段接入。
 */
export default class ObsidianDshPlugin extends Plugin {
  private processManager: DshProcessManager | null = null;

  async onload(): Promise<void> {
    const vaultPath = this.getVaultPath();
    const config: DshProcessConfig = {
      cwd: vaultPath,
      // 默认复用 ~/.dsh：凭证（~/.dsh/.env 的 DEEPSEEK_API_KEY）自动可用（M0 F1）
    };
    this.processManager = new DshProcessManager(config, {
      onStateChange: (state) => {
        console.debug("[obsidian-dsh] process state:", state);
      },
      onUrl: (url) => {
        console.debug("[obsidian-dsh] dsh web ready:", url);
      },
      onError: (message) => {
        console.warn("[obsidian-dsh]", message);
      },
    });
    this.processManager.start();
  }

  onunload(): void {
    this.processManager?.stop();
    this.processManager = null;
  }

  private getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    // 非桌面适配器（理论上 isDesktopOnly 下不会走到）：退回进程 cwd
    return process.cwd();
  }
}
