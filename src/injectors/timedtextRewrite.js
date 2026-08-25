import { logger } from "../libs/log.js";
import { MSG_TIMEDTEXT_REWRITE } from "../config/msg.js";

/**
 * timedtext 响应改写桥（复刻沉浸式翻译"让 YouTube 拿到译文数据"的思路）。
 *
 * 背景：在部分安卓 WebView / 油猴环境中，YouTube 原生字幕不走 DOM 容器渲染，
 * 任何 DOM 层的替换或样式压制都无法生效。唯一可靠的路径是从数据源头下手：
 * 拦截播放器发出的 timedtext 请求，把翻译好的字幕直接写回响应体，
 * 让播放器拿到的"原字幕数据"就是中文 —— 无论它最终用什么方式渲染，都只有中文。
 *
 * 职责边界：
 * - 页面世界（本注入器）只负责网络拦截与响应改写，不做任何翻译；
 * - 内容脚本世界负责翻译并把结果通过 postMessage 推回来。
 */

// 已完成翻译改写的响应缓存：请求标识 -> 改写后的 json3 文本
const rewriteCache = new Map();
// 正在等待翻译结果的请求集合（避免同一请求重复派发）
const pendingRequests = new Set();
// 翻译批次版本号：内容脚本每推回一批新译文自增一次
let rewriteVersion = 0;

/**
 * 生成请求标识：视频 ID + 语言 + 时间偏移参数组合。
 * YouTube 对同一句字幕可能发出多次 timedtext 请求，相同标识直接命中缓存。
 *
 * @param {string} url timedtext 请求 URL。
 * @returns {string} 请求标识。
 */
function buildRequestKey(url) {
  try {
    const u = new URL(url, window.location.origin);
    return [
      u.searchParams.get("v") || "",
      u.searchParams.get("lang") || "",
      u.searchParams.get("kind") || "",
      u.searchParams.get("tstart") || "",
    ].join("|");
  } catch {
    return url;
  }
}

/**
 * 把毫秒时间格式化为 json3 的 "HH:MM:SS.mmm" 时间字符串。
 *
 * @param {number} ms 毫秒数。
 * @returns {string} json3 时间字符串。
 */
