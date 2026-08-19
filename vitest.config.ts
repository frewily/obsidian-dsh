import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    // 集成测试会真实 spawn dsh 并调用 LLM，串行执行避免并发干扰
    fileParallelism: false,
  },
});
