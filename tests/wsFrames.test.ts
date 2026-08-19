import { describe, expect, it } from "vitest";
import { encodeClientFrame, WsFrameParser, WS_OP } from "../src/wsFrames";

/** 构造服务端 → 客户端帧（未 mask）。 */
function serverTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

describe("WsFrameParser", () => {
  it("解析单文本帧", () => {
    const parser = new WsFrameParser();
    const frames = parser.feed(serverTextFrame("hello"));
    expect(frames).toHaveLength(1);
    expect(frames[0].opcode).toBe(WS_OP.TEXT);
    expect(frames[0].fin).toBe(true);
    expect(frames[0].payload.toString()).toBe("hello");
  });

  it("跨 chunk 分片到达后完整解析", () => {
    const parser = new WsFrameParser();
    const full = serverTextFrame("hello world");
    const half = Math.floor(full.length / 2);
    expect(parser.feed(full.subarray(0, half))).toHaveLength(0);
    const frames = parser.feed(full.subarray(half));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.toString()).toBe("hello world");
  });

  it("一个 chunk 多个帧", () => {
    const parser = new WsFrameParser();
    const frames = parser.feed(Buffer.concat([serverTextFrame("a"), serverTextFrame("b")]));
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.payload.toString())).toEqual(["a", "b"]);
  });

  it("126 扩展长度（>125 字节 payload）", () => {
    const parser = new WsFrameParser();
    const text = "x".repeat(300);
    const frames = parser.feed(serverTextFrame(text));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.length).toBe(300);
  });

  it("解析 close / ping 帧", () => {
    const parser = new WsFrameParser();
    const close = Buffer.from([0x88, 0x00]);
    const ping = Buffer.from([0x89, 0x02, 0x61, 0x62]);
    const frames = parser.feed(Buffer.concat([close, ping]));
    expect(frames.map((f) => f.opcode)).toEqual([WS_OP.CLOSE, WS_OP.PING]);
  });
});

describe("encodeClientFrame", () => {
  it("客户端帧必须带 mask 位", () => {
    const frame = encodeClientFrame(WS_OP.TEXT, "hi");
    expect(frame[0] & 0x80).toBe(0x80); // FIN
    expect(frame[0] & 0x0f).toBe(WS_OP.TEXT);
    expect(frame[1] & 0x80).toBe(0x80); // MASK
    expect(frame[1] & 0x7f).toBe(2);
    // 2 字节 key + 2 字节 payload
    expect(frame.length).toBe(2 + 4 + 2);
    // 解 mask 后等于原文
    const key = frame.subarray(2, 6);
    const payload = Buffer.from(frame.subarray(6));
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    expect(payload.toString()).toBe("hi");
  });
});
