/* DSH 侧边栏 — 面板脚本（扩展 ↔ dsh 的桥梁）
 *
 * 面板内嵌 dsh iframe，负责：
 *  - 经内容脚本收集当前标签页内容 / 选中文本 → postMessage 给 dsh
 *  - dsh 可反向 request-page / request-selection
 *  - 本地代理：探测在线后自动把 iframe 切到代理地址（WebSocket 必需），
 *    ⚙ 菜单启动（本机消息宿主）/ 关闭（代理自关停端点）
 *  - 一键配置：生成自包含安装脚本供用户手动运行一次
 */
"use strict";

const DEFAULT_DSH_URL = "http://127.0.0.1:3080";
const PROXY_ORIGIN = "http://127.0.0.1:3081";
const CONNECT_TIMEOUT_MS = 6000;
const PROBE_TIMEOUT_MS = 4000;

const frame = document.getElementById("dsh-frame");
const dot = document.getElementById("dsh-dot");
const statusText = document.getElementById("status-text");
const errorOverlay = document.getElementById("error-overlay");
const btnReload = document.getElementById("btn-reload");
const btnRetry = document.getElementById("btn-retry");
const btnConfig = document.getElementById("btn-config");
const menu = document.getElementById("menu");
const menuUrl = document.getElementById("menu-url");
const menuProxy = document.getElementById("menu-proxy");
const menuFloat = document.getElementById("menu-float");
const menuNote = document.getElementById("menu-note");
const urlRow = document.getElementById("url-row");
const urlInput = document.getElementById("url-input");
const btnUrlSave = document.getElementById("btn-url-save");
const btnUrlCancel = document.getElementById("btn-url-cancel");
const errDesc = document.querySelector("#error-overlay .err-desc");
const connBanner = document.getElementById("conn-banner");
const btnConnReload = document.getElementById("btn-conn-reload");
const setupCard = document.getElementById("setup-card");
const setupStatus = document.getElementById("setup-status");
const btnDownloadSetup = document.getElementById("btn-download-setup");
const btnSetupCheck = document.getElementById("btn-setup-check");

let iframeReady = false;
let connectTimer = 0;
let statusFlashTimer = 0;
let lastPage = null;
let lastQuote = null;
let proxyAvailable = false;
let floatEnabled = true;

let dshUrl = DEFAULT_DSH_URL;
let dshOrigin = "http://127.0.0.1:3080";

function applyDshUrl(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    dshOrigin = u.origin;
    dshUrl = u.origin + u.pathname + u.search;
    return true;
  } catch {
    return false;
  }
}

/* iframe 实际加载地址：只取 origin + 路径，绝不带 token 查询参数——
 * dsh 对带 token 的请求优先校验 token，过期 token 会直接 401，
 * 而认证应完全由 cookie（DNR 注入）完成。代理在线时走代理地址。 */
function computeFrameUrl() {
  const u = new URL(dshUrl); // dshUrl 只经 applyDshUrl（已校验）赋值，不会抛
  return proxyAvailable ? PROXY_ORIGIN + u.pathname : u.origin + u.pathname;
}

/* ============ iframe 连接管理 ============ */

function setConnectedUI(on) {
  dot.classList.toggle("on", on);
  statusText.textContent = on ? "已连接" : "未连接";
}

function showConnectError() {
  if (iframeReady) return;
  errDesc.textContent =
    "请确认 dsh 已在 " +
    computeFrameUrl() +
    " 正常运行（dsh 重启会签发新 token，可用 ⚙ 更新地址），然后点击重试。";
  errorOverlay.hidden = false;
}

/* no-cors 探测：服务器可达即 resolve（响应不透明），连不上则 reject */
function probeUrl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  return fetch(url, { mode: "no-cors", cache: "no-store", signal: ctrl.signal })
    .then(() => true)
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

function armConnectWatchdog() {
  clearTimeout(connectTimer);
  connectTimer = setTimeout(showConnectError, CONNECT_TIMEOUT_MS);
  probeUrl(computeFrameUrl()).then((ok) => {
    if (!ok && !iframeReady) showConnectError();
  });
}

