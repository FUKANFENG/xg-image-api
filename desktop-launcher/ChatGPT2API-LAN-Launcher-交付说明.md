# ChatGPT2API 桌面客户端交付总报告

## 概览

- 主交付程序：`desktop-launcher/dist/ChatGPT2API-LAN-Launcher.exe`
- 发布包 SHA-256：`8638A7BE1B4508B7BDF185BCDEE6E3E7F01D4937A3C463CA13565F6CAA508101`
- 桌面图标：原创蓝紫网络节点图标，嵌入 EXE，并同步到现有桌面快捷方式。
- 本轮目标：将旧“启动后打开浏览器”的启动器改为真正的 Windows 桌面客户端。
- 结果：主面板由 WebView2 嵌入到原生窗口中；主机模式自动启动 Docker/ChatGPT2API，局域网客户端模式不会启动 Docker。
- 数据影响：无账号导入、删除、刷新或后端业务数据变更；主机模式仍以 `--no-build` 启动现有容器。

## 使用说明

### 主机电脑

双击 `ChatGPT2API-LAN-Launcher.exe` 或现有桌面快捷方式。窗口标题为“ChatGPT2API 桌面版”，Docker Desktop 和 ChatGPT2API 就绪后，既有面板显示在窗口内部，不会为主面板打开 Chrome 或 Edge 浏览器窗口。

主机窗口可启动/停止服务、复制局域网地址；需要开放 TCP 3000 时，手动点击“启用局域网防火墙”并确认 UAC。

### 局域网电脑

复制同一个 EXE 到客户端后，以主机地址启动：

```powershell
.\ChatGPT2API-LAN-Launcher.exe --server-url http://<主机局域网IP>:3000
```

窗口标题为“ChatGPT2API 局域网客户端”。该模式不查找项目目录、不启动 Docker，直接在自己的桌面窗口内连接主机服务。Windows/Edge 通常自带 WebView2 Runtime；缺少时程序会显示明确的原生错误提示。

## 根因与修复机制

- 表面触发点：旧 `LauncherForm` 在服务启动后调用系统 URL 打开逻辑，因此主面板只能在浏览器中使用。
- 真实根因：服务生命周期与展示容器耦合，启动器只有状态页，没有内嵌 Web 容器。
- 修复机制：增加 `DesktopAppOptions` 区分主机/客户端模式；WinForms 窗口使用 `Microsoft.Web.WebView2` 承载页面；新窗口请求复用该内嵌视图；客户端模式仅导航至 `--server-url`。
- 兼容性：现有 Docker、Compose、端口和面板 URL 不变。仅桌面入口从外部浏览器改为内嵌窗口。

## 验证

- 单元测试：9/9 通过，覆盖默认内嵌主机模式、局域网客户端模式、非 HTTP(S) 地址拒绝，以及账号密码嵌入 URL 的拒绝。
- Release 构建：成功，0 警告、0 错误。
- 自包含发布：成功，发布 EXE 大小为 `162,849,043` 字节。
- 图标验证：从发布 EXE 成功提取新图标；桌面快捷方式已更新为 EXE 的第 0 个图标资源。
- 主机运行时：窗口标题为“ChatGPT2API 桌面版”；启动器子进程为 `msedgewebview2.exe`（嵌入运行时，不是外部浏览器窗口）；WebView2 profile 位于当前用户 `LocalAppData`；本机 `/health` 返回 HTTP 200。
- 局域网客户端运行时：以 `--server-url http://xg-host.local:3000` 启动后，窗口标题为“ChatGPT2API 局域网客户端”；LAN `/health` 返回 HTTP 200；客户端没有启动 Docker 子进程。
- 容器：`chatgpt2api` 正常运行，端口映射为 `0.0.0.0:3000 -> 80/tcp`。

## 回滚

- 代码回滚基准：提交 `066ac75f13f534e254f3cf1dc87b71004052057f`（旧启动器实现）。
- 服务回滚：在项目根目录运行 `docker compose up -d --no-build`，恢复原有 localhost-only Compose 行为。
- 本轮变更未触及既有后端未提交修改。

## 交付物分发清单

- 后端负责人：查看“根因与修复机制”“验证”“回滚”；后端业务模块无改动。
- 前端负责人：查看“使用说明”“根因与修复机制”；既有 Web 面板未改，改动仅为 Windows 内嵌容器。
- Dify/运维负责人：查看“主机电脑”“局域网电脑”“验证”“回滚”；注意防火墙授权仍需人工确认。
- 项目负责人：查看全文；重点为发布 EXE、SHA-256、LAN 客户端命令和验证结果。
- 归档附件：无；构建输出位于 `desktop-launcher/dist/`，由 `.gitignore` 忽略。
