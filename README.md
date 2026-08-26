# KISS Translator 简约翻译

[English](README.en.md) | [中文](README.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

一个简约、开源的 [双语对照翻译扩展 & 油猴脚本](https://github.com/fishjar/kiss-translator)。

[kiss-translator.webm](https://github.com/fishjar/kiss-translator/assets/1157624/f7ba8a5c-e4a8-4d5a-823a-5c5c67a0a47f)

## 特性

- [x] 保持简约
- [x] 开放源代码
- [x] 适配常见浏览器
  - [x] Chrome/Edge
  - [x] Firefox
  - [x] Kiwi (Android)
  - [x] Orion (iOS)
  - [x] Safari
  - [x] Thunderbird
- [x] 支持多种翻译服务
  - [x] Google/Microsoft
  - [x] Tencent/Volcengine
  - [x] OpenAI/Gemini/Claude/Ollama/DeepSeek/OpenRouter/OrcaRouter
  - [x] DeepL/DeepLX
  - [x] AzureAI/CloudflareAI
  - [x] Chrome浏览器内置AI翻译(BuiltinAI)
- [x] 覆盖常见翻译场景
  - [x] 网页双语对照翻译
  - [x] 输入框翻译
    - 通过快捷键立即将输入框内文本翻译成其他语言
  - [x] 划词翻译
    - [x] 任意页面打开翻译框，可用多种翻译服务对比翻译
    - [x] 英文词典翻译
    - [x] 收藏词汇
  - [x] 鼠标悬停翻译
  - [x] YouTube 字幕翻译
    - 支持任意翻译服务对视频字幕进行翻译并双语显示
    - 内置基础的字幕合并与断句算法，提升翻译效果
    - 支持AI断句功能，可进一步提升翻译质量
    - 自定义字幕样式
- [x] 支持多样翻译效果
  - [x] 支持自动识别文本与手动规则两种模式
    - 自动识别文本模式使得绝大部分网站无需编写规则也能翻译完整
    - 手动规则模式，可以针对特定网站极致优化
  - [x] 自定义译文样式
  - [x] 支持富文本翻译及显示，能够尽量保留原文中的链接及其他文本样式
  - [x] 支持仅显示译文（隐藏原文）
- [x] 翻译接口高级功能
  - [x] 通过自定义接口，理论上支持任何翻译接口
  - [x] 聚合批量发送翻译文本
  - [x] 支持流式传输，实时显示翻译结果
  - [x] 支持AI上下文会话记忆功能，提升翻译效果
  - [x] 自定义AI术语词典
  - [x] 所有接口均支持Hook和自定义参数等高级功能
- [x] 跨客户端数据同步
  - [x] KISS-Worker（cloudflare/docker）
  - [x] WebDAV
- [x] 自定义翻译规则
  - [x] 规则订阅/规则分享
  - [x] 自定义专业术语
- [x] 自定义快捷键
  - `Alt+Q` 开启翻译
  - `Alt+C` 切换样式
  - `Alt+K` 打开设置弹窗
  - `Alt+S` 打开翻译弹窗/翻译选中文字
  - `Alt+O` 打开设置页面
  - `Alt+I` 输入框翻译

---

## 🎬 视频字幕纯译文模式（feat-native-caption-inplace 分支）

> **分支**：[`feat-native-caption-inplace`](https://github.com/wochatchat/kiss-translator/tree/feat-native-caption-inplace)
> **状态**：已在安卓 x浏览器 油猴 + m.youtube.com 真机验证通过
> **效果**：只显示译文字幕，彻底消除原/译字幕交替闪跳

### 方案原理：三层递进防御

复刻沉浸式翻译的核心理念——**不与 YouTube 对抗渲染权，而是在数据源头把字幕换成中文**：

```
┌─ 第一层：timedtext 响应改写（主防线）
│    页面世界 hook fetch/XHR，拦截 /api/timedtext 字幕请求，
│    翻译后直接回写响应体 → 播放器拿到的"原字幕"就是中文
│
├─ 第二层：DOM 原位替换（兜底）
│    MutationObserver 监听 .ytp-caption-segment，
│    已知映射的英文 cue 在绘制前被原地替换为译文
│
└─ 第三层：就地主动翻译（最后防线）
     三层映射都未命中的英文文本，当场发起翻译并立即上屏
```

无论播放器用 DOM 还是 TextTrack 渲染，任何漏网英文都会被后两层接住。

### 关键实现位置

| 文件 | 职责 |
|---|---|
| `src/injectors/timedtextRewrite.js` | 页面世界注入器：fetch/XHR 双拦截、json3 解析、请求级缓存（键剥离签名参数）、阻塞式预取、响应体回写。**必须完全自包含**（油猴按 `(${fn})()` 序列化注入，模块级导入在页面世界不存在） |
| `src/subtitle/nativeCaptionInplace.js` | DOM 兜底渲染器：MutationObserver 原位替换、`ingestTranslations()` 接收译文映射、主动翻译通道（pending 归一化去重）、空窗口收缩、字号锁定 |
| `src/subtitle/YouTubeCaptionProvider.js` | 翻译调度中枢：`#translateLines()` 公共批量翻译（复用 apiTranslate 全管线）、`#translateForRewrite()` 推送译文给注入器与 DOM 层 |
| `src/subtitle/subtitle.js` | 站点匹配入口：providers[] 必须同时包含 `www.youtube.com` 与 **`m.youtube.com`**（移动端 UA 被 302，漏配则整个模块不启动） |

### 关键配置开关

```js
// src/config/setting.js — DEFAULT_SUBTITLE_SETTING
inplaceRender: true   // true=纯译文模式（本分支方案）；false=回退旧双语悬浮层
```

### 踩坑记录（重要）

1. **m.youtube.com 未匹配**：移动端访问域名是 `m.`，只配 `www.youtube.com` 会导致字幕模块静默不启动——所有下游修复都是死代码。真机问题先用诊断脚本拿事实，不要盲改。
2. **注入器序列化陷阱**：函数体内引用模块级常量/helper 会在序列化后变 ReferenceError，一拦截就崩。
3. **字幕分块流式加载**：同一视频会发多个分段请求，每段独立翻译；缓存命中时应跳过预取（省配额，且部分请求因移动端 POT 令牌校验返回空体）。
4. **YouTube 动态字号**：YT 按 cue 文本长度实时调整 inline font-size，原位替换改变文本长度会触发尺寸抖动——用 `!important` 锁定字号并禁用容器内 transition。
5. **空白大框**：结构重建中间态/空响应会产生"已扩容无内容"的 cue 容器——`:empty` 隐藏 + 无可见文本时收缩整个窗口。

### 构建产物

```bash
pnpm build:web   # 产物: build/web/kiss-translator.user.js（油猴单文件）
```

---

## 安装

> 注：基于以下原因，建议优先使用浏览器扩展
>
> - 浏览器扩展的功能更完整（本地语言识别、右键菜单等）
> - 油猴脚本会遇到更多使用上的问题（跨域问题、脚本冲突等）

- [x] 浏览器扩展
  - [x] Chrome [安装地址](https://chrome.google.com/webstore/detail/kiss-translator/bdiifdefkgmcblbcghdlonllpjhhjgof?hl=zh-CN)
    - [x] Kiwi (Android)
    - [x] Orion (iOS)
  - [x] Edge [安装地址](https://microsoftedge.microsoft.com/addons/detail/%E7%AE%80%E7%BA%A6%E7%BF%BB%E8%AF%91/jemckldkclkinpjighnoilpbldbdmmlh?hl=zh-CN)
  - [x] Firefox [安装地址](https://addons.mozilla.org/zh-CN/firefox/addon/kiss-translator/)
  - [ ] Safari
    - [ ] Safari (Mac)
    - [ ] Safari (iOS) 
  - [x] Thunderbird [下载地址](https://github.com/fishjar/kiss-translator/releases)
- [x] 油猴脚本
  - [x] Chrome/Edge/Firefox ([Tampermonkey](https://www.tampermonkey.net/)/[Violentmonkey](https://violentmonkey.github.io/)) [安装链接](https://fishjar.github.io/kiss-translator/kiss-translator.user.js)
    - [Greasy Fork](https://greasyfork.org/zh-CN/scripts/472840-kiss-translator)
  - [x] iOS Safari ([Userscripts Safari](https://github.com/quoid/userscripts)) [安装链接](https://fishjar.github.io/kiss-translator/kiss-translator-ios-safari.user.js)

## 关联项目

- 数据同步服务: [https://github.com/fishjar/kiss-worker](https://github.com/fishjar/kiss-worker)
  - 可用于本项目的数据同步服务。
  - 亦可用于分享个人的私有规则列表。
  - 自己部署，自己管理，数据私有。
- 社区订阅规则: [https://github.com/fishjar/kiss-rules](https://github.com/fishjar/kiss-rules)
  - 提供社区维护的，最新最全的订阅规则列表。
  - 求助规则相关的问题。

## 常见问题

### 如何设置快捷键

在插件管理那里设置，例如： 

- chrome [chrome://extensions/shortcuts](chrome://extensions/shortcuts)
- firefox [about:addons](about:addons)

### 规则设置的优先级是如何的

个人规则 > 订阅规则 > 全局规则

其中全局规则优先级最低，但非常重要，相当于兜底规则。

### 接口（Ollama等）测试失败

一般接口测试失败常见有以下几种原因：

- 地址填错了：
  - 比如 `Ollama` 有原生接口地址和 `Openai` 兼容的地址，本插件目前统一支持 `Openai` 兼容的地址，不支持 `Ollama` 原生接口地址
- 某些AI模型不支持聚合翻译：
  - 此种情况可以选择禁用聚合翻译或通过自定义接口的方式来使用。
  - 或通过自定义接口的方式来使用，详情参考： [自定义接口示例文档](https://github.com/fishjar/kiss-translator/blob/master/custom-api_v2.md)
- 某些AI模型的参数不一致：
  - 比如 `Gemini` 原生接口参数非常不一致，部分版本的模型不支持某些参数会导致返回错误。
  - 此种情况可以通过 `Hook` 修改请求 `body` ,或者更换为 `Gemini2` (`Openai` 兼容的地址)
- 服务器跨域限制访问，返回403错误：
  - 比如 `Ollama` 启动时须添加环境变量 `OLLAMA_ORIGINS=*`, 参考：https://github.com/fishjar/kiss-translator/issues/174

### 填写的接口在油猴脚本不能使用

油猴脚本需要增加域名白名单，否则不能发出请求。

### 如何设置自定义接口的hook函数

自定义接口功能非常强大、灵活，理论可以接入任何翻译接口。

示例参考： [custom-api_v2.md](https://github.com/fishjar/kiss-translator/blob/master/custom-api_v2.md)

### 如何直接进入油猴脚本设置页面

设置页面地址： https://fishjar.github.io/kiss-translator/options.html

## 未来规划 

 本项目为业余开发，无严格时间表，欢迎社区共建。以下为初步设想的功能方向：

- [x] **聚合发送文本**：优化请求策略，减少翻译接口调用次数，提升性能。
- [x] **增强富文本翻译**：支持更复杂的页面结构和富文本内容的准确翻译。
- [x] **强化自定义/AI 接口**：支持流式传输、上下文记忆、多轮对话等高级 AI 功能。
- [x] **英文词典备灾机制**：当翻译服务失效时，可切换其他词典或 fallback 到本地词典查询。
- [x] **优化 YouTube 字幕支持**：改进流式字幕的合并与翻译体验，减少断句。
- [ ] **规则共建机制升级**：引入更灵活的规则分享、版本管理与社区评审流程。
 
 如果你对某个方向感兴趣，欢迎在 [Issues](https://github.com/fishjar/kiss-translator/issues) 中讨论或提交 PR！

## 开发指引

```sh
git clone https://github.com/fishjar/kiss-translator.git
cd kiss-translator
git checkout dev # 提交PR建议推送到dev分支
pnpm install
pnpm build
```

### 外部触发示例

```js
// `toggle_translate`   切换翻译
// `toggle_styles`      切换样式
// `toggle_popup`       打开/关闭控制面板
// `toggle_transbox`    打开/关闭翻译弹窗
// `toggle_hover_node`  翻译鼠标悬停段落
// `input_translate`    翻译输入框
window.dispatchEvent(new CustomEvent("kiss_translator", {detail: { action: "toggle_translate" }}));
```

## 交流

- 加入 [Telegram 群](https://t.me/+RRCu_4oNwrM2NmFl)

## 赞赏

![appreciate](https://github.com/fishjar/kiss-translator/assets/1157624/ebaecabe-2934-4172-8085-af236f5ee399)

## 赞助商

<p align="center">
<a href="https://platform.ephone.ai/" target="_blank">
<img src="https://platform.ephone.ai/logo-e.png" width="96" /><br />
<b>ePhone AI</b><br />
一个面向开发者的 AI 模型 API 中转与聚合平台，支持 OpenAI、Claude、Gemini、DeepSeek、GLM 等多家大模型。
</a>
</p>
