/* DSH 侧边栏 — dsh 页面自动桥（注入到 dsh 自己的标签页/iframe，isolated world）
 *
 * 让 dsh 应用无需任何接入代码即可收到扩展消息：
 *  1. 监听父窗口（面板）postMessage 进来的扩展消息
 *  2. 以 CustomEvent「dsh-extension」派发给 dsh 应用（已接入的应用监听此事件）
 *  3. quote（显式引用）自动写入 dsh 的对话输入框并聚焦——用户接着输入提问，
 *     发送时引用与提问一起提交
 */
(() => {
  "use strict";

  if (window.__dshAutoBridgeInjected) return;
  window.__dshAutoBridgeInjected = true;

  /* 注入标记（主世界可见，供调试确认） */
  try {
    const set = () => {
      if (document.documentElement) document.documentElement.dataset.dshAutoBridge = "1";
    };
    if (document.documentElement) set();
    else document.addEventListener("DOMContentLoaded", set);
  } catch {
    /* 忽略 */
  }

  /* 找 dsh 的对话输入框：role=textbox + contenteditable 的可见元素，
   * 多个时取最靠下的（聊天输入通常在底部）。排除"闪记"等 textarea 编辑器。 */
  function findChatInput() {
    const boxes = Array.from(
      document.querySelectorAll('[role="textbox"][contenteditable="true"], [contenteditable="true"][role="textbox"]'),
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 50 && r.height > 15;
    });
    if (!boxes.length) return null;
    boxes.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return boxes[boxes.length - 1];
  }

  /* 把引用块写入对话输入框（只走 paste 事件这一条通路，只发一次）：
   * dsh 的编辑器是受控组件，会撤销一切绕过它管线的 DOM 操作（execCommand
   * 不可靠），而 paste 事件由编辑器自身处理，确定性生效。 */
  function fillQuoteIntoDialog(msg) {
    const input = findChatInput();
    if (!input) return false;
    const p = msg.payload || {};
    const title = String(p.title || "网页").replace(/\s+/g, " ").trim().slice(0, 60);
    const url = String(p.url || "").slice(0, 200);
    const text = String(p.text || "");
    if (!text) return false;
    /* 每行加 "> " 前缀（markdown 引用块），便于 dsh 渲染与识别 */
    const quoted = text
      .split("\n")
      .map((line) => "> " + line)
      .join("\n");
    const block = `【引用源｜${title} | ${url}】\n${quoted}\n\n`;

    input.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    const dt = new DataTransfer();
    dt.setData("text/plain", block);
    input.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
    return true;
  }

  function deliver(msg) {
    try {
      window.dispatchEvent(new CustomEvent("dsh-extension", { detail: msg }));
    } catch {
      /* 忽略 */
    }
    try {
      document.documentElement.dataset.dshLastExtType = String(msg.type || "");
      document.documentElement.dataset.dshLastExtAt = String(Date.now());
    } catch {
      /* 忽略 */
    }
    /* 显式引用 → 写入对话输入框（自动 selection 不填，避免污染输入框） */
    if (msg.type === "quote") {
      fillQuoteIntoDialog(msg);
    }
    /* 面板框架上滚轮转发来的缩放步进 */
    if (msg.type === "zoom-delta") {
      applyPageZoom(pageZoom + ((msg.payload && msg.payload.delta) || 0));
    }
  }

  /* 父窗口（面板）postMessage 进来的扩展消息 */
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.source !== "dsh-extension") return;
    deliver(msg);
  });

  /* 向面板回报 dsh 内部连接状态（重连提示出现/消失），
   * 让面板能显式提示用户并提供一键重载 */
  function reportToParent(type) {
    try {
      const parentOrigin =
        window.location.ancestorOrigins && window.location.ancestorOrigins.length
          ? window.location.ancestorOrigins[0]
          : "*";
      window.parent.postMessage({ source: "dsh", type }, parentOrigin);
    } catch {
      /* 忽略 */
    }
  }

  /* 连接状态监视：dsh 出现「重新连接中/连接中断」时回报面板。
   * innerText 读取会强制 reflow，不能用定时器无条件轮询——
   * 改为 MutationObserver 监听 DOM 变化，变化后 1.5s 去抖检查一次。 */
  let lastReconnecting = null;
  let reconnectCheckTimer = 0;
  function checkReconnect() {
    try {
      const t = document.body ? document.body.innerText : "";
      const bad = t.includes("重新连接中") || t.includes("连接中断");
      if (bad !== lastReconnecting) {
        lastReconnecting = bad;
        reportToParent(bad ? "dsh-reconnecting" : "dsh-reconnected");
      }
    } catch {
      /* 忽略 */
    }
  }
  if (document.body) checkReconnect();
  else document.addEventListener("DOMContentLoaded", checkReconnect);
  new MutationObserver(() => {
    clearTimeout(reconnectCheckTimer);
    reconnectCheckTimer = setTimeout(checkReconnect, 1500);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  /* 点击 dsh 页面任意处 → 通知面板收起 ⚙ 下拉菜单
   * （跨进程 iframe 的点击事件面板收不到，连窗口 blur 都不触发） */
  window.addEventListener("pointerdown", () => reportToParent("dsh-menu-dismiss"), true);

  /* ============ 页面缩放（Ctrl+滚轮，只缩放 dsh 页面内容，面板框架不动）============
   * 缩放应用在 dsh 文档根元素上，持久化到扩展 storage；鼠标悬停在 iframe 上时
   * 滚轮事件在这里直接处理（面板脚本收不到 iframe 内的滚轮），悬停在面板框架
   * 上时由面板转发 zoom-delta 消息。 */
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2;
  let pageZoom = 1;
  let zoomToastTimer = 0;

  function showZoomToast() {
    let toast = document.getElementById("__dsh-zoom-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "__dsh-zoom-toast";
      toast.style.cssText =
        "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:rgba(30,30,34,.85);color:#fff;" +
        "font:600 13px/1 system-ui,sans-serif;padding:8px 12px;border-radius:8px;pointer-events:none;transition:opacity .25s;";
      (document.body || document.documentElement).appendChild(toast);
    }
    toast.textContent = Math.round(pageZoom * 100) + "%";
    toast.style.opacity = "1";
    clearTimeout(zoomToastTimer);
    zoomToastTimer = setTimeout(() => {
      toast.style.opacity = "0";
    }, 900);
  }

  let zoomSaveTimer = 0;
  function applyPageZoom(z) {
    pageZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));
    document.documentElement.style.zoom = pageZoom === 1 ? "" : String(pageZoom);
    /* 连续缩放时只落最后一次，避免每个滚轮步进都写 storage */
    clearTimeout(zoomSaveTimer);
    zoomSaveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ pageZoom });
      } catch {
        /* 忽略 */
      }
    }, 500);
    showZoomToast();
  }

  try {
    chrome.storage.local.get(["pageZoom"], (res) => {
      if (res && res.pageZoom) applyPageZoom(Number(res.pageZoom) || 1);
    });
  } catch {
    /* 忽略 */
  }

  window.addEventListener(
    "wheel",
    (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      applyPageZoom(pageZoom + (ev.deltaY < 0 ? 0.1 : -0.1));
    },
    { passive: false },
  );
})();
