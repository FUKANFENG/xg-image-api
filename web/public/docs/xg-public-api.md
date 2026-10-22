# XG 公网生图 API 开发文档

适用部署：`https://picture.museyin.com`。协议核对日期：2026-10-14。
这是 XG 的 Cloudflare 公网接口，不是 OpenAI 官方 API，也不是旧额度门户 `/api/share/*` 协议。

## 1. 给其他 Agent 的入口

- 可阅读页面：https://picture.museyin.com/developers/
- 本文 Markdown：https://picture.museyin.com/docs/xg-public-api.md
- OpenAPI 3.0：https://picture.museyin.com/docs/xg-public-api.openapi.json
- 无第三方依赖的 Python 示例客户端：https://picture.museyin.com/docs/xg_image_client.py
- 服务根地址：`https://picture.museyin.com`
- OpenAI 兼容 Base URL：`https://picture.museyin.com/v1`

**推荐工作流：提交异步任务 → 每 3–5 秒查询状态 → 成功后鉴权下载图片。**
异步接口在服务根地址的 `/api/image-tasks` 下，不要拼成 `/v1/api/image-tasks`。
一个异步任务生成一张图；批量生图由调用方为每张图分配不同业务 ID，并限制并发。

连接路径：Agent → Cloudflare HTTPS → 本机隧道 → XG 队列 → ChatGPT Web 生图 → XG 存储结果。
Windows、Docker、XG 和 Cloudflare 隧道都需要在线；Cloudflare 不会独立执行生成任务。

## 2. 鉴权与模型

由服务管理员在“接口接入”中创建并单独分发普通用户 API Key。权限、剩余额度和可用功能由管理员配置。
不要把管理员部署密钥分发给第三方；不要把 ChatGPT 账号的 Access Token 当作 XG API Key。
以下请求（包括图片下载）都应携带：

```http
Authorization: Bearer <XG_API_KEY>
User-Agent: XG-Agent/1.0
```

网页免登录只针对当前部署的网页访问策略，不代表程序 API 可以省略 Bearer。
密钥放在调用方服务的环境变量或密钥管理器中，不放到 URL、提示词、公开仓库、日志或前端 JS。
本文和 OpenAPI 不包含真实密钥。纯文档无需登录即可读取。

模型固定使用 `gpt-image-2`，在本项目中对应 ChatGPT Web 图片链路，不使用 `codex-gpt-image-2` 的 Codex 图片路径。
这不代表无限额度或免费保证：仍受账号网页端额度、上游风控、限流和当前服务资源约束。
不要用 `auto` 代替指定模型来承诺固定链路。可通过 `GET /v1/models` 检查模型是否可用。

## 3. 接口速查

| 方法 | 路径（相对服务根地址） | 用途 |
| --- | --- | --- |
| GET | `/v1/models` | 模型列表，读取 `data[].id` |
| POST | `/api/image-tasks/generations` | 文生图，JSON 请求 |
| POST | `/api/image-tasks/edits` | 参考图编辑，JSON 或 multipart |
| GET | `/api/image-tasks?ids={id}` | 查询任务；返回 `items` 数组而非单个任务 |
| POST | `/api/image-tasks/{id}/cancel` | 取消指定任务，无需请求体 |
| GET | `/images/{path}` | 带 Bearer 下载结果，路径取自返回值 |

注意：当前没有用于查询单任务的 `GET /api/image-tasks/{id}`；必须使用 `?ids=`。
不存在的路径可能返回网页 HTML，HTTP 200 本身不代表 API 调用成功。检查 Content-Type 和 JSON 内容。

## 4. 文生图

`POST /api/image-tasks/generations`，`Content-Type: application/json`。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `client_task_id` | 是 | 唯一业务任务 ID，推荐 UUID；提交前持久保存，重试使用原值 |
| `prompt` | 是 | 非空文字需求，描述主体、构图、风格、尺寸/比例等 |
| `model` | 否 | 明确传 `gpt-image-2`，默认也是该值 |
| `size` | 否 | 期望尺寸，如 `1024x1024`、`1536x1024`、`1024x1536`；实际尺寸以结果为准 |
| `quality` | 否 | 默认 `auto`，建议保留默认；不是 Codex 推理档位 |
| `priority` | 否 | -10 到 10，默认 0；普通调用保持默认即可 |

