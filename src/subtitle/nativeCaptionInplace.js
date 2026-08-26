import { logger } from "../libs/log.js";

/**
 * 原生字幕原位替换渲染器（复刻沉浸式翻译的 YouTube 字幕方案）。
 *
 * 核心思路：不创建任何自绘悬浮层，也不压制原生字幕窗口，而是监听
 * YouTube 原生字幕容器 (#ytp-caption-window-container) 的 DOM 变化，
 * 在每个字幕段落 (.ytp-caption-segment) 的文本节点上原地替换为译文。
 *
 * 与"自绘悬浮层 + 隐藏原生窗口"方案相比的优势：
 * 1. 全程只有一条渲染路径（YouTube 自己渲染），不存在两个渲染主体抢屏导致的闪跳；
 * 2. 无需任何样式对抗（rAF 逐帧压制 / !important 样式表等），YouTube 回写样式不再有影响；
 * 3. 替换发生在 MutationObserver 微任务回调中，在下一次绘制前完成，用户永远看不到原文帧。
 */

// YouTube 原生字幕窗口容器选择器
const CAPTION_CONTAINER_SELECTOR = "#ytp-caption-window-container";
// 原生字幕文本段落选择器
const CAPTION_SEGMENT_SELECTOR = ".ytp-caption-segment";

/**
 * 注入一次性样式表：约束字幕窗口与空 cue 的渲染行为。
 * 1. 空内容段落（len=0 空响应 / 结构重建中间态）不显示背景框；
 * 2. 字幕窗口尺寸只由实际文本内容撑开，防止出现覆盖视频的巨大空框。
 * 样式幂等：已存在则跳过。
 */
function ensureCaptionStyle() {
  if (document.getElementById("kiss-caption-inplace-style")) return;
  const style = document.createElement("style");
  style.id = "kiss-caption-inplace-style";
  style.textContent = `
.${CAPTION_SEGMENT_SELECTOR.slice(1)}:empty {
  display: none !important;
}
${CAPTION_CONTAINER_SELECTOR} {
  width: fit-content !important;
  height: fit-content !important;
  max-width: 90% !important;
  left: 50% !important;
  transform: translateX(-50%) !important;
}
/* 锁定字号：YouTube 会按 cue 文本长度动态调整字号（inline font-size 随内容变化），
   原位替换改变文本长度会触发其自适应逻辑，导致同一句字幕尺寸反复变化。
   用 !important 压掉 YouTube 写在元素上的动态 inline 字号，固定为相对视口档位。 */
${CAPTION_CONTAINER_SELECTOR} span,
${CAPTION_CONTAINER_SELECTOR} span.ytp-caption-segment {
  font-size: 3.5cqw !important;
  line-height: 1.4 !important;
}
/* 过渡禁用必须覆盖容器自身：YouTube 在窗口元素上也有过渡，
   漏掉容器会导致整体尺寸变化被动画放大成明显的"重绘"。 */
${CAPTION_CONTAINER_SELECTOR},
${CAPTION_CONTAINER_SELECTOR} * {
  transition: none !important;
  animation: none !important;
}
/* 翻译未就绪的段落直接不参与布局：宁可短暂无字幕，
   也不让英文帧先画出来再被替换成中文（行数不同 → 背景框当场变高）。 */
${CAPTION_CONTAINER_SELECTOR} [data-kiss-hold] {
  display: none !important;
}
`;
  (document.head || document.documentElement).appendChild(style);
}

/**
 * 归一化文本用作翻译匹配 Key。
 * 折叠连续空白并去除首尾空白，抹平 JSON3 数据与 DOM 渲染文本之间的空白差异。
 *
 * @param {string} text 原始文本。
 * @returns {string} 归一化后的文本。
 */
