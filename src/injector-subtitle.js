import { TimedTextRewriteInjector } from "./injectors/timedtextRewrite";

// 启动 timedtext 响应改写注入器（页面世界）：
// 拦截 YouTube 字幕请求，把内容脚本推回的译文直接写入响应体，
// 让播放器拿到的"原字幕数据"就是中文 —— 单一数据源，任何渲染方式都无闪跳。
TimedTextRewriteInjector();
