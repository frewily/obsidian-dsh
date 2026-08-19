/**
 * 手写 WebSocket 客户端帧层（零依赖）。
 *
 * 背景（阶段 3 排障）：Obsidian/Chromium 的全局 WebSocket 会自动携带页面
 * Origin 头（app://obsidian.md），与 DSH 的 Host 127.0.0.1 不匹配，被
 * isTrustedApiRequest 信任检查 403 拒绝。因此用 Node 内置 http + 本帧层
 * 手写 WS 客户端：握手时不带 Origin 即可通过检查。
 *
 * 服务端 → 客户端帧不 mask；客户端 → 服务端帧必须 mask。
 * 仅需支持：text(0x1)、continuation(0x0)、close(0x8)、ping(0x9)、pong(0xA)。
 */

export interface WsFrame {
  opcode: number;
  payload: Buffer;
  fin: boolean;
}

export const WS_OP = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

/** 从字节流中增量解析帧。剩余不完整数据保留在内部缓冲。 */
export class WsFrameParser {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  feed(chunk: Buffer): WsFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: WsFrame[] = [];
    for (;;) {
      const frame = this.tryParseOne();
      if (frame === null) break;
      frames.push(frame);
    }
    return frames;
  }

  private tryParseOne(): WsFrame | null {
    const buf = this.buf;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const hi = buf.readUInt32BE(2);
      const lo = buf.readUInt32BE(6);
      if (hi !== 0 || lo > 0x7fffffff) throw new Error("wsFrame: payload 超过 2GB 不支持");
      len = lo;
      offset = 10;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    this.buf = buf.subarray(offset + len);
    return { opcode, payload, fin };
  }
}

/** 构造客户端 → 服务端帧（必须 mask）。 */
export function encodeClientFrame(opcode: number, payload: Buffer | string): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const len = data.length;
  const maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ maskKey[i & 3];
  return Buffer.concat([header, maskKey, masked]);
}
