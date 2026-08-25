import {
  normalizeKey,
  extractTextLines,
  applyTranslationToEvents,
} from "./timedtextRewrite.js";

/**
 * timedtext 响应改写纯函数单元测试。
 * （注入器本体在油猴环境以自包含 IIFE 注入页面世界，无法直接单测；
 * 这里覆盖与注入器内部逻辑保持同步的纯函数部分。）
 */
describe("timedtextRewrite pure functions", () => {
  const events = [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
    { tStartMs: 2000, dDurationMs: 800, segs: [{ utf8: "Goodbye" }] },
    { tStartMs: 3000, dDurationMs: 500 }, // 无文本的时间轴事件
  ];

  test("normalizeKey collapses whitespace", () => {
    expect(normalizeKey("  Hello\n\tworld ")).toBe("Hello world");
    expect(normalizeKey(null)).toBe("");
  });

  test("extractTextLines collects unique non-empty lines in order", () => {
    expect(extractTextLines(events)).toEqual(["Hello", "world", "Goodbye"]);
  });

  test("applyTranslationToEvents replaces matched segs only", () => {
    const map = new Map([
      ["Hello", "你好"],
      ["world", "世界"],
      ["Goodbye", "再见"],
    ]);
    const result = applyTranslationToEvents(events, map);
    expect(result[0].segs.map((s) => s.utf8)).toEqual(["你好", "世界"]);
    expect(result[1].segs[0].utf8).toBe("再见");
    // 时间轴事件原样保留
    expect(result[2]).toBe(events[2]);
  });

  test("keeps whole event when nothing matched (no subtitle hole)", () => {
    const map = new Map([["Hello", "你好"]]);
    const result = applyTranslationToEvents(events, map);
    // 第一句部分命中：只保留命中的段
    expect(result[0].segs.map((s) => s.utf8)).toEqual(["你好"]);
    // 第二句完全未命中 → 原样保留
    expect(result[1]).toBe(events[1]);
  });
});
