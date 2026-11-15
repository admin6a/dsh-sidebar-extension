/* DSH 侧边栏 — 本机消息宿主（Native Messaging Host）
 *
 * 供扩展顶栏「启动代理」按钮通过 chrome.runtime.connectNative 调用，
 * 在本机拉起 %TEMP%\DSHSidebarProxy\dsh-proxy.cjs（与「一键配置」脚本
 * 写入的是同一份代理）。协议：stdin/stdout 4 字节小端长度 + JSON。
 *
 * 请求：{ "action": "start-proxy" }
 * 响应：{ "ok": true, "alreadyRunning": true }       代理已在运行
 *     | { "ok": true, "pid": <pid> }               已启动
 *     | { "ok": false, "error": "…" }              失败原因
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

/* 安装目录：LOCALAPPDATA（用户目录，不受临时目录清理影响）；
 * 兼容旧版安装位置 TEMP */
const DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "DSHSidebarProxy");
const PROXY_CJS_CANDIDATES = [
  path.join(DIR, "dsh-proxy.cjs"),
  path.join(os.tmpdir(), "DSHSidebarProxy", "dsh-proxy.cjs"),
];
const PROXY_PING = "http://127.0.0.1:3081/__dsh_ping";

function respond(obj) {
  const data = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length, 0);
  process.stdout.write(len);
  process.stdout.write(data);
}

/* 逐条读 stdin（Native Messaging 帧格式），逐条处理 */
let buf = Buffer.alloc(0);
function readExact(n) {
  return new Promise((resolve, reject) => {
    const cut = () => {
      if (buf.length < n) return false;
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      resolve(out);
      return true;
    };
    if (cut()) return;
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (cut()) {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
      }
    };
    const onEnd = () => reject(new Error("stdin 提前结束"));
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

function pingProxy(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(PROXY_PING, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function handle(msg) {
  if (msg.action === "start-proxy") {
    if (await pingProxy()) return { ok: true, alreadyRunning: true };
    const proxyCjs = PROXY_CJS_CANDIDATES.find((p) => fs.existsSync(p));
    if (!proxyCjs) {
      return { ok: false, error: "未找到代理脚本，请重新下载并手动运行一次「一键配置」脚本" };
    }
    const child = spawn(process.execPath, [proxyCjs], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await pingProxy()) return { ok: true, pid: child.pid };
    }
    return { ok: false, error: "代理已启动但未响应 ping（检查 node 是否可用）" };
  }
  return { ok: false, error: "未知 action: " + String(msg.action) };
}

async function main() {
  try {
    for (;;) {
      const lenBuf = await readExact(4);
      const body = await readExact(lenBuf.readUInt32LE(0));
      let msg = {};
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {
        respond({ ok: false, error: "请求 JSON 解析失败" });
        continue;
      }
      respond(await handle(msg));
    }
  } catch {
    /* stdin 关闭（Chrome 断开）→ 正常退出 */
    process.exit(0);
  }
}

main();
