# XG生图工作流 API

这个项目现在按 API-first 方式组织：工作流只依赖稳定的 OpenAI 兼容接口，网页主要用于生图联调、账号池和运行状态管理。原有高级能力仍然保留在后台“更多”菜单中。

需要确保图片调用只走 ChatGPT Web、不消耗 Codex 生图额度，或需要文字对话、看图对话、参考图编辑、Mask、多图、Responses 和 SSE 的完整示例，请阅读 [`WEB_API_REFERENCE.md`](./WEB_API_REFERENCE.md)。Swagger、Postman 等工具可导入 [`openapi-web-api.yaml`](./openapi-web-api.yaml)。

本机网页默认无需登录。推荐用 `.\scripts\start.ps1` 启动：无冲突时访问 `http://127.0.0.1:18080`，若端口被占用则使用脚本打印的实际地址。免登录只对启用了 `CHATGPT2API_WEB_NO_LOGIN` 的 loopback 同源浏览器请求生效；下列工作流 API 始终继续使用 Bearer API Key。

## 最小接入

准备两个环境变量：

```powershell
$env:XG_API_BASE_URL = "http://127.0.0.1:18080"
$env:XG_API_KEY = "<在设置页查看的 API Key>"
```

项目附带一个不依赖第三方包的 Python 客户端：

```python
import os

from sdk import XGAPIClient

client = XGAPIClient(
    base_url=os.getenv("XG_API_BASE_URL", "http://127.0.0.1:18080"),
    api_key=os.environ["XG_API_KEY"],
)

result = client.generate_image(
    "极简纸雕风格的白鹤，柔和自然光",
    model="gpt-image-2",
)
files = client.save_images(result, "output")
```

直接运行完整示例：

```powershell
python examples/workflow_image.py
```

## 稳定接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 服务健康检查 |
| `GET` | `/v1/models` | 读取模型 |
| `POST` | `/v1/images/generations` | 文生图 |
| `POST` | `/v1/images/edits` | 图片编辑 |
| `POST` | `/v1/chat/completions` | 面向文本、搜索和图片场景的兼容对话 |
| `POST` | `/v1/responses` | Responses 兼容调用 |

所有 `/v1/*` 请求使用：

```http
Authorization: Bearer <API_KEY>
```

Base URL 既可以传服务根地址 `http://127.0.0.1:18080`，也可以传 OpenAI 风格的 `http://127.0.0.1:18080/v1`；附带客户端会自动归一化。端口自动切换时，以启动脚本打印的地址为准。

## Fast Scheduler V2

`/v1/images/generations`、`/v1/images/edits`、Chat Completions 图片请求、Responses 图片工具和网页异步生图现在共用同一个调度队列、全局并发上限与账号槽位池，不再存在图片接口绕过队列的独立并发路径。纯文字 Chat / Responses 不进入图片队列。

- 图片请求在内部创建任务并以事件驱动方式等待，因此 HTTP 响应格式保持兼容，且不会长期占用 Web 公共线程池。
- `n=1-4` 会拆成独立子任务；每张图可单独选账号、重试和释放槽位。只有全部子任务成功才返回聚合成功响应，任一失败会返回 `partial_generation_failed`。
- 管理页 `/api-tasks` 只展示一个父任务，并显示子任务总数、完成数、失败数、提示词、尺寸和结果。
- 多调用方竞争时，每个调用方保留基础份额；只有一个调用方时可借用全部空闲槽位。
- 实际远程并发是 `min(global_max_remote_tasks, 所有可用账号动态槽位之和)`。把全局上限设为 16 不会把当前 5 个账号槽位变成 16 个。
- 上游任务结束会立即触发下一任务补位，不依赖固定周期扫描。

超时按阶段分开：

| 配置 | 默认值 | 起算点 |
| --- | ---: | --- |
| `image_submit_timeout_secs` | 30 秒 | 选择账号和向上游提交 |
| `generation_timeout_seconds` | 300 秒 | 上游确认接受任务后 |
| `image_v1_sync_wait_timeout_secs` | 1800 秒 | `/v1` 请求进入本地统一队列后 |

如果工作流可能排在长队尾，调用方读取超时应略高于 `image_v1_sync_wait_timeout_secs`。调用方提前断开不会自动取消已经提交到上游的任务，可在 `/api-tasks` 查看最终结果，避免立刻重复提交。

## Python 客户端方法

- `health()`：健康检查。
- `list_models()`：读取模型。
- `generate_image(prompt, ...)`：生成图片。
- `edit_image(prompt, images, ...)`：使用图片 URL 或 Data URL 编辑图片。
- `chat(messages, ...)`：非流式 Chat Completions。
- `responses(input_value, ...)`：非流式 Responses。
- `save_images(response, output_dir)`：保存 `b64_json` 或 URL 形式的图片结果。

客户端默认网络超时为 300 秒；长队列场景可在创建 `XGAPIClient` 时把 `timeout` 调到 1900 秒或更高。对 `429` 最多重试两次，并优先遵守服务端 `Retry-After`；这只能处理短暂拥塞，不能替代账号池容量和调用频率控制。批量工作流应在自身队列中限制并发，遇到持续 429 时暂停提交并查看网页“运行状态”。

## OpenAI SDK 接入

也可以使用任何支持自定义 Base URL 的 OpenAI 兼容客户端：

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["XG_API_KEY"],
    base_url=os.getenv("XG_API_BASE_URL", "http://127.0.0.1:18080") + "/v1",
)

result = client.images.generate(
    model="gpt-image-2",
    prompt="一只纸雕风格的白鹤",
    n=1,
    response_format="b64_json",
)
```

`/v1/chat/completions` 与 `/v1/responses` 是面向本项目支持的文本、搜索和图片场景的兼容接口，不应假设它们覆盖 OpenAI 官方接口的全部参数。

## 工作流建议

1. 启动后先调用 `/health` 和 `/v1/models`。
2. 一个工作流节点只提交一个业务请求；批量任务由外层队列控制。
3. 为每个任务记录业务 ID、模型、耗时、HTTP 状态和返回图片路径，不记录完整 Access Token 或 API Key。
4. 对连接错误做有限重试；对持续 `401` 停止重试并检查 API Key；对持续 `429` 降低并发。
5. 网页“生图测试”用于区分是服务链路问题，还是工作流封装问题。