frame.addEventListener("load", async () => {
  clearTimeout(connectTimer);
  iframeReady = true;
  setConnectedUI(true);
  errorOverlay.hidden = true;

  postToDsh({
    type: "hello",
    payload: { version: chrome.runtime.getManifest().version },
  });
  await sendPageContent(true); // 自动推送当前页面
  if (lastQuote) {
    postToDsh({ type: "selection", payload: { ...lastQuote, resend: true } });
  }
});

function reloadFrame() {
  iframeReady = false;
  setConnectedUI(false);
  errorOverlay.hidden = true;
  requestSync(); // 后台同步 cookie/规则 + 探测代理 + 推送 cookie 给代理
  armConnectWatchdog();
  frame.src = computeFrameUrl(); // 重新赋值触发导航
}

/* ============ 与 dsh 的 postMessage 协议 ============ */

/* iframe 的实际源：代理在线时是代理源(3081)，否则是 dsh 源(3080)。
 * postMessage 的 targetOrigin 与来源校验都必须用它，否则消息会被浏览器静默丢弃。 */
function frameOrigin() {
  try {
    return new URL(frame.src).origin;
  } catch {
    return dshOrigin;
  }
}

function postToDsh(msg) {
  if (!iframeReady || !frame.contentWindow) return false;
  try {
    frame.contentWindow.postMessage({ source: "dsh-extension", ...msg }, frameOrigin());
    return true;
  } catch {
    return false;
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  if (event.origin !== frameOrigin()) return;
  const msg = event.data;
  if (!msg || msg.source !== "dsh" || typeof msg.type !== "string") return;
  if (msg.type === "dsh-menu-dismiss") {
    // 用户点了 dsh 页面区域（iframe 内的事件面板收不到，由注入桥转发）
    if (!menu.hidden) {
      menu.hidden = true;
      menuNote.hidden = true;
    }
    return;
  }
  if (msg.type === "dsh-reconnecting") {
    connBanner.hidden = false;
    return;
  }
  if (msg.type === "dsh-reconnected") {
    connBanner.hidden = true;
    return;
  }
  switch (msg.type) {
    case "request-page":
      sendPageContent(false);
      break;
    case "request-selection":
      postToDsh({ type: "selection", payload: lastQuote });
      break;
  }
});

btnConnReload.addEventListener("click", () => {
  connBanner.hidden = true;
  reloadFrame();
});

/* ============ 页面内容收集（经内容脚本） ============ */

async function getActiveTab() {
  const queries = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
  ];
  for (const q of queries) {
    try {
      const tabs = await chrome.tabs.query(q);
      const tab = (tabs || []).find((t) => t && t.id != null);
      if (tab) return tab;
    } catch {
      /* 继续尝试 */
    }
  }
  return null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "DSH_PING" });
    return { ok: true };
  } catch {
    // 扩展安装 / 刷新前就已打开的标签页：现场注入内容脚本后重试
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tabId, { type: "DSH_PING" });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }
}

function friendlyTabError(raw) {
  const s = String(raw || "");
  if (/Cannot access a chrome/i.test(s)) {
    return "该页面不支持读取（浏览器内置页面 / 应用商店 / 其他扩展页）";
  }
  if (/extension context/i.test(s)) return "扩展刚被重载，请刷新网页后重试";
  return "读取失败：" + s;
}

async function collectPage() {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: "未找到活动标签页" };
  const ensured = await ensureContentScript(tab.id);
  if (!ensured.ok) return { ok: false, error: friendlyTabError(ensured.error) };
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "DSH_GET_PAGE" });
    if (resp && resp.ok) return { ok: true, payload: resp.payload };
    return { ok: false, error: friendlyTabError(resp && resp.error) };
  } catch (err) {
    return { ok: false, error: friendlyTabError((err && err.message) || err) };
  }
}

