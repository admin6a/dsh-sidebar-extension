# DSH 侧边栏

把本地运行的 [dsh](https://github.com/deepseek-ai/DeepSeek-Harness)（DeepSeek Harness，默认 `http://127.0.0.1:3080`）固定到 Chrome 侧边栏，让 dsh 获得当前网页的上下文：选中网页文字即可引用到 dsh 的对话输入框，引用与提问一起发送。

**开源友好**：全部逻辑都在扩展与本机脚本内，无需管理员权限、无开机自启；仅当前用户级安装（HKCU 注册表 + `%LOCALAPPDATA%\DSHSidebarProxy`），随时可完全卸载。

## 功能

- **侧边栏停靠 dsh**：点击工具栏图标开关侧边栏（Chrome 114+ 原生 Side Panel）
- **网页内容推送**：切换标签页自动把页面内容推送给 dsh
- **引用**：网页选中文字 → 浮动「引用到 DSH」按钮 → 引用块写入 dsh 输入框（`【引用源｜标题 | URL】` + `> 引用文字`），接着输入提问一起发送
- **页面缩放**：Ctrl + 滚轮缩放 dsh 页面内容（50%–200%，持久化；只缩放页面，面板框架不动）
- **⚙ 设置菜单**：修改 dsh 地址 / 启动·关闭代理（智能识别状态）/ 引用浮动面板开关
- **本地代理管理**：一键启动（本机消息宿主拉起）/ 一键关闭（代理自关停端点），无需手动跑脚本

## 工作原理（为什么需要本地代理）

dsh 的 web 服务有两层安全防护：`/api` 请求栅栏拒绝带跨站标记的请求、会话 cookie 为 `SameSite=Strict` 且 HttpOnly。dsh 页面被嵌入扩展的 iframe 后属于跨站上下文，API 请求与 WebSocket 握手都无法通过认证（无限「重新连接中」）。两者的解法不同：

| 请求类型  | 解法                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| XHR / API | 扩展内置 declarativeNetRequest 动态规则：注入会话 cookie + 把`Sec-Fetch-Site` 改写为 `same-origin`，不依赖代理 |
| WebSocket | 引擎限制，DNR 改写对 WS 握手不生效 → 必须经本机迷你代理（127.0.0.1:3081 → 3080）剥掉跨站标记并注入 cookie        |

代理在线时面板自动把 iframe 切到 3081，离线时切回 3080（此时 WS 断连属预期，面板会显示配置卡片提示）。

## 安装

1. 克隆仓库：`git clone https://github.com/admin6a/dsh-sidebar-extension.git`
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角**开发者模式**
3. 点「加载已解压的扩展程序」，选择项目文件夹 `dsh-sidebar-extension`
4. 确保 dsh 已运行；首次在普通标签页打开 dsh 启动时打印的
   `http://127.0.0.1:3080/?token=…` 地址登录一次（换取会话 cookie）
5. 打开侧边栏，按 setup 卡片提示完成**首次配置**（见下）
6. 之后正常使用：选中网页文字即可引用

> 需要本机装有 [Node.js](https://nodejs.org/)（代理用它运行，`where node` 能找到即可）。
> 修改扩展代码后，在 `chrome://extensions` 点卡片上的 ↻ 重载并重开侧边栏即可生效。

### 首次配置（一次性）

点 setup 卡片「下载本地代理脚本」→ 得到`DSH侧边栏一键配置.bat`→ **手动双击运行一次**。它做四件事：

1. 把内嵌的代理与启动器代码（base64）解码写入 `%LOCALAPPDATA%\DSHSidebarProxy\`（用户目录，不受临时目录清理影响）
2. 写出隐藏窗口启动器（VBS）并启动代理（仅监听 `127.0.0.1:3081`）
3. 写出本机消息宿主清单，并在 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.proxy.host` 注册（仅当前用户，无管理员）
4. 退出

之后 ⚙ 菜单即可**启动/关闭代理**；代理文件被删时重新下载运行一次脚本即可。

### 卸载

- 移除扩展（`chrome://extensions` → 移除）
- 删除 `%LOCALAPPDATA%\DSHSidebarProxy\` 目录
- 删除注册表项 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.proxy.host`

## 目录结构

```
dsh-sidebar-extension/
├── manifest.json          # MV3 清单（sidePanel / scripting / storage / cookies /
│                          #   declarativeNetRequest / alarms / nativeMessaging）
├── background.js          # SW：侧边栏开关、cookie 注入规则、Sec-Fetch 改写、
│                          #   代理探测与 cookie 推送、闹钟自愈、宿主消息处理
├── content.js             # 内容脚本：页面内容提取 + 选区捕获 + 浮动引用按钮（Shadow DOM）
├── dsh-inject.js          # 自动桥（注入 dsh 页面）：消息派发为 dsh-extension 事件、
│                          #   引用自动填入输入框、重连状态回报、页面缩放
├── sidepanel.html / .js   # 面板：dsh iframe、⚙ 菜单、一键配置、代理自诊断
├── native-host/
│   └── dsh-proxy-host.cjs # 本机消息宿主：Native Messaging 协议，拉起/管理代理进程
├── local-proxy/
│   ├── dsh-proxy.cjs      # 迷你代理源码（零依赖 Node；安装脚本内嵌的就是它）
│   └── start-proxy.cmd     # 手动前台启动（排障用，可选）
├── dsh-bridge-example.js  # dsh 前端的 postMessage 接入示例（可选，零接入也能用）
└── icons/                 # 16 / 48 / 128
```

## dsh 接入

扩展向 dsh 页面自动注入桥（`dsh-inject.js`），把消息派发为 DOM 事件 **`dsh-extension`**，
并对 `quote` 提供**零接入兜底**（自动填入页面上可见的对话输入框）。

```js
window.addEventListener("dsh-extension", (e) => {
  const msg = e.detail; // { source: "dsh-extension", type, payload }
  console.log(msg.type, msg.payload);
});
```

| type（扩展 → dsh）        | payload                                       | 说明                 |
| -------------------------- | --------------------------------------------- | -------------------- |
| `quote`                  | `{ text, url, title, auto: false }`         | 显式引用（浮动按钮） |
| `selection`              | `{ text, url, title, auto: true, resend? }` | 自动选中文本上报     |
| `page-content`           | `{ url, title, text, selection, auto }`     | 页面内容推送         |
| `hello` / `page-error` | `{ version }` / `{ message, auto }`       | 握手 / 内容读取失败  |

dsh → 扩展（`postMessage`，`source: "dsh"`）：`request-page` / `request-selection`。
iframe 模式下的 postMessage 通道见 `dsh-bridge-example.js`，与 DOM 事件二选一。

> 已接入的应用若自行处理 `quote`，请避免与内置兜底重复填充输入框。

## 故障排查

| 现象                                 | 处理                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| 显示 setup 卡片                      | 代理未运行：⚙ →「启动代理」；首次使用先完成上面的首次配置                        |
| 启动提示「启动器未注册」             | 先下载并手动运行一次「一键配置」脚本                                               |
| 启动提示「未找到代理脚本」           | `%LOCALAPPDATA%\DSHSidebarProxy` 被删：重新下载运行一次脚本                      |
| dsh 无限「重新连接中」               | 代理未运行或 cookie 失效；cookie 失效时普通标签页重开一次新 token 地址             |
| dsh web 提示 authentication required | 同上，cookie 失效                                                                  |
| 点了下载没反应                       | 查看浏览器下载栏（.bat 可能被拦，选保留）；需 node 在 PATH 中                      |
| 代理日志                             | 以`DSH_PROXY_VERBOSE=1` 启动代理可开启逐请求日志                                 |
| 改了扩展代码不生效                   | `chrome://extensions` → 卡片 ↻ 重载，并重新打开侧边栏                          |
| 查看扩展后台日志                     | `chrome://extensions` → 卡片上的「Service Worker」链接，找 `[DSH]` 开头的日志 |

## 已知限制

- 需要 Chrome 114+ 或其他支持 Side Panel API 的 Chromium 浏览器
- `chrome://` 设置页、Chrome 商店、PDF 查看器等内置页面无法读取内容
- 页面内部 `<iframe>` 里选中的文字不会被捕获；`user-select: none` 的元素选不中
- 正文提取基于 `innerText`，最多 200,000 字符（超出截断）
- 代理由本机消息宿主/脚本拉起，重启电脑后需在 ⚙ 菜单再点一次「启动代理」

## 隐私

所有数据（页面内容、选中文本、cookie）仅在本地流转：网页 → 扩展 → 本机 dsh / 本机代理，
不经过任何第三方服务。代理仅监听 `127.0.0.1:3081`，不对外网开放。

## 免责声明

本项目仅供学习与研究使用，按「现状」提供，不提供任何明示或暗示的担保。使用本扩展产生的任何风险（包括但不限于数据丢失、账号异常、与本机 dsh 服务相关的任何问题）由使用者自行承担，作者及贡献者不承担任何法律责任。请遵守所在地区法律法规，勿将本项目用于任何违法用途。

## 许可证

本项目以 [MIT](LICENSE)（MIT License）发布。

## 反馈与贡献

欢迎提交 Issue 反馈问题或建议：<https://github.com/admin6a/dsh-sidebar-extension/issues>