function normalizeKey(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export class NativeCaptionInplace {
  // 返回最新已翻译字幕数组的 getter（由 provider 提供，数组内容会流式更新）
  #getSubtitles;
  // 字幕设置（isBilingual / displayOrder 等）
  #setting;
  // 观察器实例；null 表示未启动
  #observer = null;
  // 已替换段落的记录表：segment -> { original, applied }
  #applied = new WeakMap();
  // 当前生效的翻译映射：归一化原文 -> 含 translation 的字幕对象
  #translationMap = new Map();
  // 段落被替换后的回调（供侧边字幕列表面板同步高亮），签名同 BilingualSubtitleManager.onSubtitleUpdate
  onSubtitleUpdate = null;
  // 响应改写链路推送的兜底译文：归一化原文 -> 纯译文文本。
  // 主链路（timedtext 响应改写）漏网的英文 cue 由该映射在 DOM 层接住。
  #fallbackTranslations = new Map();
  // 主动翻译通道：provider 注入的回调 (texts: string[]) => Promise<string[]>。
  // 漏网的英文 cue 不再干等主链路喂映射，而是就地发起翻译。
  #translateTexts = null;
  // 已派发主动翻译、等待回填的原文集合（防重复请求）
  #pendingTranslate = new Set();

  // 翻译失败键的冷却表：key -> 失败时间戳。冷却期内不重试、不 hold，
  // 防止「失败→重刷→再发起」形成无限异步循环（真机上会疯狂打翻译接口）。
  #failedCooldown = new Map();

  // 冷却时长（毫秒）
  static COOLDOWN_MS = 30_000;

  /**
   * @param {object} param0 参数对象。
   * @param {Function} param0.getSubtitles 获取当前已处理字幕数组的函数。
   * @param {object} param0.setting 字幕设置对象。
   * @param {Function} [param0.translateTexts] 主动翻译回调，入参文本数组，回参译文数组。
   */
  constructor({ getSubtitles, setting, translateTexts }) {
    this.#getSubtitles = getSubtitles;
    this.#setting = setting || {};
    this.#translateTexts =
      typeof translateTexts === "function" ? translateTexts : null;
    // 绑定上下文，保证作为观察器回调与事件处理器时 this 指向正确
    this.handleMutations = this.handleMutations.bind(this);
    this.sync = this.sync.bind(this);
  }

  /**
   * 启动监听并应用首次替换。
   *
   * @returns {void}
   */
  start() {
    if (this.#observer) return;

    // 约束字幕窗口尺寸、隐藏空段落，防止出现覆盖视频的空白背景框
    ensureCaptionStyle();

    this.#observer = new MutationObserver(this.handleMutations);
    this.#observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    this.sync();
    logger.info("NativeCaptionInplace: started");
  }

  /**
   * 停止监听并把已替换的段落恢复为原文。
   *
   * @returns {void}
   */
  stop() {
    this.#observer?.disconnect();
    this.#observer = null;
    this.restoreAll();
    logger.info("NativeCaptionInplace: stopped");
  }

  /**
   * 响应改写链路推送的译文映射（原文 -> 译文），作为 DOM 层兜底数据源。
   *
   * @param {Map<string,string>} translations 原文到译文的映射。
   * @returns {void}
   */
  ingestTranslations(translations) {
    if (!(translations instanceof Map) || !translations.size) return;
    for (const [text, trText] of translations) {
      const key = normalizeKey(text);
      const tr = String(trText || "").trim();
      if (key && tr) {
        this.#fallbackTranslations.set(key, tr);
      }
    }
    this.sync();
  }

  /**
   * 标记文本已被其他链路（如响应改写）翻译过，主动翻译通道不再重复请求。
   *
   * @param {string} text 原文文本。
   * @returns {void}
   */
  markTranslated(text) {
    const key = normalizeKey(text);
    if (key) this.#pendingTranslate.add(key);
  }

  /**
   * 依据最新的字幕数据重建翻译映射，并对当前可见段落立即应用替换。
   * 由 provider 在每批新译文到达后调用，保证流式翻译结果能及时刷上屏幕。
   *
   * @returns {void}
   */
  sync() {
    this.#rebuildTranslationMap();

    const segments = this.#querySegments();
    for (const segment of segments) {
      this.applyToSegment(segment);
    }
    this.#collapseEmptyWindows();
  }

  /**
   * 主动翻译通道：对映射中查不到译文的文本发起就地翻译，
   * 完成后写入兜底映射并重刷可见段落。这是漏网英文的最后防线。
   *
   * @param {string[]} texts 未命中任何映射的原文文本列表。
   * @returns {void}
   */
  #requestTranslations(texts) {
    if (!this.#translateTexts) return;
    const now = Date.now();
    const todo = texts.filter((t) => {
      const key = normalizeKey(t);
      if (this.#pendingTranslate.has(key)) return false;
      const failedAt = this.#failedCooldown.get(key);
      if (failedAt && now - failedAt < NativeCaptionInplace.COOLDOWN_MS) {
        return false;
      }
      return t.length < 500;
    });
    if (!todo.length) return;
    todo.forEach((t) => this.#pendingTranslate.add(normalizeKey(t)));

    const releaseAndRefresh = () => {
      todo.forEach((t) => {
        const key = normalizeKey(t);
        this.#pendingTranslate.delete(key);
        this.#failedCooldown.set(key, Date.now());
      });
      for (const segment of this.#querySegments()) {
        this.applyToSegment(segment);
      }
    };

    Promise.resolve(this.#translateTexts(todo))
      .then((results) => {
        if (!Array.isArray(results)) {
          releaseAndRefresh();
          return;
        }
        const map = new Map();
        todo.forEach((text, i) => {
          const tr = String(results[i] || "").trim();
          if (tr) map.set(text, tr);
        });
        if (map.size) {
          // 成功的键从冷却表移除（可能存在早前失败记录）
          for (const text of map.keys()) {
            this.#failedCooldown.delete(normalizeKey(text));
          }
          this.ingestTranslations(map);
        } else {
          // 全部失败：解除 pending、进入冷却并重刷，挂起的段落回退显示原文
          releaseAndRefresh();
        }
      })
      .catch(() => {
        // 翻译失败：解除 pending 标记并重刷，挂起的段落回退显示原文
        releaseAndRefresh();
      });
  }

  /**
   * 判断文本是否为"已知待翻译的英文"（曾发起过主动翻译且尚未失败）。
   * 用于决定未命中译文时是否应该隐藏段落等待译文。
   *
   * @param {string} text 原文文本。
   * @returns {boolean} 是否在翻译流程中。
   */
  #isKnownEnglish(text) {
    const key = normalizeKey(text);
    return key.length > 0 && this.#pendingTranslate.has(key);
  }

  /**
   * 处理一轮 DOM 变更：只扫描位于原生字幕容器内的段落。
   * MutationObserver 回调在微任务中执行，替换会在下一次绘制前完成，
   * 因此原文帧不会被渲染出来。
   *
   * @param {Array<MutationRecord>} mutations 变更记录列表。
   * @returns {void}
   */
  handleMutations(mutations) {
    let touched = false;

    for (const mutation of mutations) {
      const target =
        mutation.target.nodeType === Node.TEXT_NODE
          ? mutation.target.parentElement
          : mutation.target;
      if (
        target &&
        target.closest &&
        target.closest(CAPTION_CONTAINER_SELECTOR)
      ) {
        touched = true;
        break;
      }
    }

    if (touched) {
      for (const segment of this.#querySegments()) {
        this.applyToSegment(segment);
      }
      this.#collapseEmptyWindows();
    }
  }

  /**
   * 收缩空字幕窗口：当容器存在但没有任何可见文本时（空 cue / 结构重建
   * 中间态），隐藏其背景框，避免出现覆盖视频的巨大空白区域。
   * 容器有实际文本时恢复显示。通过 data 属性标记状态保证幂等。
   *
   * @returns {void}
   */
  #collapseEmptyWindows() {
    const containers = document.querySelectorAll(CAPTION_CONTAINER_SELECTOR);
    for (const container of containers) {
      const hasText = normalizeKey(container.textContent || "") !== "";
      if (!hasText) {
        if (container.dataset.kissCollapsed !== "1") {
          container.dataset.kissCollapsed = "1";
          container.style.setProperty("display", "none", "important");
        }
      } else if (container.dataset.kissCollapsed === "1") {
        delete container.dataset.kissCollapsed;
        container.style.removeProperty("display");
        // 恢复后立即对段落做一轮替换，防止原文帧被绘制
        for (const segment of this.#querySegments()) {
          this.applyToSegment(segment);
        }
      }
    }
  }

  /**
   * 对单个字幕段落应用原位替换。
   * 匹配不到译文时保持原文不动（例如翻译尚未返回），等待下一次 sync 补刷。
   *
   * @param {HTMLElement} segment 字幕段落元素。
   * @returns {void}
   */
  applyToSegment(segment) {
    // 兜底：外部直调时翻译映射可能尚未构建
    if (!this.#translationMap.size) {
      this.#rebuildTranslationMap();
    }

    const currentText = segment.textContent || "";
    const record = this.#applied.get(segment);

    // 本轮已是我们的替换结果，无需重复处理
    if (record && record.applied === currentText) return;

    // 判定当前段落承载的"原文"：
    // - 首次遇到该段落：以当前文本为原文；
    // - 该段落文本仍等于上次记录的原文：说明 YouTube 尚未切换到下一句，沿用原纪录；
    // - 文本变了：说明 YouTube 推进了到新的句子，以新文本为新原文。
    const original =
      record && normalizeKey(record.original) === normalizeKey(currentText)
        ? record.original
        : currentText;

    const replacement = this.#resolveReplacement(original);
    const key = normalizeKey(original);
    const translating = key && this.#pendingTranslate.has(key);

    if (!replacement) {
      if (translating || this.#isKnownEnglish(original)) {
        // 译文在路上（或已确认是待翻译的英文）：先隐藏段落，
        // 不让英文帧画出来——否则英文→中文行数不同，背景框当场变高。
        segment.setAttribute("data-kiss-hold", "1");
        segment.textContent = original;
      } else if (key) {
        // 全新漏网英文：登记 pending 并发起就地翻译（下一轮 mutation 会 hold）
        segment.removeAttribute("data-kiss-hold");
        this.#requestTranslations([original]);
      } else {
        segment.removeAttribute("data-kiss-hold");
      }
      return;
    }

    // 译文就绪：一次性上屏（先写文本再摘 hold 标记，同帧完成，无中间态）
    segment.removeAttribute("data-kiss-hold");
    const sub = this.#translationMap.get(key);
    this.#applied.set(segment, { original, applied: replacement });
    segment.textContent = replacement;

    if (sub) {
      this.onSubtitleUpdate?.({
        start: sub.start,
        end: sub.end,
        text: sub.text,
        translation: sub.translation,
      });
    }
  }

  /**
   * 把所有已替换的段落恢复为原始文本（用于关闭功能或销毁时还原现场）。
   *
   * @returns {void}
   */
  restoreAll() {
    // WeakMap 不可枚举，无法遍历全部历史段落；
    // 只需恢复当前仍在文档中的段落，其余随节点销毁自然消失。
    for (const segment of this.#querySegments()) {
      const record = this.#applied.get(segment);
      if (record && segment.textContent === record.applied) {
        segment.textContent = record.original;
      }
    }
    this.#fallbackTranslations.clear();
  }

  /**
   * 依据双语开关与显示顺序合成段落展示文本。
   * 译文缺失（尚未返回或翻译失败）时返回 null，表示保持原文。
   *
   * @param {object} sub 含 text/translation 的字幕条目。
   * @returns {string|null} 合成后的展示文本。
   */
  #composeDisplay(sub) {
    const translation = String(sub.translation || "").trim();
    if (!translation) return null;

    if (this.#setting.isBilingual === false) {
      return translation;
    }

    const original = String(sub.text || "").trim();
    return this.#setting.displayOrder === "translation-first"
      ? `${translation}\n${original}`
      : `${original}\n${translation}`;
  }

  /**
   * 用最新字幕数组重建"归一化原文 -> 字幕条目"映射。
   * 数组规模为千级别且仅在批次到达时调用，全量重建成本可忽略。
   *
   * @returns {void}
   */
  #rebuildTranslationMap() {
    const map = new Map();
    for (const sub of this.#getSubtitles?.() || []) {
      const key = normalizeKey(sub.text);
      // 同文重复句（如口头禅）共享同一译文，后者覆盖前者即可
      if (key) {
        map.set(key, sub);
      }
    }
    this.#translationMap = map;
  }

  /**
   * 查询段落文本对应的替换文本。
   * 优先用主链路字幕数据（含双语合成），未命中时回退响应改写链路推送的纯译文。
   *
   * @param {string} segmentText 段落当前文本。
   * @returns {string|null} 替换文本；null 表示无可用译文，保持原文。
   */
  #resolveReplacement(segmentText) {
    const key = normalizeKey(segmentText);
    if (!key) return null;

    const sub = this.#translationMap.get(key);
    const composed = sub ? this.#composeDisplay(sub) : null;
    if (composed) return composed;

    return this.#fallbackTranslations.get(key) || null;
  }

  /**
   * 收集当前文档中原生字幕容器内的所有段落。
   *
   * @returns {Array<HTMLElement>} 段落元素列表。
   */
  #querySegments() {
    try {
      const container = document.querySelector(CAPTION_CONTAINER_SELECTOR);
      if (!container) return [];
      return Array.from(container.querySelectorAll(CAPTION_SEGMENT_SELECTOR));
    } catch (error) {
      logger.warn("NativeCaptionInplace: query segments failed", error);
      return [];
    }
  }
}