async function sendPageContent(auto) {
  const result = await collectPage();
  if (!result.ok) {
    postToDsh({ type: "page-error", payload: { message: result.error, auto } });
    if (!auto) flashStatus(result.error);
    return;
  }
  const payload = result.payload;
  const unchanged =
    lastPage &&
    lastPage.url === payload.url &&
    lastPage.title === payload.title &&
    lastPage.text === payload.text;
  if (auto && unchanged) return; // 自动推送去重
  lastPage = payload;
  postToDsh({ type: "page-content", payload: { ...payload, auto } });
  if (!auto) flashStatus("页面内容已发送");
}

/* ============ 选中文本 → 引用 ============ */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "DSH_SELECTION" || msg.type === "DSH_QUOTE") {
    const explicit = msg.type === "DSH_QUOTE";
    lastQuote = {
      ...(msg.payload || {}),
      auto: !explicit,
      tabId: (sender && sender.tab && sender.tab.id) ?? null,
    };
    postToDsh({ type: explicit ? "quote" : "selection", payload: lastQuote });
  }
});

/* ============ 顶栏按钮 ============ */

btnReload.addEventListener("click", reloadFrame);

/* ============ 启动/关闭本地代理 ============
 * 启动：经「一键配置」注册的本机消息宿主（HKCU，当前用户级）拉起代理
 *       （代理文件在 %LOCALAPPDATA%\DSHSidebarProxy，持久保存）。
 * 关闭：直接调用代理自身的 /__dsh_shutdown 端点，无需宿主。
 * 宿主未注册 / 代理文件缺失时给出下载引导。 */
function startProxyViaNative() {
  let port;
  try {
    port = chrome.runtime.connectNative("com.dsh.proxy.host");
  } catch (err) {
    flashStatus("启动失败: " + String((err && err.message) || err));
    return;
  }
  let settled = false;
  const showSetupHint = (text) => {
    menuNote.textContent = text;
    menuNote.hidden = false;
    menu.hidden = false;
  };
  port.onMessage.addListener((resp) => {
    settled = true;
    if (resp && resp.ok) {
      flashStatus(resp.alreadyRunning ? "代理已在运行 ✓" : "代理已启动 ✓");
      requestSync(); // SW 重新探测 → 推送 cookie → iframe 自动切到 3081
      diagnoseProxy();
    } else {
      const msg = (resp && resp.error) || "未知错误";
      flashStatus("启动失败: " + msg);
      if (/未找到代理脚本/.test(msg)) {
        // 代理文件缺失（如被手动删除）：提示重新下载并运行
        showSetupHint("代理文件缺失：请重新下载并手动运行一次「一键配置」脚本");
      }
    }
    try {
      port.disconnect();
    } catch {
      /* 忽略 */
    }
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (!settled) {
      const m = err ? String(err.message || err) : "宿主异常退出";
      const unregistered = /not registered|No such|not found|forbidden/i.test(m);
      flashStatus(
        unregistered
          ? "启动器未注册：请先点「下载本地代理脚本」运行一次"
          : "启动失败: " + m,
      );
      if (unregistered) {
        showSetupHint("首次使用请先下载并手动运行一次「一键配置」脚本完成注册");
      }
    }
  });
  try {
    port.postMessage({ action: "start-proxy" });
  } catch (err) {
    // 未注册宿主在这里同步抛错（不会走 onDisconnect），引导逻辑必须齐全
    const m = String((err && err.message) || err);
    if (/not registered|No such|not found|forbidden/i.test(m)) {
      flashStatus("启动器未注册：请先点「下载本地代理脚本」运行一次");
      showSetupHint("首次使用请先下载并手动运行一次「一键配置」脚本完成注册");
    } else {
      flashStatus("启动失败: " + m);
    }
  }
}

async function shutdownProxy() {
  try {
    await fetch(PROXY_ORIGIN + "/__dsh_shutdown", {
      method: "POST",
      mode: "no-cors",
      cache: "no-store",
    });
  } catch {
    /* 代理已不在运行也视为成功 */
  }
  flashStatus("代理已关闭");
  /* 延迟再探测：关停响应与进程退出之间有间隙，立刻探测会误判仍在线 */
  setTimeout(requestSync, 600);
}

menuProxy.addEventListener("click", () => {
  menu.hidden = true;
  menuNote.hidden = true;
  if (proxyAvailable) shutdownProxy();
  else startProxyViaNative();
});

