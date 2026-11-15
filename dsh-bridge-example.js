/**
 * DSH 扩展桥接示例 —— 把本文件内容放进 dsh 前端（页面加载时执行一次），
 * 或在 index.html 里以 <script src="./dsh-bridge-example.js"></script> 引入。
 *
 * 扩展 → dsh 的消息（由 window.parent postMessage 进来）：
 *   { source: "dsh-extension", type: "hello",        payload: { version } }
 *   { source: "dsh-extension", type: "page-content", payload: { url, title, text, selection, auto } }
 *   { source: "dsh-extension", type: "selection",    payload: { text, url, title, auto, resend? } }
 *   { source: "dsh-extension", type: "quote",        payload: { text, url, title, auto: false, resend? } }
 *   { source: "dsh-extension", type: "page-error",   payload: { message, auto } }
 *
 *   auto=true  表示扩展自动推送（iframe 加载 / 切换标签页时）
 *   auto=false 表示用户显式操作（点浮动按钮「引用到 DSH」或面板里的「重发」）
 *
 * dsh → 扩展（可选，反向请求）：
 *   window.parent.postMessage({ source: "dsh", type: "request-page" }, "*");
 *   window.parent.postMessage({ source: "dsh", type: "request-selection" }, "*");
 */
(function () {
  if (window.__dshExtensionBridge) return;
  window.__dshExtensionBridge = true;

  const FROM_EXT = "dsh-extension";
  const TO_EXT = "dsh";

  function send(msg) {
    // 父窗口是扩展页面（chrome-extension://…），
    // 优先用 ancestorOrigins 精确指定 targetOrigin，拿不到时退化为 "*"
    const parentOrigin =
      window.location.ancestorOrigins && window.location.ancestorOrigins.length
        ? window.location.ancestorOrigins[0]
        : "*";
    window.parent.postMessage({ source: TO_EXT, ...msg }, parentOrigin);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.source !== FROM_EXT) return;

    // ① 统一派发成 DOM 事件，dsh 应用里这样监听：
    //    window.addEventListener("dsh-extension", (e) => {
    //      console.log(e.detail.type, e.detail.payload);
    //    });
    window.dispatchEvent(new CustomEvent("dsh-extension", { detail: msg }));

    // ②（可选示例）收到显式引用时，自动填进输入框，按 dsh 自己的 UI 调整。
    if (msg.type === "quote" && msg.payload && msg.payload.text) {
      const input = document.querySelector("[data-dsh-input], textarea");
      if (input && typeof input.value === "string") {
        input.value += (input.value ? "\n" : "") + msg.payload.text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  });

  window.dshExtension = {
    requestPage: () => send({ type: "request-page" }),
    requestSelection: () => send({ type: "request-selection" }),
  };
})();
