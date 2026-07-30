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

## Python 客户端方法

- `health()`：健康检查。
- `list_models()`：读取模型。
- `generate_image(prompt, ...)`：生成图片。
- `edit_image(prompt, images, ...)`：使用图片 URL 或 Data URL 编辑图片。
- `chat(messages, ...)`：非流式 Chat Completions。
- `responses(input_value, ...)`：非流式 Responses。
- `save_images(response, output_dir)`：保存 `b64_json` 或 URL 形式的图片结果。

客户端默认网络超时为 300 秒。对 `429` 最多重试两次，并优先遵守服务端 `Retry-After`；这只能处理短暂拥塞，不能替代账号池容量和调用频率控制。批量工作流应在自身队列中限制并发，遇到持续 429 时暂停提交并查看网页“运行状态”。

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
