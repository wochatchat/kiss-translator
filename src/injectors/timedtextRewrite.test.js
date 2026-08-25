import {
  extractTextLines,
  applyTranslationToEvents,
  serializeEvents,
} from "./timedtextRewrite.js";

describe("timedtextRewrite", () => {
  const events = [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
    { tStartMs: 2000, dDurationMs: 800, segs: [{ utf8: "Goodbye" }] },
    { tStartMs: 3000, dDurationMs: 500 }, // 无文本的时间轴事件
  ];

  test("extractTextLines collects unique non-empty lines in order", () => {
    const lines = extractTextLines(events);
    expect(lines).toEqual(["Hello", "world", "Goodbye"]);
  });

  test("applyTranslationToEvents replaces matched segs and drops unmatched", () => {
    const map = new Map([
      ["Hello", "你好"],
      ["world", "世界"],
      ["Goodbye", "再见"],
    ]);
    const result = applyTranslationToEvents(events, map, true);

    expect(result[0].segs.map((s) => s.utf8)).toEqual(["你好", "世界"]);
    expect(result[1].segs[0].utf8).toBe("再见");
    expect(result[2]).toEqual(events[2]); // 时间轴事件原样保留
  });

  test("keeps whole event when no translation hit (avoid subtitle hole)", () => {
    const map = new Map([["Hello", "你好"]]);
    const result = applyTranslationToEvents(events, map, true);
    // 第二句完全没命中 → 保留原事件
    expect(result[1].segs[0].utf8).toBe("Goodbye");
  });

  test("normalize whitespace when matching keys", () => {
    const messy = [
      { tStartMs: 0, dDurationMs: 100, segs: [{ utf8: "Hello\n  world" }] },
    ];
    const map = new Map([["Hello world", "你好，世界"]]);
    const result = applyTranslationToEvents(messy, map, true);
    expect(result[0].segs[0].utf8).toBe("你好，世界");
  });

  test("serializeEvents produces valid json3 body", () => {
    const text = serializeEvents([{ tStartMs: 1 }]);
    expect(JSON.parse(text)).toEqual({ events: [{ tStartMs: 1 }] });
  });
});
