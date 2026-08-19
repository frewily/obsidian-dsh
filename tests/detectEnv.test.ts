import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectDshEnv } from "../src/detectEnv";

/**
 * detectDshEnv 单测：构造临时 PATH 结构（node 可执行 + dsh → bin.js 符号链接），
 * 注入 pathOverride 验证解析逻辑。
 */

const tmpRoot = join(tmpdir(), `dsh-detect-${process.pid}`);
const binDir = join(tmpRoot, "bin");
const nodeBin = join(binDir, "node");
const dshLink = join(binDir, "dsh");
const dshReal = join(tmpRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

beforeAll(() => {
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(tmpRoot, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  writeFileSync(nodeBin, "#!/bin/sh\necho fake-node\n");
  chmodSync(nodeBin, 0o755);
  writeFileSync(dshReal, "#!/usr/bin/env node\n");
  chmodSync(dshReal, 0o755);
  symlinkSync(dshReal, dshLink);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("detectDshEnv", () => {
  it("从 PATH 解析 node 与 dsh（symlink 直指 bin.js）", async () => {
    const env = await detectDshEnv({ pathOverride: binDir });
    expect(env).not.toBeNull();
    expect(env?.nodePath).toBe(nodeBin);
    // macOS 下 /var 是 /private/var 的符号链接，realpath 会展开，故对期望值也做 realpath
    expect(env?.dshEntry).toBe(realpathSync(dshReal));
  });
});
