/* DSH 侧边栏 — 内容脚本
 *
 * 职责：
 *  1. 响应侧边栏请求（DSH_PING / DSH_GET_PAGE），提取页面 标题 / URL / 正文文本 / 当前选区
 *  2. 监听页面选中文本，自动上报给侧边栏（DSH_SELECTION）
 *  3. 在选区附近显示「引用到 DSH」浮动按钮，点击后显式引用（DSH_QUOTE）
 *
 * 说明：只在顶层框架运行；输入框内的选区不触发引用。
 */
(() => {
  "use strict";

  if (window.__dshSidebarInjected) return;
  window.__dshSidebarInjected = true;

  const MAX_TEXT_CHARS = 200000; // 页面正文最多提取的字符数
  const SELECT_DEBOUNCE_MS = 250;
  const FEEDBACK_MS = 900;

  /* ---------------- 页面信息提取 ---------------- */

  function pageTitle() {
    return document.title || "";
  }

  function pageText() {
    let text = "";
    try {
      text =
        (document.body && document.body.innerText) ||
        (document.documentElement && document.documentElement.innerText) ||
        "";
    } catch {
      text = "";
    }
    text = String(text)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) + "\n\n…（内容过长，已截断）";
    }
    return text;
  }

  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
    return sel.toString().trim();
  }

  function selectionSnapshot() {
    return { text: currentSelection(), url: location.href, title: pageTitle(), at: Date.now() };
  }

  function pageSnapshot() {
    return {
      url: location.href,
      title: pageTitle(),
      text: pageText(),
      selection: currentSelection(),
    };
  }

  /* ---------------- 响应侧边栏请求 ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "DSH_PING") {
      sendResponse({ ok: true });
    } else if (msg.type === "DSH_GET_PAGE") {
      try {
        sendResponse({ ok: true, payload: pageSnapshot() });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    }
  });

  function sendRuntime(message) {
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === "function") p.catch(() => {}); // 侧边栏未打开时静默
    } catch {
      /* 扩展重载后旧页面上下文失效，忽略 */
    }
  }

  /* ---------------- 选区监听与上报 ---------------- */

  let lastAutoSent = "";
  let selectTimer = 0;
  let dismissedSelection = ""; // × 关闭时记下的选区：选区未变前不再弹浮动
  let quoteFloatEnabled = true; // ⚙ 菜单「打开/关闭引用浮动面板」，storage 同步

  try {
    chrome.storage.local.get(["quoteFloatEnabled"], (res) => {
      quoteFloatEnabled = !(res && res.quoteFloatEnabled === false);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.quoteFloatEnabled) {
        quoteFloatEnabled = !!changes.quoteFloatEnabled.newValue;
        if (!quoteFloatEnabled) hideQuoteButton();
      }
    });
  } catch {
    /* storage 不可用时保持默认开启 */
  }

  function reportSelection(explicit) {
    const snap = selectionSnapshot();
    if (!snap.text) return;
    if (!explicit && snap.text === lastAutoSent) return;
    lastAutoSent = snap.text;
    sendRuntime({ type: explicit ? "DSH_QUOTE" : "DSH_SELECTION", payload: snap });
  }

  document.addEventListener("selectionchange", () => {
    clearTimeout(selectTimer);
    selectTimer = setTimeout(() => {
      const sel = window.getSelection();
      const el = document.activeElement;
      const inEditable =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable === true);
      const text =
        sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.toString().trim() : "";

      if (inEditable || !text) {
        dismissedSelection = ""; // 选区已折叠/清空，解除本次关闭
        hideQuoteButton();
        return;
      }
      if (!quoteFloatEnabled) {
        // 浮动面板被 ⚙ 菜单关闭：仍上报选区，但不显示浮动按钮
        dismissedSelection = "";
        reportSelection(false);
        return;
      }
      if (dismissedSelection && text === dismissedSelection) {
        // 用户已用 × 关闭本次悬浮；点击 × 可能触发多余的 selectionchange，
        // 同一选区未变之前不再弹出
        hideQuoteButton();
        return;
      }
      dismissedSelection = "";
      placeQuoteButton(sel);
      reportSelection(false);
    }, SELECT_DEBOUNCE_MS);
  });

  window.addEventListener("scroll", hideQuoteButton, { passive: true, capture: true });
  window.addEventListener("resize", hideQuoteButton);
  window.addEventListener("blur", hideQuoteButton);

  /* ---------------- 浮动「引用到 DSH」按钮 ----------------
   * 放在 closed Shadow DOM 里，避免被页面 CSS / 脚本影响。
   */

  let quoteHost = null;
  let quoteWrap = null;
  let quoteButton = null;
  let feedbackTimer = 0;

  function ensureQuoteButton() {
    if (quoteButton) return quoteButton;

    quoteHost = document.createElement("div");
    quoteHost.style.cssText =
      "all: initial; position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;";
    const shadow = quoteHost.attachShadow({ mode: "closed" });

    /* 主按钮 + 右上角 × 的组合（flex 顶对齐） */
    quoteWrap = document.createElement("div");
    quoteWrap.style.cssText =
      "display: flex; align-items: flex-start; gap: 3px; pointer-events: none; opacity: 0; transition: opacity .12s ease;";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "引用到 DSH";
    Object.assign(btn.style, {
      all: "initial",
      boxSizing: "border-box",
      pointerEvents: "auto",
      padding: "4px 9px",
      borderRadius: "999px",
      border: "1px solid rgba(255,255,255,.28)",
      background: "linear-gradient(180deg, #6366f1, #4f46e5)",
      color: "#fff",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif",
      fontSize: "11px",
      lineHeight: "1.2",
      fontWeight: "600",
      boxShadow: "0 4px 12px rgba(0,0,0,.22)",
      cursor: "pointer",
      whiteSpace: "nowrap",
      userSelect: "none",
    });

    /* 关闭本次悬浮的 × */
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    Object.assign(closeBtn.style, {
      all: "initial",
      boxSizing: "border-box",
      pointerEvents: "auto",
      width: "16px",
      height: "16px",
      padding: "0",
      borderRadius: "50%",
      border: "1px solid rgba(255,255,255,.35)",
      background: "rgba(30,32,44,.88)",
      color: "#fff",
      fontFamily: "system-ui, sans-serif",
      fontSize: "10px",
      lineHeight: "14px",
      textAlign: "center",
      cursor: "pointer",
      boxShadow: "0 3px 8px rgba(0,0,0,.25)",
      userSelect: "none",
    });

    // 防止点击按钮时清空当前选区
    for (const b of [btn, closeBtn]) {
      b.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
    }
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      reportSelection(true);
      btn.textContent = "已引用 ✓";
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => {
        btn.textContent = "引用到 DSH";
        hideQuoteButton();
      }, FEEDBACK_MS);
    });
    closeBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      dismissedSelection = currentSelection();
      hideQuoteButton();
    });

    quoteWrap.append(btn, closeBtn);
    shadow.appendChild(quoteWrap);
    (document.documentElement || document.body).appendChild(quoteHost);
    quoteButton = btn;
    return btn;
  }

  function placeQuoteButton(sel) {
    const btn = ensureQuoteButton();
    quoteHost.style.display = ""; // 从隐藏中恢复（测量尺寸需要可见）
    let rect = null;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch {
      hideQuoteButton();
      return;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideQuoteButton();
      return;
    }

    const gw = quoteWrap.getBoundingClientRect().width || btn.offsetWidth || 90;
    const gh = quoteWrap.getBoundingClientRect().height || btn.offsetHeight || 24;
    let x = rect.left + rect.width / 2 - gw / 2;
    let y = rect.top - gh - 8;
    if (y < 8) y = rect.bottom + 8;
    x = Math.max(8, Math.min(x, window.innerWidth - gw - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - gh - 8));

    quoteHost.style.transform =
      "translate(" + Math.round(x) + "px, " + Math.round(y) + "px)";
    quoteHost.dataset.dshQuoteRect = JSON.stringify({ x: Math.round(x), y: Math.round(y), w: Math.round(gw), h: Math.round(gh) });
    quoteHost.dataset.dshQuoteHidden = "0";
    requestAnimationFrame(() => {
      quoteWrap.style.opacity = "1";
    });
  }

  function hideQuoteButton() {
    if (!quoteHost || quoteHost.dataset.dshQuoteHidden === "1") return; // 已隐藏，跳过重复写
    quoteWrap.style.opacity = "0";
    quoteHost.style.display = "none"; // 彻底移出渲染树，杜绝残留命中区域
    quoteHost.dataset.dshQuoteHidden = "1";
  }
})();
