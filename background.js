/* DSH 侧边栏 — 后台 Service Worker
 *
 * 职责：
 * 1. 点击扩展图标 = 侧边栏开关（Chrome 114+ 原生 Side Panel 行为）
 * 2. 同步 dsh 会话 cookie：dsh web 的会话 cookie 是 SameSite=Strict，且被
 *    HttpOnly 保护。当 dsh 页面被 chrome-extension:// 页面（侧边栏）内嵌时，
 *    属于跨站上下文，浏览器永远不会携带该 cookie → 所有 API 请求都 401。
 *    解决：用 declarativeNetRequest 动态规则，把 cookie 主动写入所有发往
 *    dsh 的请求头，并在 cookie 变化时自动更新。
 * 3. WebSocket 说明：实测 DNR 头改写对 WebSocket 握手不生效，因此 WS 需要
 *    本地代理（面板「一键配置」按钮会生成自包含安装脚本，运行一次即可；
 *    代理注册为当前用户的开机自启、隐藏窗口）。代理在线时本 SW 会把
 *    会话 cookie 推送给它。
 */
"use strict";

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[DSH] setPanelBehavior 失败:", err));

const RULE_ID = 1;
const SEC_FETCH_RULE_ID = 2;
const DEFAULT_ORIGIN = "http://127.0.0.1:3080";
const PROXY_ORIGIN = "http://127.0.0.1:3081";

let lastCookieRuleSig; // 上次写入的 cookie 规则签名（去重，避免频繁重写 DNR）

async function getDshOrigin() {
  try {
    const res = await chrome.storage.local.get(["dshUrl"]);
    return new URL((res && res.dshUrl) || DEFAULT_ORIGIN).origin;
  } catch {
    return DEFAULT_ORIGIN;
  }
}

/* 把 dsh 会话 cookie（名称形如 dsh-auth-…）写进 DNR 动态规则 */
async function syncCookieRule() {
  try {
    const origin = await getDshOrigin();
    const hostname = new URL(origin).hostname;
    console.log("[DSH][sync] 开始 origin=" + origin);

    let cookieHeader = "";
    try {
      const cookies = await chrome.cookies.getAll({ url: origin });
      cookieHeader = cookies
        .filter((c) => c.name.startsWith("dsh-auth-"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      console.log("[DSH][sync] cookie 读取=" + (cookieHeader ? cookieHeader.length + "字符" : "无"));
    } catch (err) {
      console.error("[DSH][sync] cookie 读取失败:", err);
    }

    const resourceTypes = [
      "main_frame",
      "sub_frame",
      "xmlhttprequest",
      "websocket",
      "script",
      "stylesheet",
      "image",
      "font",
      "media",
      "other",
    ];

    const addRules = cookieHeader
      ? [
          {
            id: RULE_ID,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders: [{ header: "Cookie", operation: "set", value: cookieHeader }],
            },
            condition: { requestDomains: [hostname], resourceTypes },
          },
        ]
      : [];

    /* cookie 未变化时跳过 DNR 重写（同步被闹钟/消息频繁触发） */
    const ruleSig = JSON.stringify(addRules);
    if (ruleSig !== lastCookieRuleSig) {
      lastCookieRuleSig = ruleSig;
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_ID],
        addRules,
      });
      console.log("[DSH][sync] cookie 规则完成 ✓ addRules=" + addRules.length);
    }

    await applySecFetchRule(hostname);
    console.log("[DSH][sync] secFetch 完成");
    await probeProxyAndPushCookie(origin);
    console.log("[DSH][sync] 代理探测推送完成");
  } catch (err) {
    console.error("[DSH][sync] 同步链异常:", err);
  }
}

/* dsh 的 /api 栅栏硬编码拒绝 `Sec-Fetch-Site: cross-site` 的请求
 * （见 @deepseek-ai/dsh-client-connection isTrustedApiRequest），
 * 而 chrome-extension:// 页面内嵌的 iframe 里所有请求都带 cross-site 标记。
 * 这里尝试用 DNR 把该头改写成 same-origin（对 XHR 生效；
 * WebSocket 握手改写不了，由本地代理负责）。
 * 规则内容固定不变：本 SW 生命周期内成功写入一次即可，后续同步跳过。 */
let secFetchSupported; // undefined=未知 true=可用 false=被浏览器禁止

async function applySecFetchRule(hostname) {
  if (secFetchSupported === true) return; // 规则已就位，避免每次同步重写 DNR
  const resourceTypes = [
    "main_frame",
    "sub_frame",
    "xmlhttprequest",
    "script",
    "stylesheet",
    "image",
    "font",
    "media",
    "other",
  ];
  const rule = {
    id: SEC_FETCH_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "Sec-Fetch-Site", operation: "set", value: "same-origin" }],
    },
    condition: { requestDomains: [hostname], resourceTypes },
  };
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [SEC_FETCH_RULE_ID],
      addRules: [rule],
    });
    if (secFetchSupported !== true) {
      console.log("[DSH] Sec-Fetch-Site 改写：浏览器支持 ✓");
    }
    secFetchSupported = true;
  } catch (err) {
    secFetchSupported = false;
    console.error(
      "[DSH] Sec-Fetch-Site 改写：浏览器不允许 ✗ →",
      (err && err.message) || err,
      "（XHR 仍可用；WebSocket 请运行本地代理）",
    );
    await chrome.declarativeNetRequest
      .updateDynamicRules({ removeRuleIds: [SEC_FETCH_RULE_ID], addRules: [] })
      .catch(() => {});
  }
  /* storage 只在判定变化时写入，避免每 30 秒同步的无效写 */
  if (secFetchStorageCache !== secFetchSupported) {
    secFetchStorageCache = secFetchSupported;
    try {
      await chrome.storage.local.set({ secFetchSupported: secFetchSupported === true });
    } catch {
      /* 忽略 */
    }
  }
}
let secFetchStorageCache; // 上次写入 storage 的判定值