不要在此接口传 `n`、`stream` 或 `response_format` 期待同步多图返回；异步任务内部固定一张、URL 结果。

### PowerShell

先安全设置环境变量 `XG_API_KEY`。下面请求不包含真实密钥：

```powershell
$base = "https://picture.museyin.com"
$headers = @{ Authorization = "Bearer $env:XG_API_KEY"; "User-Agent" = "XG-Agent/1.0" }
$taskId = [guid]::NewGuid().ToString() # 保存到业务记录，重试不能重新生成
$payload = @{
  client_task_id = $taskId
  model = "gpt-image-2"
  prompt = "一只纸雕风格的白鹤，柔和自然光，方形构图"
  size = "1024x1024"
} | ConvertTo-Json
$task = Invoke-RestMethod "$base/api/image-tasks/generations" `
  -Method Post -Headers $headers -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 60
$task | Select-Object id, status
```

成功提交返回 HTTP `200`，示意内容如下（不是 `202`，也不是 `{task: ...}`）：

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "mode": "generate",
  "model": "gpt-image-2",
  "size": "1024x1024",
  "quality": "auto",
  "progress": "queued"
}
```

任务可能已经进入 `running`，或重复提交时直接返回历史终态；不要硬编码只接受 `queued`。

## 5. 查询、完成检测与下载

```powershell
$deadline = (Get-Date).AddMinutes(20)
do {
  $reply = Invoke-RestMethod "$base/api/image-tasks?ids=$taskId" -Headers $headers -TimeoutSec 30
  if ($reply.missing_ids -contains $taskId) { throw "任务不存在：确认 ID 和 API Key 身份，不要自动重建" }
  $task = $reply.items | Where-Object { $_.id -eq $taskId } | Select-Object -First 1
  if (-not $task) { throw "响应中没有目标任务" }
  if ($task.status -in @("success", "error", "paused")) { break }
  if ((Get-Date) -ge $deadline) { throw "等待超时，请保存任务 ID 后继续查询；服务端任务可能仍在运行" }
  Start-Sleep -Seconds 4
} while ($true)
if ($task.status -ne "success") { throw "$($task.status): $($task.error_code) $($task.error)" }
if (-not $task.data -or -not $task.data[0].url) { throw "成功任务缺少图片结果" }
$imageUrl = [Uri]::new([Uri]($base + "/"), [string]$task.data[0].url)
if ($imageUrl.GetLeftPart([UriPartial]::Authority) -ne $base) { throw "外部存储地址：不要向第三方转发 XG API Key" }
# 禁止自动跟随重定向，避免误把密钥传给其他站点
Invoke-WebRequest $imageUrl.AbsoluteUri -Headers $headers -MaximumRedirection 0 -OutFile "result.png"
```

查询响应示意：

```json
{
  "items": [{
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "success",
    "model": "gpt-image-2",
    "data": [{
      "url": "/images/2026/10/example.png",
      "width": 1024,
      "height": 1024,
      "size_bytes": 123456,
      "revised_prompt": "..."
    }],
    "duration_ms": 62000
  }],
  "missing_ids": []
}
```

示例路径和数值不是实际资产。`data[].width/height/size_bytes` 为可选元数据；`task.size` 是请求值，不保证等于输出尺寸。
`url` 可能是相对路径，必须相对公网服务根地址解析。不要按调用机器的 localhost 拼接。
本地存储的 `/images/*` 需要 Bearer，不能假定拿到 URL 就能匿名读取；在前端使用自有服务代理下载，不把 Key 暴露给访客。
如果启用了外部图片存储，绝不能向不同域名发送 XG API Key；请由管理员提供对应存储的下载方式。

| 状态 | 含义 | 调用方动作 |
| --- | --- | --- |
| `queued` | 在 XG 队列中等待 | 继续低频轮询 |
| `running` | 已开始执行 | 继续轮询，不再提交同一业务的新 ID |
| `paused` | 已暂停 | 停止自动轮询并提示管理员处理 |
| `success` | 生成成功 | 读取 `data[]`，下载并保存 |
| `error` | 失败或取消 | 读取 `error_code`、`error`，结束轮询 |

