# obsidian-dsh

> DeepSeek Harness for Obsidian：一个 Claudian 式原生聊天面板，把 DeepSeek Harness 的智能体能力（bash、文件读写、网络检索、子代理）直接带进你的 vault。

**状态：设计阶段（v0.2），尚未开始编码。** 详细设计见 [docs/开发文档.md](docs/开发文档.md)。

## 设计要点

- 自绘轻量聊天面板（非 iframe 嵌入完整 GUI）
- 插件自管 `dsh web --port 0` 实例，通过 `/api` RPC + WebSocket 事件对接完整 DSH 后端
- 核心差异化：`ask_user_question` 提问以 Obsidian 原生模态框闭环呈现（现有同类插件的实测断点）
- 设计灵感来自 [Claudian](https://github.com/YishenTu/claudian) (MIT)

## 许可证

[MIT](./LICENSE)
