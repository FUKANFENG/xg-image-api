# XG生图源码包使用说明

本压缩包用于源码审阅、二次开发和自行部署。包内不包含原作者电脑上的账号池、用户账号、密钥、生成图片、日志或会话数据。

## 目录说明

- `api/`：FastAPI 接口层。
- `services/`：生图、账号、认证、存储和创作工作流服务。
- `web/`：Next.js 前端源码。
- `desktop-launcher/`：Windows 桌面启动器源码。
- `test/`：后端测试。
- `scripts/`：构建与回归脚本。
- `config.json`、`config.example.json`：已脱敏的安全配置模板。
- `.env.example`：环境变量模板，不含真实密钥。

## 推荐部署：Docker Desktop

要求：Windows 10/11、Docker Desktop、可访问依赖镜像源的网络。

1. 解压源码包。
2. 将 `.env.example` 复制为 `.env`。
3. 编辑 `.env`，至少设置随机且足够长的 `CHATGPT2API_AUTH_KEY` 与 `CHATGPT2API_ADMIN_PASSWORD`。
4. 在项目目录运行：

```powershell
docker compose up -d --build
```

5. 浏览器访问 `http://127.0.0.1:3000`。
6. 查看状态：

```powershell
docker compose ps
docker compose logs --tail 100 app
```

停止服务：

```powershell
docker compose down
```

## 前端开发

要求：Node.js 22。

```powershell
Set-Location web
npm ci
npm run dev
```

质量检查：

```powershell
npm run check
npm run build
```

## 后端开发

要求：Python 3.13、uv。

```powershell
uv sync --dev
uv run python -m pytest -q test
```

生产部署建议使用 Docker；Dockerfile 会自动构建前端并将静态文件放入后端需要的 `web_dist/`。

## Windows 桌面启动器源码

要求：.NET 8 SDK。

```powershell
Set-Location desktop-launcher
.\build.ps1
```

桌面启动器仍依赖项目的 Docker 服务；它不是独立的生图模型。

## 局域网使用

先确认系统防火墙允许 TCP 3000，并在 `.env` 设置局域网基础地址，再使用：

```powershell
docker compose -f docker-compose.yml -f docker-compose.lan.yml up -d --build
```

不要把管理员账号密码公开给普通用户。普通用户应从用户登录/注册页面进入。

## 安全提醒

- 不要提交或发送 `.env`、真实 `config.json`、`data/`、日志、数据库和账号导出文件。
- 收到源码后必须自行设置密钥、管理员密码并导入自己的 ChatGPT/Codex 账号。
- 对外网开放前应启用 HTTPS、强密码、访问控制和定期备份。
- 本项目包含对第三方 Web 服务的适配代码；使用者需自行确认账号条款、版权与当地法律合规性。

## 完整性校验

压缩包旁提供 `.sha256` 文件；解压目录内提供 `SHA256SUMS.txt` 和 `PACKAGE_INFO.json`。传输后应重新计算 SHA-256 并比对。