批量查询：`?ids=id1,id2`（正确 URL 编码）。不传 ids 可分页读取当前身份的任务：`?limit=20&offset=0`，limit 为 1–200。
没有权限或已清理的任务可能出现在 `missing_ids`。任务记录有保留期限；图片也可能被清理，请及时保存结果。

## 6. 多张参考图 / 图生图

`POST /api/image-tasks/edits`。它使用相同的 `client_task_id`、`prompt`、`model`、`size`、`quality` 和任务查询协议。
一张或多张参考图都可以；图的数量不等于输出数量。明确说明“第 1 张是什么，第 2 张是什么”。
没有承诺无限张数；请求体大小、Cloudflare 限制、上游能力与实际处理时间都会限制一次请求。
优先使用压缩后的 PNG/JPEG/WebP、小批参考图，并从 2–4 张开始验证自己的场景。

### multipart 上传本地文件（PowerShell + curl.exe）

不要手动设置 multipart 的 Content-Type/boundary，让客户端生成。
`image[]` 可以重复多次；每增加一张图就加一个同名字段。

```powershell
$editId = [guid]::NewGuid().ToString() # 重试保留原 ID 和原始文件
curl.exe --fail-with-body --max-time 90 "$base/api/image-tasks/edits" `
  -H "Authorization: Bearer $env:XG_API_KEY" `
  -H "User-Agent: XG-Agent/1.0" `
  -F "client_task_id=$editId" `
  -F "model=gpt-image-2" `
  -F "prompt=保留第一张人物外观，参考第二张的服装和配色，白色背景" `
  -F "image[]=@./person.png" `
  -F "image[]=@./clothes.jpg"
```

成功返回任务对象，再查询 `/api/image-tasks?ids={editId}`。上传、下载参考图和校验都发生在提交阶段，上传超时不代表服务端完全没有收到请求。

### JSON 图片地址 / Data URL

`Content-Type: application/json`：

```json
{
  "client_task_id": "a-new-persisted-uuid",
  "model": "gpt-image-2",
  "prompt": "保留第一张的主体，把背景替换为第二张的环境",
  "images": [
    "data:image/png;base64,<第一张图片的完整Base64>",
    "data:image/jpeg;base64,<第二张图片的完整Base64>"
  ]
}
```

也可将数组项替换成 XG 服务能下载的 HTTPS 图片 URL。上例 Base64 占位符不可直接发送。
不能传调用方的 `C:\...`、`file://`、`localhost` 或内网地址给服务器下载；上传本地文件请用 multipart/Data URL。
远程 URL 受地址安全校验和下载大小约束，不会使用调用方的 Cookie。
Base64 会增大请求体，图片较大时优先 multipart。
可选 `mask` 是与第一张参考图尺寸一致的 PNG 遮罩，透明区域表示待编辑区域；本指南采用单个遮罩。本地上传使用 `-F "mask=@./mask.png"`。

## 7. Python Agent 最短接入

下载并审阅 `xg_image_client.py` 后放入工作目录。Python 3.10+，仅标准库；支持文件参考图、文生图、轮询和安全下载。

```python
import os
from pathlib import Path
from xg_image_client import XGImageClient

client = XGImageClient(os.environ["XG_API_KEY"])
# 使用你已持久保存的业务 UUID；不要在网络重试时生成新 ID
task_id = "550e8400-e29b-41d4-a716-446655440000"
client.submit(task_id, "一只纸雕白鹤，柔和自然光")
# 图生图改为：client.submit(task_id, "保留人物，参考第二张服装", images=[Path("person.png"), Path("clothes.jpg")])
task = client.wait(task_id, timeout=1200)
client.download(task["data"][0]["url"], Path("result.png"))
```

也可以直接运行 CLI（任务 ID 必须由调用方提供，方便恢复）：

```powershell
python xg_image_client.py --task-id "你保存的唯一UUID" --prompt "一只纸雕白鹤" --output result.png
# 多图：追加 --image person.png --image clothes.jpg
# 断线后仅查询，不重新提交：
python xg_image_client.py --task-id "原来的UUID" --resume --output result.png
```

示例客户端不会自动重试 POST，避免意外重复执行。查询会有限重试短暂网络错误/429/5xx；错误输出不会记录密钥或完整 Cloudflare HTML。

