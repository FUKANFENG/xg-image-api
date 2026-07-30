# ChatGPT2API 桌面版

这是现有 ChatGPT2API 面板的 Windows 桌面外壳。主界面由 WebView2 内嵌在原生窗口中，正常使用不会再打开 Chrome、Edge 或其他外部浏览器。

## 两种运行方式

### 主机模式（默认）

双击 `ChatGPT2API-LAN-Launcher.exe`：

1. 原生桌面窗口立即打开；
2. 程序检查并按需启动 Docker Desktop；
3. 使用现有 Compose 配置拉起 ChatGPT2API；
4. 服务就绪后，现有面板直接显示在该桌面窗口内。

主机模式保留“启动服务”“停止服务”“复制局域网地址”和“启用局域网防火墙”按钮。首次允许局域网访问时，手动点击防火墙按钮并确认 Windows UAC 提示。

### 局域网客户端模式（不启动 Docker）

将同一个 EXE 复制到局域网电脑后，以目标主机地址启动：

```powershell
.\ChatGPT2API-LAN-Launcher.exe --server-url http://xg-host.local:3000
```

客户端窗口会直接内嵌指定服务器的面板，不会查找项目目录、启动 Docker 或打开外部浏览器。客户端电脑需要安装 Microsoft Edge WebView2 Runtime（当前 Windows/Edge 通常已自带）。客户端窗口中的“创建桌面快捷方式”会保留该服务器地址。

## 安全和数据边界

- 程序不导入、删除或刷新账号。
- 主机模式仍使用 `docker-compose.yml` 和 `docker-compose.lan.yml`，并以 `--no-build` 启动，不重新构建镜像。
- 启动器不会读取、显示或传递 `CHATGPT2API_AUTH_KEY`；Compose 仍从现有 `.env` 读取。
- 防火墙规则仅允许专用网络中的 `LocalSubnet` 访问 TCP 3000。

## 构建

运行 `desktop-launcher\build.ps1`。自包含 Windows EXE 输出到：

`desktop-launcher\dist\ChatGPT2API-LAN-Launcher.exe`

## 回滚

恢复浏览器式使用或原有 localhost 端口映射时，在项目根目录运行：

```powershell
docker compose up -d --no-build
```

桌面外壳仅替代启动入口，不修改 ChatGPT2API 的原有后端功能或数据。