/* ============ 引用浮动面板开关 ============ */

menuFloat.addEventListener("click", () => {
  menu.hidden = true;
  floatEnabled = !floatEnabled;
  try {
    chrome.storage.local.set({ quoteFloatEnabled: floatEnabled });
  } catch {
    /* 忽略 */
  }
  flashStatus(floatEnabled ? "引用浮动面板已开启" : "引用浮动面板已关闭");
});
btnRetry.addEventListener("click", reloadFrame);

/* ============ 页面缩放（Ctrl+滚轮，只缩放 iframe 内的 dsh 页面）============
 * 缩放状态与持久化都在 dsh 页内（dsh-inject.js）。鼠标悬停在 iframe 上时，
 * 滚轮由 dsh 页直接处理；悬停在面板框架（顶栏等）上时，这里转发给 iframe。 */
document.addEventListener(
  "wheel",
  (ev) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    postToDsh({ type: "zoom-delta", payload: { delta: ev.deltaY < 0 ? 0.1 : -0.1 } });
  },
  { passive: false },
);

/* ============ dsh 地址配置 ============ */

function saveDshUrl() {
  if (applyDshUrl(urlInput.value)) {
    try {
      chrome.storage.local.set({ dshUrl });
    } catch {
      /* storage 不可用时忽略 */
    }
    urlRow.hidden = true;
    flashStatus("dsh 地址已保存");
    reloadFrame();
  } else {
    flashButton(btnUrlSave, "地址无效");
  }
}

btnConfig.addEventListener("click", () => {
  if (menu.hidden) {
    updateMenuLabels();
    menuNote.hidden = true;
    menu.hidden = false;
  } else {
    menu.hidden = true;
  }
});
/* 点击菜单外任意处关闭；dsh iframe 内的点击收不到（事件被 iframe 吞掉），
 * 由窗口 blur 兜底——点击 iframe 时面板窗口必然失焦 */
document.addEventListener("mousedown", (ev) => {
  if (!menu.hidden && !menu.contains(ev.target) && ev.target !== btnConfig) {
    menu.hidden = true;
  }
});
window.addEventListener("blur", () => {
  if (!menu.hidden) {
    menu.hidden = true;
    menuNote.hidden = true;
  }
});

function updateMenuLabels() {
  menuProxy.textContent = proxyAvailable ? "关闭代理" : "启动代理";
  menuFloat.textContent = floatEnabled ? "关闭引用浮动面板" : "打开引用浮动面板";
}

menuUrl.addEventListener("click", () => {
  menu.hidden = true;
  urlRow.hidden = false;
  urlInput.value = dshUrl;
  urlInput.focus();
  urlInput.select();
});
btnUrlSave.addEventListener("click", saveDshUrl);
btnUrlCancel.addEventListener("click", () => {
  urlRow.hidden = true;
});
urlInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") saveDshUrl();
  if (ev.key === "Escape") urlRow.hidden = true;
});

/* ============ 本地代理：探测 / 一键配置 / 自诊断 ============ */

function updateSetupCard() {
  setupCard.hidden = proxyAvailable;
}

/* 面板自诊断：探测代理 → 读取扩展可见的会话 cookie → 直接推送给代理 → 读回状态。
 * 不依赖后台 SW 的推送路径，任何一环失败都能在界面上看到。 */
