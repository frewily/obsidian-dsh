/**
 * 解析 dsh web 的 stdout，提取服务 URL。
 *
 * 实测（M0）：「dsh web」就绪后打印 `dsh web: http://127.0.0.1:<port>`
 * （可选追加 ` (LAN: http://...)` 后缀）。正则要求 http(s) 前缀，
 * 避免误匹配其他以 `dsh web: ` 开头的日志行（M0 事故：曾误捕获 "opening"）。
 */

const DSH_URL_LINE_RE = /^dsh web: (https?:\/\/\S+)/m;

/**
 * 从一段 stdout 文本中提取 DSH Web 服务 URL。
 * @param chunk - stdout 增量或累积文本。
 * @returns 匹配到的 URL，未匹配返回 null。
 */
export function parseDshUrlLine(chunk: string): string | null {
  const m = chunk.match(DSH_URL_LINE_RE);
  return m ? m[1] : null;
}

/** 提取 LAN 后缀的候选地址（供未来「局域网访问」功能使用，暂未启用）。 */
export function parseDshLanCandidate(chunk: string): string | null {
  const m = chunk.match(/\(LAN: (https?:\/\/\S+)\)/);
  return m ? m[1] : null;
}