## 8. 幂等、取消、错误与并发

- 服务按“调用身份 + client_task_id”复用已存在任务，而不是按提示词去重。记录存在时，相同 ID 的提交返回原任务；**换了参数但没换 ID 也不会得到新图**。
- 幂等作用域是身份，不是每个工具名称；共享同一个 Key 的多个 Agent 必须使用不同的 UUID。不同用户身份不能用同一个 ID 找到对方任务。
- 这是记录保留期间的去重，不是永久 exactly-once 保证。任务被删除/过期后同 ID 可以重新创建。不要把旧 ID 作为永久业务去重数据库。
- 连接超时、502/504/524 后先查询原 ID；确认需要重发时仍用原 ID 和完全相同内容。参考图重复 POST 仍可能重复处理上传文件，所以优先查询。
- 已经明确 `error` 的任务不会因重复 POST 同 ID 自动重新执行。修正原因后，显式创建新的业务尝试并保存与原 ID 的关联；不要无限重试。
- `POST /api/image-tasks/{id}/cancel` 无需请求体；取消表现为 `status=error`、`error_code=cancelled_by_user`，不是 `cancelled` 状态。已终结的任务返回原结果。取消本地等待不保证能撤销上游已经发生的计算。
- 有限额身份在提交时预占 XG 本地额度，成功确认、失败或取消后释放预占；这不是 ChatGPT 官方剩余额度的精确计量，也不是上游费用退款承诺。
- 调用方可从滚动并发 2 开始：任一任务终结再补下一张，不要一次提交大量任务。实际容量由账号槽位动态决定，不保证“每账号固定并发”或“每天固定张数”。

| 现象 | 处理方式 |
| --- | --- |
| HTTP 400 / 422 | 参数错误；检查 JSON、client_task_id、图片、遮罩，不原样无限重试 |
| HTTP 401 | Key 缺失/无效，停止重试，请管理员检查 |
| HTTP 403 JSON | 权限或功能不允许；联系管理员 |
| HTTP 403 HTML / 浏览器挑战 | Cloudflare 访问策略拦截；联系域名管理员配置合法机器访问，不由 Agent 绕过挑战 |
| HTTP 413 | 请求体过大，压缩或减少参考图 |
| HTTP 429 | 队列、额度或上游限流；优先遵守 Retry-After（秒或日期），否则指数退避加抖动，最多有限次；额度不足要管理员处理 |
| HTTP 5xx / 网络断线 | 隧道、XG 或上游不可达；先查原任务，有限重试查询，不盲目重复创建 |
| HTTP 200 但 task.status=error | 业务任务失败；查看 error_code/error，不能当成功 |
| HTTP 200 但不是 JSON | 常见于路径错误或 HTML 页面；不要按成功解析 |
| 等待超过调用方截止时间 | 保存任务 ID 后稍后继续查询；超时并不自动取消服务端任务 |

错误可能是 `{"detail":{"error":"..."}}`、参数校验 `detail` 数组，或任务对象内的 `error_code/error`。应同时检查 HTTP 状态和业务状态。

## 9. OpenAI 兼容方式与边界

已有工具必须使用 OpenAI SDK 时，将 Base URL 配为 `https://picture.museyin.com/v1`，Key 为 XG Key，调用 `images.generate(model="gpt-image-2", prompt="...", n=1)` 或 `images.edit`。
这两个 `/v1/images/*` 是同步等待接口，公网长任务可能先触发 Cloudflare 代理超时。调高 SDK 读取超时并不能调高代理的限制，因此公网 Agent 默认使用上面的异步任务 API。
同步接口不等于异步的 client_task_id 去重协议；不要假设对 `/v1/images/generations` 自动重试是幂等的。
Chat/Responses 等兼容接口不在本份生图接入文档范围；不需要为了生图去调用 Codex 或聊天工具。

本文面向服务端 Agent、脚本与工作流。其他网站前端直接跨域调用还受 CORS 限制；应通过自己的后端接入，不为此关闭安全检查。
请验证 TLS 证书，不使用跳过证书校验选项。生产接入后用 `/api-tasks/` 查看提示词、参考图、耗时、错误与结果，管理入口不应作为 Agent 的数据接口。