async function diagnoseProxy() {
  const parts = [];
  try {
    // 1. 代理在线？
    const ping = await probeUrl(PROXY_ORIGIN + "/__dsh_ping");
    parts.push("代理:" + (ping ? "在线 ✓" : "未运行 ✗"));

    // 2. 扩展可见的 dsh 会话 cookie
    let cookieHeader = "";
    try {
      const cookies = await chrome.cookies.getAll({ url: dshOrigin });
      cookieHeader = cookies
        .filter((c) => c.name.startsWith("dsh-auth-"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
    } catch {
      /* 忽略 */
    }
    parts.push("扩展侧cookie:" + (cookieHeader ? "有 ✓" : "无 ✗（打开一次 token 地址）"));

    // 3. 直接推送给代理
    if (ping && cookieHeader) {
      await fetch(PROXY_ORIGIN + "/__dsh_cookie", {
        method: "POST",
        body: cookieHeader,
        cache: "no-store",
      }).catch(() => {});
    }

    // 4. 读回代理状态（代理未运行时跳过查询）
    let state = null;
    if (ping) {
      try {
        state = await (await fetch(PROXY_ORIGIN + "/__dsh_state", { cache: "no-store" })).json();
      } catch {
        /* 状态查询失败：可能是代理刚启动/正忙，或进程内是旧版脚本 */
      }
    }
    parts.push(
      "代理内cookie:" +
        (ping
          ? state
            ? state.hasCookie
              ? "有 ✓"
              : "无 ✗"
            : "查询失败（建议关闭代理后重新启动）"
          : "未检查（代理未运行）"),
    );

    // 5. 同步全局状态（触发 iframe 切换）
    if (ping !== proxyAvailable) {
      proxyAvailable = ping;
      updateSetupCard();
      if (ping) reloadFrame();
    }
    try {
      await chrome.storage.local.set({ proxyAvailable: ping });
    } catch {
      /* 忽略 */
    }
  } catch (err) {
    parts.push("诊断异常: " + String((err && err.message) || err));
  }
  setupStatus.textContent = "状态：" + parts.join(" · ");
}

btnSetupCheck.addEventListener("click", () => {
  requestSync(); // 后台同步 cookie 规则
  diagnoseProxy();
  flashButton(btnSetupCheck, "检查中…");
});

/* 生成自包含安装脚本：把代理与宿主代码（base64）写进
 * %LOCALAPPDATA%\DSHSidebarProxy 并启动代理，同时注册本机消息宿主
 * （HKCU，当前用户级）——之后 ⚙ 菜单即可启动/关闭代理。
 * 不写开机自启；重启电脑后代理需再点一次按钮启动。 */
async function buildSetupBat() {
  const cjsUrl = chrome.runtime.getURL("local-proxy/dsh-proxy.cjs");
  const cjs = await (await fetch(cjsUrl, { cache: "no-store" })).text();
  const cjsB64 = btoa(unescape(encodeURIComponent(cjs)));
  const hostUrl = chrome.runtime.getURL("native-host/dsh-proxy-host.cjs");
  const hostJs = await (await fetch(hostUrl, { cache: "no-store" })).text();
  const hostB64 = btoa(unescape(encodeURIComponent(hostJs)));
  const vbs =
    'Set sh = CreateObject("WScript.Shell")\r\n' +
    'If WScript.Arguments.Count < 1 Then WScript.Quit\r\n' +
    'sh.Run "node.exe """ & WScript.Arguments(0) & """", 0, False\r\n';
  const vbsB64 = btoa(unescape(encodeURIComponent(vbs)));

  const chunk = (b64) => String(b64).match(/.{1,64}/g) || [];
  const cjsLines = chunk(cjsB64);
  const hostLines = chunk(hostB64);
  const vbsLines = chunk(vbsB64);

  const write = (file, lines) => {
    const out = [`> "%DIR%\\${file}" echo ${lines[0]}`];
    for (let i = 1; i < lines.length; i++) out.push(`>> "%DIR%\\${file}" echo ${lines[i]}`);
    return out;
  };

  /* 本机消息宿主 manifest：JSON 里 Windows 路径的反斜杠需转义成 \\，
   * bat 里用 %DIR:\=\\% 在运行时展开；allowed_origins 嵌入当前扩展 ID */
  const manifestLine =
    '> "%DIR%\\com.dsh.proxy.host.json" echo {"name":"com.dsh.proxy.host","description":"DSH sidebar proxy launcher","path":"%DIR:\\=\\\\%\\\\host.bat","type":"stdio","allowed_origins":["chrome-extension://' +
    chrome.runtime.id +
    '/"]}';

  return [
    "@echo off",
    "rem DSH sidebar one-shot setup: local proxy + native messaging host registration",
    "rem (installs to %LOCALAPPDATA% - survives temp cleanup; HKCU only, no admin, no autostart)",
    "setlocal",
    'set "DIR=%LOCALAPPDATA%\\DSHSidebarProxy"',
    'if not exist "%DIR%" mkdir "%DIR%"',
    ...write("proxy.b64", cjsLines),
    'certutil -decode "%DIR%\\proxy.b64" "%DIR%\\dsh-proxy.cjs" >nul',
    ...write("host.b64", hostLines),
    'certutil -decode "%DIR%\\host.b64" "%DIR%\\dsh-proxy-host.cjs" >nul',
    ...write("vbs.b64", vbsLines),
    'certutil -decode "%DIR%\\vbs.b64" "%DIR%\\proxy-silent.vbs" >nul',
    'del "%DIR%\\proxy.b64" "%DIR%\\host.b64" "%DIR%\\vbs.b64" >nul 2>&1',
    '> "%DIR%\\host.bat" echo @echo off',
    '>> "%DIR%\\host.bat" echo node "%%~dp0dsh-proxy-host.cjs"',
    manifestLine,
    'reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dsh.proxy.host" /ve /d "%DIR%\\com.dsh.proxy.host.json" /f >nul',
    'start "" wscript.exe "%DIR%\\proxy-silent.vbs" "%DIR%\\dsh-proxy.cjs"',
    "timeout /t 2 >nul",
    "exit",
  ].join("\r\n");
}

btnDownloadSetup.addEventListener("click", async () => {
  flashButton(btnDownloadSetup, "生成中…");
  try {
    const bat = await buildSetupBat();
    const blob = new Blob([bat], { type: "application/x-bat" });
    const url = URL.createObjectURL(blob);
    const aEl = document.createElement("a");
    aEl.href = url;
    aEl.download = "DSH侧边栏一键配置.bat";
    document.body.appendChild(aEl);
    aEl.click();
    aEl.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    flashStatus("脚本已下载：双击运行即可");
    // 运行后由心跳/检查按钮自动探测
  } catch (err) {
    flashButton(btnDownloadSetup, "生成失败");
    console.error("[DSH] 生成启动脚本失败:", err);
  }
});

/* ============ 代理状态同步 ============ */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.proxyAvailable) return;
  const now = !!changes.proxyAvailable.newValue;
  if (now !== proxyAvailable) {
    proxyAvailable = now;
    updateSetupCard();
    flashStatus(now ? "本地代理已就绪" : "本地代理已停止");
    reloadFrame();
  }
});

