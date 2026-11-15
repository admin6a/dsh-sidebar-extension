/* DSH 本地剥头代理：127.0.0.1:3081 → 127.0.0.1:3080（Node 原生模块，零依赖）
 *
 * 为什么需要它：
 *   dsh 的 /api 栅栏硬编码拒绝 `Sec-Fetch-Site: cross-site` 的请求
 *   （@deepseek-ai/dsh-client-connection 的 isTrustedApiRequest）。
 *   侧边栏 iframe 的顶层站点是 chrome-extension://，浏览器给 iframe 内所有
 *   请求（含 WebSocket 握手）打上 cross-site 标记 → dsh 一律 403/断连
 *   → 前端无限「重新连接中」。
 *   实测：Chrome 的 declarativeNetRequest 改写对 XHR 生效、对 WebSocket
 *   握手不生效，因此 WebSocket 必须由本代理剥离该头。
 *
 * 控制端点：
 *   GET  /__dsh_ping            健康检查（扩展探测代理是否在线）
 *   POST /__dsh_cookie          body = cookie 字符串，由扩展后台推送并注入到转发请求
 *
 * 用法：
 *   双击 start-proxy.cmd（或 node dsh-proxy.cjs），保持窗口运行。
 *   侧边栏面板检测到代理在线后会自动切换到 http://127.0.0.1:3081。
 */
"use strict";

const http = require("http");

const LISTEN_PORT = Number(process.env.DSH_PROXY_PORT || 3081);
const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = Number(process.env.DSH_TARGET_PORT || 3080);

let cookieHeader = "";

/* 常驻运行时窗口是隐藏的，无人看 stdout——逐请求日志默认关闭，
 * 需要排障时以 DSH_PROXY_VERBOSE=1 启动 */
const verbose = process.env.DSH_PROXY_VERBOSE === "1";
const log = (...args) => console.log(new Date().toTimeString().slice(0, 8), ...args);

function rewriteHeaders(incoming, { isUpgrade = false } = {}) {
  const headers = { ...incoming };
  delete headers["sec-fetch-site"]; // 关键：剥掉跨站标记，栅栏对「无此头」放行
  headers["host"] = `${TARGET_HOST}:${TARGET_PORT}`; // Host/Origin 同源检查
  headers["origin"] = `http://${TARGET_HOST}:${TARGET_PORT}`;
  if (cookieHeader) headers["cookie"] = cookieHeader; // 注入扩展推送的会话 cookie
  if (!isUpgrade) headers["connection"] = "close";
  return headers;
}

function describe(req) {
  const secFetch = req.headers["sec-fetch-site"] || "-";
  const cookie = req.headers.cookie ? "浏览器" : cookieHeader ? "注入" : "无";
  return `${req.method} ${req.url.slice(0, 60)} | sec-fetch-site=${secFetch} | cookie=${cookie}`;
}

const server = http.createServer((req, res) => {
  /* ---- 控制端点 ---- */
  if (req.url === "/__dsh_ping") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pong");
    return;
  }
  if (req.url === "/__dsh_state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        hasCookie: !!cookieHeader,
        cookieLen: cookieHeader.length,
        cookiePreview: cookieHeader.slice(0, 24),
      }),
    );
    return;
  }
  if (req.url === "/__dsh_cookie" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      cookieHeader = body.trim();
      log("[cookie] 已更新:", cookieHeader ? cookieHeader.slice(0, 40) + "…" : "(空)");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    return;
  }
  if (req.url === "/__dsh_shutdown") {
    res.writeHead(200, { "content-type": "text/plain" });
    /* 响应刷出即退出：若延迟退出，探测可能落在窗口期内误判代理仍在线 */
    res.end("bye", () => {
      log("[shutdown] 收到关停请求，进程退出");
      server.close();
      process.exit(0);
    });
    return;
  }

  /* ---- 普通请求转发 ---- */
  if (verbose) log("[http]", describe(req));
  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: rewriteHeaders(req.headers),
    },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`[dsh-proxy] dsh(${TARGET_HOST}:${TARGET_PORT}) 不可达`);
  });
  req.pipe(upstream);
});

/* ---- WebSocket / SSE 升级透传（剥头 + 注 cookie 后转发握手，再双向转发字节流） ---- */
server.on("upgrade", (req, socket, head) => {
  log("[ws升级]", describe(req));
  const upstreamReq = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: rewriteHeaders(req.headers, { isUpgrade: true }),
  });
  upstreamReq.on("upgrade", (ur, usocket, uhead) => {
    log("[ws升级] → dsh 返回 101，透传中");
    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (const [k, v] of Object.entries(ur.headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (uhead && uhead.length) socket.write(uhead);
    usocket.pipe(socket);
    socket.pipe(usocket);
  });
  upstreamReq.on("response", (ur) => {
    log("[ws升级] → dsh 拒绝:", ur.statusCode);
    const lines = [`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage || ""}`];
    for (const [k, v] of Object.entries(ur.headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    socket.end();
  });
  upstreamReq.on("error", (e) => {
    log("[ws升级] 转发失败:", e.message);
    socket.destroy();
  });
  if (head && head.length) upstreamReq.write(head);
  upstreamReq.end();
  socket.on("error", () => socket.destroy());
});

/* 端口被占用时（例如已有一个代理在运行）静默退出，避免多开 */
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    log(`端口 ${LISTEN_PORT} 已被占用 —— 代理可能已在运行，本次启动退出。`);
    process.exit(0);
  }
  log("服务器错误:", (err && err.message) || err);
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  log(`[dsh-proxy] 已启动: http://127.0.0.1:${LISTEN_PORT} → http://${TARGET_HOST}:${TARGET_PORT}`);
  log("[dsh-proxy] 已剥离 Sec-Fetch-Site 并等待扩展推送会话 cookie。");
  log("[dsh-proxy] 保持本窗口运行即可，侧边栏会自动切换到代理地址。");
});
