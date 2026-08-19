import { describe, expect, it } from "vitest";
import { parseDshUrlLine, parseDshLanCandidate } from "../src/urlParse";

describe("parseDshUrlLine", () => {
  it("解析正常 URL 行", () => {
    expect(parseDshUrlLine("dsh web: http://127.0.0.1:3080")).toBe("http://127.0.0.1:3080");
  });

  it("解析随机端口 URL 行", () => {
    expect(parseDshUrlLine("dsh web: http://127.0.0.1:64988")).toBe("http://127.0.0.1:64988");
  });

  it("解析带 LAN 后缀的 URL 行（取主 URL）", () => {
    expect(parseDshUrlLine("dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)"))
      .toBe("http://127.0.0.1:3080");
  });

  it("多行日志中定位 URL 行", () => {
    const log = [
      "some startup log",
      "info: loading profile web",
      "dsh web: http://127.0.0.1:5000",
      "ready in 1.2s",
    ].join("\n");
    expect(parseDshUrlLine(log)).toBe("http://127.0.0.1:5000");
  });

  it("无 URL 时返回 null", () => {
    expect(parseDshUrlLine("just a log line")).toBeNull();
    expect(parseDshUrlLine("")).toBeNull();
    expect(parseDshUrlLine("dsh web: starting")).toBeNull();
  });

  it("回归（M0 事故）：'dsh web: opening' 等无 http 前缀的行不得误匹配", () => {
    expect(parseDshUrlLine("dsh web: opening")).toBeNull();
    expect(parseDshUrlLine("dsh web: waiting for server")).toBeNull();
  });

  it("不匹配其他服务的 URL 打印", () => {
    expect(parseDshUrlLine("vite: http://localhost:5173")).toBeNull();
    expect(parseDshUrlLine("web ui: http://127.0.0.1:3080")).toBeNull();
  });
});

describe("parseDshLanCandidate", () => {
  it("提取 LAN 候选地址", () => {
    expect(parseDshLanCandidate("dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)"))
      .toBe("http://192.168.1.5:3080");
  });

  it("无 LAN 后缀时返回 null", () => {
    expect(parseDshLanCandidate("dsh web: http://127.0.0.1:3080")).toBeNull();
  });
});