/* 心跳：每 60 秒后台同步一次（cookie 规则 / 代理探测 / cookie 推送恢复）；
 * 全量自诊断（含 4 个网络请求与状态刷新）只在 setup 卡片可见时才有意义 */
setInterval(() => {
  requestSync();
  if (!setupCard.hidden) diagnoseProxy();
}, 60000);

function flashStatus(text) {
  clearTimeout(statusFlashTimer);
  statusText.textContent = text;
  statusFlashTimer = setTimeout(() => setConnectedUI(iframeReady), 1500);
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1000);
}

/* 请求后台做一次完整同步（cookie 规则 + 代理探测/推送） */
function requestSync() {
  try {
    const p = chrome.runtime.sendMessage({ type: "DSH_SYNC_COOKIE" });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* 扩展上下文失效时忽略 */
  }
}

/* ============ 启动 ============ */

setConnectedUI(false);
armConnectWatchdog();
try {
  chrome.storage.local.get(["dshUrl", "proxyAvailable", "quoteFloatEnabled"], (res) => {
    if (res && res.dshUrl) applyDshUrl(res.dshUrl);
    proxyAvailable = !!(res && res.proxyAvailable);
    floatEnabled = !(res && res.quoteFloatEnabled === false);
    updateSetupCard();
    if (frame.src !== computeFrameUrl()) frame.src = computeFrameUrl();
    requestSync();
    /* 清理已废弃功能的残留键（zoomFactor / proxyScriptPath） */
    chrome.storage.local.remove(["zoomFactor", "proxyScriptPath"]);
  });
} catch {
  /* storage 不可用时忽略 */
}