function formatJson3Time(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  const rest = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${s}.${rest}`;
}

/**
 * 解析 json3 "HH:MM:SS.mmm" 时间字符串为毫秒数；非法输入返回 null。
 *
 * @param {string} str 时间字符串。
 * @returns {number|null} 毫秒数。
 */
function parseJson3Time(str) {
  if (typeof str !== "string") return null;
  const m = str.match(/^(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$/);
  if (!m) return null;
  const [, h, min, s, ms] = m;
  return (
    Number(h) * 3600000 + Number(min) * 60000 + Number(s) * 1000 + Number(ms.padEnd(3, "0"))
  );
}

/**
 * 从原始 json3 events 提取纯文本行列表（供内容脚本翻译用）。
 *
 * @param {Array<object>} events json3 events 数组。
 * @returns {Array<string>} 文本行列表（按出现顺序、去空）。
 */
export function extractTextLines(events) {
  const lines = [];
  for (const event of events || []) {
    for (const seg of event.segs || []) {
      const text = String(seg.utf8 || "").trim();
      if (text) {
        lines.push(text);
      }
    }
  }
  // 去重保序：重复行只翻一次
  return Array.from(new Set(lines));
}

/**
 * 用"原文 -> 译文"映射把 json3 events 中所有 segs 文本替换为译文。
 * 未命中映射的行为两种策略：
 * - dropUntranslated=true：丢弃该 segs（纯译文模式，避免英文残留）；
 *   但整句完全无译文时保留原 event（宁可显示原文也不能丢字幕）。
 * - dropUntranslated=false：保留原文（双语/兜底模式由上层拼好映射控制）。
 *
 * @param {Array<object>} events 原始 json3 events。
 * @param {Map<string,string>} translationMap 归一化原文 -> 译文。
 * @param {boolean} dropUntranslated 是否丢弃未翻译文本段。
 * @returns {Array<object>} 替换后的 events。
 */
export function applyTranslationToEvents(events, translationMap, dropUntranslated) {
  const output = [];

  for (const event of events || []) {
    const segs = event.segs;
    if (!segs?.length) {
      // 纯时间轴事件（无文本），原样保留
      output.push(event);
      continue;
    }

    let hitCount = 0;
    const newSegs = [];
    for (const seg of segs) {
      const raw = String(seg.utf8 || "");
      const key = raw.replace(/\s+/g, " ").trim();
      const translated = key ? translationMap.get(key) : null;
      if (translated) {
        hitCount += 1;
        newSegs.push({ ...seg, utf8: translated });
      }
      // 未命中时不 push（丢弃该段）
    }

    if (!newSegs.length) {
      // 整句无译文：保留原事件，避免字幕空洞
      output.push(event);
      continue;
    }

    output.push({
      ...event,
      segs: newSegs,
      ...(hitCount > 0 ? {} : {}),
    });
  }

  return output;
}

/**
 * 序列化 events 为 json3 响应体。
 *
 * @param {Array<object>} events 处理后的 events。
 * @returns {string} json3 响应文本。
 */
export function serializeEvents(events) {
  return JSON.stringify({ events });
}

/**
 * 注册页面世界的网络拦截与消息监听。
 * 由 injector-subtitle 入口调用；扩展与油猴环境均以 IIFE 内联方式运行。
 *
 * @returns {void}
 */
export function TimedTextRewriteInjector() {
  if (window.__KISS_TIMEDTEXT_REWRITE__) {
    return;
  }
  window.__KISS_TIMEDTEXT_REWRITE__ = true;

  // --- 接收内容脚本推回的翻译结果 ---
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.type !== MSG_TIMEDTEXT_REWRITE) return;

    try {
      const { requestKey, lines, translations, dropUntranslated } = data;
      if (!requestKey || !lines?.length || !translations) return;

      const map = new Map();
      for (let i = 0; i < lines.length; i++) {
        if (translations[i]) {
          map.set(lines[i], translations[i]);
        }
      }

      rewriteCache.set(requestKey, { map, dropUntranslated: !!dropUntranslated });
      rewriteVersion += 1;

      // 新译文到达后重放当前视频最近一次被拦的原生请求：
      // 播放器会重新拉取字幕数据，此时拿到的是已带译文的响应。
      replayLatestRequest();
    } catch (err) {
      logger.warn("TimedTextRewrite: handle message", err);
    }
  });

  /**
   * 用缓存的最新请求 URL 重放一次 fetch。
   * 播放器收到改写后的响应会自动刷新字幕渲染。
   */
  function replayLatestRequest() {
    const latestUrl = window.__KISS_LAST_TIMEDTEXT_URL__;
    if (!latestUrl) return;
    try {
      // 重放走原生 fetch，会再次经过下方 hook，从而命中缓存完成改写
      fetch(latestUrl).catch(() => {});
    } catch {}
  }

  // --- Hook fetch ---
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url =
          typeof args[0] === "string"
            ? args[0]
            : args[0]?.url || "";
        if (url && url.includes("timedtext")) {
          window.__KISS_LAST_TIMEDTEXT_URL__ = url;
          const rewritten = await maybeRewrite(url, response);
          if (rewritten) {
            return rewritten;
          }
        }
      } catch (err) {
        logger.warn("TimedTextRewrite: fetch hook", err);
      }
      return response;
    };
  }

  // --- Hook XMLHttpRequest ---
  const OriginalXHROpen = XMLHttpRequest.prototype.open;
  const OriginalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__kissUrl = typeof url === "string" ? url : url?.url || "";
    return OriginalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__kissUrl;
    if (url && url.includes("timedtext")) {
      window.__KISS_LAST_TIMEDTEXT_URL__ = url;
      this.addEventListener("readystatechange", () => {
        if (this.readyState === 4 && this.status === 200) {
          try {
            const requestKey = buildRequestKey(url);
            const cached = rewriteCache.get(requestKey);
            if (cached) {
              const json = JSON.parse(this.responseText);
              const replaced = applyTranslationToEvents(
                json.events,
                cached.map,
                cached.dropUntranslated
              );
              const text = serializeEvents(replaced);
              Object.defineProperty(this, "responseText", { value: text });
              Object.defineProperty(this, "response", { value: text });
            } else if (!pendingRequests.has(requestKey)) {
              pendingRequests.add(requestKey);
              dispatchForTranslation(url, this.responseText);
            }
          } catch (err) {
            logger.warn("TimedTextRewrite: xhr rewrite", err);
          }
        }
      });
    }
    return OriginalXHRSend.apply(this, args);
  };

  /**
   * 把拦截到的原始字幕数据派发给内容脚本翻译。
   *
   * @param {string} url timedtext 请求 URL。
   * @param {string} responseText 原始响应文本。
   */
  function dispatchForTranslation(url, responseText) {
    try {
      const json = JSON.parse(responseText);
      const events = json?.events;
      if (!events?.length) return;

      const lines = extractTextLines(events);
      if (!lines.length) return;

      window.postMessage(
        {
          type: "KISS_TIMEDTEXT_TRANSLATE",
          requestKey: buildRequestKey(url),
          url,
          lines,
        },
        window.location.origin
      );
    } catch (err) {
      // 非 json3 格式（如 xml）暂不处理
      logger.debug("TimedTextRewrite: non-json3 response skipped");
    }
  }

  /**
   * 判断并改写 fetch 响应。
   *
   * @param {string} url 请求 URL。
     * @param {Response} response 原始响应。
   * @returns {Promise<Response|null>} 改写后的响应；无需改写返回 null。
   */
  async function maybeRewrite(url, response) {
    const requestKey = buildRequestKey(url);

    // 先取原始文本（clone 保持原始响应可继续使用）
    let text;
    try {
      text = await response.clone().text();
    } catch {
      return null;
    }

    const cached = rewriteCache.get(requestKey);
    if (cached) {
      const json = JSON.parse(text);
      const replaced = applyTranslationToEvents(
        json.events,
        cached.map,
        cached.dropUntranslated
      );
      return new Response(serializeEvents(replaced), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    if (!pendingRequests.has(requestKey)) {
      pendingRequests.add(requestKey);
      dispatchForTranslation(url, text);
    }

    return null;
  }
}