/* 探测本地剥头代理是否在线；在线则推送会话 cookie 给它
 * （WS 握手的 cookie 浏览器不发送、DNR 也改写不了，必须由代理注入）。
 * cookie 未变化时跳过推送；代理离线会清空推送缓存（重启后需重新注入）。 */
let lastPushedCookie = ""; // 已成功推送给代理的 cookie
let lastProxyAvailable; // 上次写入 storage 的探测结果

async function probeProxyAndPushCookie(origin) {
  let available = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const resp = await fetch(PROXY_ORIGIN + "/__dsh_ping", { cache: "no-store", signal: ctrl.signal });
    clearTimeout(timer);
    available = resp.ok;
  } catch {
    available = false;
  }

  if (available) {
    try {
      const cookies = await chrome.cookies.getAll({ url: origin });
      const header = cookies
        .filter((c) => c.name.startsWith("dsh-auth-"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      if (header && header !== lastPushedCookie) {
        await fetch(PROXY_ORIGIN + "/__dsh_cookie", {
          method: "POST",
          body: header,
          cache: "no-store",
        }).catch(() => {});
        lastPushedCookie = header;
        console.log("[DSH] 代理在线，会话 cookie 已推送");
      }
    } catch (err) {
      console.error("[DSH] 推送 cookie 给代理失败:", err);
    }
  } else {
    lastPushedCookie = ""; // 代理重启会丢失内存中的 cookie，恢复后需重新推送
  }

  /* storage 只在探测结果变化时写入 */
  if (lastProxyAvailable !== available) {
    lastProxyAvailable = available;
    try {
      await chrome.storage.local.set({ proxyAvailable: available });
    } catch {
      /* 忽略 */
    }
    if (available) console.log("[DSH] 本地代理可用:", PROXY_ORIGIN);
  }
}

/* MV3 SW 空闲约 30 秒即被挂起；同步链路里定期触碰 chrome API 保活。
 * 本扩展是常驻型（随时转发引用/保持停靠），让 SW 常驻是合理开销。 */
function runSyncWithKeepalive() {
  const keep = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch {
      /* 忽略 */
    }
  }, 4000);
  return syncCookieRule().finally(() => clearInterval(keep));
}

/* 面板请求同步：先抓取一次 dsh 地址（带 ?token= 时会重新签发 cookie），再同步规则 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "DSH_SYNC_COOKIE") {
    runSyncWithKeepalive()
      .then(() => chrome.storage.local.get(["proxyAvailable"]))
      .then((st) => sendResponse({ ok: true, proxyAvailable: !!(st && st.proxyAvailable) }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 保持消息通道打开，直到 sendResponse（同时给 SW 保活）
  }
});

/* cookie 变化（打开 token URL、过期、dsh 重启）→ 自动同步规则 */
chrome.cookies.onChanged.addListener((change) => {
  if (change.cookie && change.cookie.name.startsWith("dsh-auth-")) {
    runSyncWithKeepalive();
  }
});

/* 面板里修改 dsh 地址 → 重新同步 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.dshUrl) runSyncWithKeepalive();
});

chrome.runtime.onStartup.addListener(runSyncWithKeepalive);
chrome.runtime.onInstalled.addListener(() => {
  runSyncWithKeepalive();
  /* 闹钟自愈：浏览器会在 SW 休眠时冻结 setInterval，闹钟由浏览器调度，
   * SW 被杀也会被唤醒重跑同步链（cookie 注入 / Sec-Fetch 改写 / 代理探测推送），
   * 确保任何一步未完成都能在 30 秒内自动补齐。 */
  chrome.alarms.create("dsh-sync", { periodInMinutes: 0.5 });
  /* 重载/更新扩展后，旧页面的内容脚本上下文已失效——
   * 延迟 5 秒（等浏览器会话恢复出标签页）为所有已打开网页重新注入
   * （content.js 自带幂等守卫，重复注入安全）。 */
  setTimeout(async () => {
    try {
      const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
      for (const t of tabs) {
        if (t.id == null) continue;
        try {
          await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
        } catch {
          /* 内置页/商店等不可注入的页面忽略 */
        }
      }
    } catch (err) {
      console.error("[DSH] 重新注入内容脚本失败:", err);
    }
  }, 5000);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dsh-sync") runSyncWithKeepalive();
});
runSyncWithKeepalive();
