/**
 * timedtext 响应改写注入器（页面世界运行）。
 *
 * 【关键约束】本函数在油猴/非扩展环境下会以 `(${TimedTextRewriteInjector})()`
 * 的形式序列化为字符串注入页面世界 —— 函数体必须完全自包含，
 * 不允许引用任何模块级导入（logger、常量、其他导出函数均不可用）。
 * 所有辅助逻辑必须内联在本函数体内。
 *
 * 工作方式（对齐沉浸式翻译的阻塞语义）：
 * 1. 拦截 YouTube timedtext 请求（fetch + XHR 双路径），强制 fmt=json3；
 * 2. 阻塞播放器的字幕请求：先自行取回原始数据、把文本行发给内容脚本翻译，
 *    翻译就绪（或超时兜底）后才放行原请求；
 * 3. 响应返回时用"原文->译文"映射改写响应体，播放器拿到纯中文字幕数据；
 * 4. 按请求参数缓存映射，同一视频后续请求即时命中。
 */

export function TimedTextRewriteInjector() {
  if (window.__KISS_TIMEDTEXT_REWRITE__) {
    return;
  }
  window.__KISS_TIMEDTEXT_REWRITE__ = true;

  var TRANSLATE_MSG = "KISS_TIMEDTEXT_TRANSLATE"; // 页面世界 -> 内容脚本：请求翻译
  var REWRITE_MSG = "KISS_TIMEDTEXT_REWRITE"; // 内容脚本 -> 页面世界：译文回推
  var TRANSLATE_TIMEOUT_MS = 20000; // 翻译等待上限；超时放行原文，缓存继续填充

  // requestKey -> Map(归一化原文 -> 译文)
  var cache = new Map();
  // requestKey -> Promise<Map>（在途翻译去重）
  var inflight = new Map();

  function norm(text) {
    return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  }

  /**
   * 归一化 timedtext URL：强制 fmt=json3 并生成稳定缓存键。
   * 缓存键排除签名/过期类参数，使不同批次的请求共享同一份译文映射。
   */
  function urlInfo(rawUrl) {
    var url = String(rawUrl || "");
    var key = url;
    try {
      var u = new URL(url, window.location.origin);
      var p = u.searchParams;
      if ((p.get("fmt") || "") !== "json3") {
        p.set("fmt", "json3");
        url = u.toString();
      }
      key = [
        p.get("v") || "",
        p.get("lang") || "",
        p.get("kind") || "",
        p.get("name") || "",
        p.get("tlang") || "",
      ].join("|");
    } catch (e) {}
    return { url: url, key: key };
  }

  function parseJson3(text) {
    try {
      var parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.events)) {
        return parsed.events;
      }
    } catch (e) {}
    return null;
  }

  /** 提取事件中的唯一非空文本行（保序）。 */
  function collectLines(events) {
    var lines = [];
    var seen = new Set();
    for (var i = 0; i < (events || []).length; i++) {
      var segs = events[i].segs || [];
      for (var j = 0; j < segs.length; j++) {
        var t = norm(segs[j].utf8);
        if (t && !seen.has(t)) {
          seen.add(t);
          lines.push(t);
        }
      }
    }
    return lines;
  }

  /**
   * 用译文映射替换事件文本段。
   * 未命中的段落丢弃；整句完全没有译文的保留原事件（宁可显示原文不留空洞）。
   */
  function applyTranslationMap(events, map) {
    var out = [];
    for (var i = 0; i < (events || []).length; i++) {
      var ev = events[i];
      if (!ev.segs || !ev.segs.length) {
        out.push(ev);
        continue;
      }
      var segs = [];
      for (var j = 0; j < ev.segs.length; j++) {
        var k = norm(ev.segs[j].utf8);
        var tr = k ? map.get(k) : null;
        if (tr) {
          var copy = {};
          for (var field in ev.segs[j]) copy[field] = ev.segs[j][field];
          copy.utf8 = tr;
          segs.push(copy);
        }
      }
      if (!segs.length) {
        out.push(ev);
      } else {
        var evCopy = {};
        for (var f in ev) evCopy[f] = ev[f];
        evCopy.segs = segs;
        out.push(evCopy);
      }
    }
    return out;
  }

  /**
   * 向内容脚本请求翻译并等待回推。
   * 返回 Promise<Map>；超时或失败返回 null。
   */
  function requestTranslation(requestKey, url, lines) {
    var existing = inflight.get(requestKey);
    if (existing) return existing;

    var promise = new Promise(function (resolve) {
      var finished = false;

      var timer = setTimeout(function () {
        cleanup();
        resolve(null);
      }, TRANSLATE_TIMEOUT_MS);

      function handler(event) {
        var d = event.data;
        if (
          event.source !== window ||
          !d ||
          d.type !== REWRITE_MSG ||
          d.requestKey !== requestKey
        ) {
          return;
        }
        var map = new Map();
        if (d.lines && d.translations) {
          for (var i = 0; i < d.lines.length; i++) {
            if (d.translations[i]) {
              map.set(d.lines[i], d.translations[i]);
            }
          }
        }
        cleanup();
        resolve(map);
      }

      function cleanup() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        inflight.delete(requestKey);
      }

      window.addEventListener("message", handler);
      window.postMessage(
        { type: TRANSLATE_MSG, requestKey: requestKey, url: url, lines: lines },
        window.location.origin
      );
    });

    inflight.set(requestKey, promise);
    return promise;
  }

  /**
   * 取得原始 json3 文本并确保译文映射已入缓存。
   * 返回是否成功（false 表示格式不支持或翻译失败，调用方放行原文）。
   */
  function ensureTranslated(url, originalText) {
    var info = urlInfo(url);
    var events = parseJson3(originalText);
    if (!events || !events.length) return Promise.resolve(false);

    var cached = cache.get(info.key);
    if (cached && cached.size) return Promise.resolve(true);

    var lines = collectLines(events);
    if (!lines.length) return Promise.resolve(false);

    return requestTranslation(info.key, info.url, lines).then(function (map) {
      if (map && map.size) {
        cache.set(info.key, map);
        return true;
      }
      return false;
    });
  }

  /** 用缓存映射改写 json3 文本；无可用映射时返回 null。 */
  function rewriteText(rawUrl, originalText) {
    var info = urlInfo(rawUrl);
    var map = cache.get(info.key);
    if (!map || !map.size) return null;
    var events = parseJson3(originalText);
    if (!events) return null;
    return JSON.stringify({ events: applyTranslationMap(events, map) });
  }

  function isTargetUrl(url) {
    return (
      url &&
      url.indexOf("timedtext") !== -1 &&
      url.indexOf("tlang=") === -1 // 用户已选 YouTube 自带翻译的请求不处理
    );
  }

  // ---------- Hook fetch ----------
  var originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      var rawUrl = "";
      try {
        rawUrl = typeof input === "string" ? input : (input && input.url) || "";
      } catch (e) {}

      if (!isTargetUrl(rawUrl)) {
        return originalFetch.apply(this, arguments);
      }

      // 强制 json3：字符串 URL 直接替换；Request 对象降级为同 URL 的普通请求
      var info = urlInfo(rawUrl);
      var fetchArgs =
        typeof input === "string"
          ? [info.url, init]
          : [new Request(info.url, { method: "GET", headers: {} })];

      return originalFetch
        .apply(this, fetchArgs)
        .then(function (response) {
          if (!response || !response.ok) return response;
          return response
            .clone()
            .text()
            .then(function (text) {
              return ensureTranslated(rawUrl, text).then(function (ok) {
                if (!ok) return response;
                var rewritten = rewriteText(rawUrl, text);
                if (!rewritten) return response;
                var headers = new Headers(response.headers);
                headers.delete("content-length");
                headers.delete("content-encoding");
                return new Response(rewritten, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: headers,
                });
              });
            })
            .catch(function () {
              return response;
            });
        });
    };
  }

  // ---------- Hook XMLHttpRequest ----------
  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__kissUrl = typeof url === "string" ? url : (url && url.url) || "";
    } catch (e) {}
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var args = arguments;
    var rawUrl = xhr.__kissUrl || "";

    if (!isTargetUrl(rawUrl)) {
      return originalSend.apply(this, args);
    }

    var info = urlInfo(rawUrl);

    // 缓存命中时跳过预取：少消耗一次字幕请求配额（部分响应会因令牌校验返回空体），
    // 直接放行播放器请求，在响应读取阶段用缓存映射改写。
    var cached = cache.get(info.key);
    var prefetch =
      cached && cached.size
        ? Promise.resolve(true)
        : originalFetch(info.url)
            .then(function (r) {
              return r.ok ? r.text() : "";
            })
            .then(function (text) {
              return text ? ensureTranslated(rawUrl, text) : false;
            })
            .catch(function () {
              return false;
            });

    return prefetch.then(function () {
      // 以 json3 版本的 URL 发起播放器自己的请求（签名等参数保持原样）
      try {
        originalOpen.call(xhr, xhr.__kissMethod || "GET", info.url, true);
      } catch (e) {}

      xhr.addEventListener("readystatechange", function () {
        if (xhr.readyState !== 4 || xhr.status !== 200) return;
        try {
          var text = xhr.responseText;
          var rewritten = rewriteText(rawUrl, text);
          if (rewritten) {
            Object.defineProperty(xhr, "responseText", {
              value: rewritten,
              configurable: true,
            });
            Object.defineProperty(xhr, "response", {
              value: rewritten,
              configurable: true,
            });
          }
        } catch (e) {}
      });

      return originalSend.apply(xhr, args);
    });
  };

  // 记录 open 的 method 供延迟 send 时复用
  var originalOpenRaw = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__kissMethod = method;
    } catch (e) {}
    return originalOpenRaw.apply(this, arguments);
  };
}

// ---------------------------------------------------------------------------
// 以下纯函数仅供单元测试使用，逻辑与上方注入器内部实现保持同步。
// 注入器本体因序列化约束无法直接引用这些导出（见文件头说明）。
// ---------------------------------------------------------------------------

/** 归一化文本用作匹配键。 */
export function normalizeKey(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

/** 从 json3 events 提取去重后的文本行。 */
export function extractTextLines(events) {
  const lines = [];
  const seen = new Set();
  for (const ev of events || []) {
    for (const seg of ev.segs || []) {
      const t = normalizeKey(seg.utf8);
      if (t && !seen.has(t)) {
        seen.add(t);
        lines.push(t);
      }
    }
  }
  return lines;
}

/** 用译文映射改写 events；整句无译文时保留原事件。 */
export function applyTranslationToEvents(events, translationMap) {
  return (events || []).map((ev) => {
    if (!ev.segs?.length) return ev;
    const segs = [];
    for (const seg of ev.segs) {
      const key = normalizeKey(seg.utf8);
      const tr = key ? translationMap.get(key) : null;
      if (tr) segs.push({ ...seg, utf8: tr });
    }
    return segs.length ? { ...ev, segs } : ev;
  });
}
