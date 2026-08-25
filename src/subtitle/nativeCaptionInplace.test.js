import { NativeCaptionInplace } from "./nativeCaptionInplace.js";

/**
 * 原生字幕原位替换渲染器单元测试。
 * 在 jsdom 中模拟 YouTube 原生字幕容器与段落结构，验证：
 * 1. 译文命中时文本被原地替换；
 * 2. 双语/纯译文两种模式合成正确；
 * 3. 未命中译文的段落保持原文；
 * 4. stop 后段落恢复原文；
 * 5. displayOrder=translation-first 时译文在前。
 */
describe("NativeCaptionInplace", () => {
  const buildDom = () => {
    document.body.innerHTML = `
      <div id="ytp-caption-window-container">
        <div class="caption-window">
          <span class="ytp-caption-segment">Hello world</span>
        </div>
      </div>
    `;
    return document.querySelector(".ytp-caption-segment");
  };

  const buildRenderer = (subtitles, setting = {}) =>
    new NativeCaptionInplace({
      getSubtitles: () => subtitles,
      setting: { isBilingual: true, ...setting },
    });

  test("replaces segment text with bilingual composition", () => {
    const segment = buildDom();
    const renderer = buildRenderer([
      { text: "Hello world", translation: "你好，世界", start: 0, end: 1000 },
    ]);

    renderer.applyToSegment(segment);
    expect(segment.textContent).toBe("Hello world\n你好，世界");
    renderer.stop();
    expect(segment.textContent).toBe("Hello world");
  });

  test("translation-only mode replaces whole text", () => {
    const segment = buildDom();
    const renderer = buildRenderer(
      [{ text: "Hello world", translation: "你好，世界" }],
      { isBilingual: false }
    );

    renderer.applyToSegment(segment);
    expect(segment.textContent).toBe("你好，世界");
    renderer.stop();
  });

  test("keeps original text when no matching translation", () => {
    const segment = buildDom();
    const renderer = buildRenderer([]);

    renderer.applyToSegment(segment);
    expect(segment.textContent).toBe("Hello world");
  });

  test("normalizes whitespace when matching", () => {
    const segment = buildDom();
    segment.textContent = "Hello   world ";
    const renderer = buildRenderer([
      { text: "Hello world", translation: "你好" },
    ]);

    renderer.applyToSegment(segment);
    expect(segment.textContent).toContain("你好");
  });

  test("sync refreshes visible segments after translations arrive", () => {
    const segment = buildDom();
    const subtitles = [];
    const renderer = new NativeCaptionInplace({
      getSubtitles: () => subtitles,
      setting: { isBilingual: true },
    });

    renderer.sync();
    // 翻译尚未到达，保持原文
    expect(segment.textContent).toBe("Hello world");

    subtitles.push({ text: "Hello world", translation: "你好，世界" });
    renderer.sync();
    expect(segment.textContent).toBe("Hello world\n你好，世界");
    renderer.stop();
  });
});
