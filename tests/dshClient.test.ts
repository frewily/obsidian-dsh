import { createHash } from "node:crypto";
import http, { type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DshClient, DshRpcError } from "../src/dshClient";

/**
 * DshClient 单测：真实回环 HTTP + WebSocket 服务器。
 * 服务器模拟 dsh 的 /api 信封与 mux/host 下行帧（服务端未 mask 文本帧）。
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface FakeServer {
  server: Server;
  baseUrl: string;
  sockets: Socket[];
  /** 记录收到的所有 /api POST 请求（信封）。 */
  requests: Array<{ path: string; body: unknown }>;
  /** 对 /api 的应答构造器（默认按方法回成功信封）。 */
  respondWith: (handler: (req: { path: string; body: unknown }) => unknown) => void;
  /** upgrade 后发服务端文本帧（未 mask）。 */
  sendServerFrame(socket: Socket, text: string): void;
  /** 关闭全部客户端 socket。 */
  dropAll(): void;
  close(): Promise<void>;
}

function serverTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  // ≥126 字节必须用扩展长度格式，否则第二字节 bit7 会被误读为 MASK
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

async function startFakeServer(): Promise<FakeServer> {
  const sockets: Socket[] = [];
  const requests: Array<{ path: string; body: unknown }> = [];
  let respondWith: (req: { path: string; body: unknown }) => unknown = (req) => {
    const body = req.body as { method?: string };
    return { type: "server-response", rpcId: (req.body as { rpcId?: string })?.rpcId ?? "r", result: { ok: true, value: { echo: body?.method } } };
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ path: req.url ?? "", body });
      const reply = respondWith({ path: req.url ?? "", body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });

  server.on("upgrade", (req, socket: Socket) => {
    sockets.push(socket);
    const key = (req.headers["sec-websocket-key"] as string) ?? "";
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    sockets,
    requests,
    respondWith: (handler) => {
      respondWith = handler;
    },
    sendServerFrame: (socket, text) => socket.write(serverTextFrame(text)),
    dropAll: () => {
      for (const s of sockets) s.destroy();
    },
    close: async () => {
      // Node 的 http server 不自动清理 upgrade 连接，先销毁服务端 socket
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

let fake: FakeServer | null = null;

beforeEach(async () => {
  fake = await startFakeServer();
});

afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe("DshClient RPC（真实回环）", () => {
  it("call 发送 client-request 信封并返回 result.value", async () => {
    const client = new DshClient({ baseUrl: fake!.baseUrl });
    fake!.respondWith(({ body }) => {
      const b = body as { rpcId: string; method: string; payload: unknown };
      return { type: "server-response", rpcId: b.rpcId, result: { ok: true, value: { sessionId: "s1" } } };
    });
    const value = await client.call("session.create", { cwd: "/tmp" });
    expect(value).toEqual({ sessionId: "s1" });
    expect(fake!.requests).toHaveLength(1);
    const req = fake!.requests[0];
    expect(req.path).toBe("/api/session.create");
    expect((req.body as { type: string; method: string; payload: unknown }).type).toBe("client-request");
    expect((req.body as { method: string }).method).toBe("session.create");
    expect((req.body as { payload: unknown }).payload).toEqual({ cwd: "/tmp" });
  });

  it("call 失败抛 DshRpcError（code/message）", async () => {
    const client = new DshClient({ baseUrl: fake!.baseUrl });
    fake!.respondWith(({ body }) => {
      const b = body as { rpcId: string };
      return { type: "server-response", rpcId: b.rpcId, result: { ok: false, error: { code: "not-found", message: "no such session", details: {} } } };
    });
    await expect(client.call("session.prompt", {})).rejects.toBeInstanceOf(DshRpcError);
    await expect(client.call("session.prompt", {})).rejects.toMatchObject({ code: "not-found", message: "no such session" });
  });

  it("respondQuestion 发送 client-response 信封（rpcId 回显）", async () => {
    const client = new DshClient({ baseUrl: fake!.baseUrl });
    await client.respondQuestion("q-rpc-1", "s1", { answers: [{ id: "q1", selected: ["奶茶"] }] });
    expect(fake!.requests).toHaveLength(1);
    const req = fake!.requests[0];
    expect(req.path).toBe("/api/respond");
    const body = req.body as { type: string; rpcId: string; result: { value: unknown } };
    expect(body.type).toBe("client-response");
    expect(body.rpcId).toBe("q-rpc-1");
    expect(body.result.value).toEqual({ sessionId: "s1", answer: { answers: [{ id: "q1", selected: ["奶茶"] }] } });
  });
});

describe("DshClient 连接与事件（真实回环 WS）", () => {
  it("connect：双通道握手 → host.describe → connected；mux 帧到达 onMuxFrame", async () => {
    const frames: unknown[] = [];
    const client = new DshClient({ baseUrl: fake!.baseUrl, backoffBaseMs: 10 }, { onMuxFrame: (f) => frames.push(f) });
    await client.connect(10000);
    expect(client.isConnected()).toBe(true);
    expect(fake!.requests.some((r) => r.path === "/api/host.describe")).toBe(true);

    // 向第一个连接的 mux socket 发 question/requested 帧
    const muxSocket = fake!.sockets[0];
    fake!.sendServerFrame(
      muxSocket,
      JSON.stringify({
        type: "server-request",
        rpcId: "q-1",
        method: "question/requested",
        payload: { type: "question/requested", sessionId: "s1", questions: [{ id: "q1", question: "今天想喝什么？" }] },
      })
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(frames).toHaveLength(1);
    const frame = frames[0] as { payload: { type: string; questions: Array<{ id: string }> } };
    expect(frame.payload.type).toBe("question/requested");
    expect(frame.payload.questions[0].id).toBe("q1");
    await client.disconnect();
  });

  it("断线重连：drop 全部 socket → reconnecting → 重连成功", async () => {
    const states: string[] = [];
    const client = new DshClient({ baseUrl: fake!.baseUrl, backoffBaseMs: 10 }, { onStateChange: (s) => states.push(s) });
    await client.connect(10000);
    expect(client.isConnected()).toBe(true);

    fake!.dropAll();
    const t0 = Date.now();
    while (!states.includes("reconnecting") && Date.now() - t0 < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(states).toContain("reconnecting");

    // 等重连成功（退避 10ms 起）
    const t1 = Date.now();
    while (!client.isConnected() && Date.now() - t1 < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
  });

  it("disconnect 停止循环并断开", async () => {
    const client = new DshClient({ baseUrl: fake!.baseUrl });
    await client.connect(10000);
    await client.disconnect();
    expect(client.getState()).toBe("disconnected");
  });
});
