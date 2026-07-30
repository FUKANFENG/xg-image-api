# XG生图 Web 模式 API 开发文档

本文档面向需要把 XG生图接入自动化工作流、后端服务或第三方应用的开发者，覆盖：

- ChatGPT 网页生图
- ChatGPT 网页图片编辑与多参考图编辑
- ChatGPT 网页文字对话
- ChatGPT 网页看图对话
- Chat Completions 与 Responses 两种兼容协议
- 流式响应、图片上传、错误处理与重试

文档所述调用均经过本项目服务端的 ChatGPT Web 链路。客户端只需要持有本项目的 API Key，不需要也不应该接触账号池中的 ChatGPT Access Token。

## 1. 必须先理解的 Web-only 规则

如果你不希望消耗 Codex 生图额度，所有图片请求必须使用：

```text
gpt-image-2
```

不要使用以下模型：

```text
codex-gpt-image-2
plus-codex-gpt-image-2
team-codex-gpt-image-2
pro-codex-gpt-image-2
```

模型路由关系如下：

| 调用类型 | 模型 | 实际上游链路 | 是否使用 Codex 生图额度 |
| --- | --- | --- | --- |
| 网页生图、图片编辑 | `gpt-image-2` | ChatGPT Web `/backend-api/conversation` | 否 |
| Codex 生图 | `codex-gpt-image-2` 及套餐前缀 | Codex Responses | 是 |
| 文字或看图对话 | `auto` 或 `/v1/models` 返回的文字模型 | ChatGPT Web Conversation | 否 |

即使账号最初通过 Codex OAuth 文件导入，只要请求模型是 `gpt-image-2`，图片任务仍会进入 Web 生图链路；模型名称决定生图协议和额度池。

> 建议在自己的服务端封装中把图片模型写死为 `gpt-image-2`，不要允许终端用户任意传入 `codex-*` 图片模型。

## 2. 服务地址与鉴权

仓库自带 `docker-compose.yml` 的本机默认服务地址：

```text
http://127.0.0.1:3000
```

如果部署时把容器端口映射到了 `8001` 或其他端口，请把全文示例中的 Base URL 替换为实际地址；接口路径不变。

所有 `/v1/*` 接口都需要本项目的 API Key：

```http
Authorization: Bearer <XG_API_KEY>
```

这里的 `XG_API_KEY` 是项目设置中的 `auth-key`，不是 ChatGPT Access Token。

PowerShell 环境变量示例：

```powershell
$env:XG_API_BASE_URL = "http://127.0.0.1:3000"
$env:XG_API_KEY = "<你的本地 API Key>"
```

生产环境必须使用 HTTPS，并只在服务端保存 API Key。不要把 API Key、Access Token 或 Refresh Token写入浏览器代码、移动端安装包或公开仓库。

## 3. 接口总览

| 方法 | 路径 | 用途 | 推荐模型 |
| --- | --- | --- | --- |
| `GET` | `/health?format=json` | 健康检查 | 无 |
| `GET` | `/v1/models` | 获取当前可用模型 | 无 |
| `POST` | `/v1/chat/completions` | 文字对话、看图对话、流式对话 | `auto` 或文字模型 |
| `POST` | `/v1/responses` | Responses 风格文字、看图及图片工具调用 | `auto` / `gpt-image-2` |
| `POST` | `/v1/images/generations` | 网页文生图 | `gpt-image-2` |
| `POST` | `/v1/images/edits` | 网页图生图、局部修改、多图参考 | `gpt-image-2` |

推荐选择：

- 普通文字或看图聊天：`/v1/chat/completions`
- 需要 Responses 事件结构：`/v1/responses`
- 纯文生图：`/v1/images/generations`
- 有参考图、改图、换背景、局部重绘：`/v1/images/edits`

## 4. 启动后检查

### 4.1 健康检查

```http
GET /health?format=json
```

Python：

```python
import requests

base_url = "http://127.0.0.1:3000"
response = requests.get(f"{base_url}/health?format=json", timeout=10)
response.raise_for_status()
print(response.json())
```

### 4.2 获取模型

```python
import os
import requests

base_url = os.getenv("XG_API_BASE_URL", "http://127.0.0.1:3000")
api_key = os.environ["XG_API_KEY"]

response = requests.get(
    f"{base_url}/v1/models",
    headers={"Authorization": f"Bearer {api_key}"},
    timeout=30,
)
response.raise_for_status()
models = [item["id"] for item in response.json().get("data", [])]
print(models)
```

模型列表来自当前账号可以访问的 ChatGPT Web 模型，并附加本项目可执行的图片模型。图片任务仍应固定使用 `gpt-image-2`。

## 5. 网页文字对话

### 5.1 Chat Completions：普通对话

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer <XG_API_KEY>
```

请求：

```json
{
  "model": "auto",
  "messages": [
    {
      "role": "system",
      "content": "你是一名产品设计助手。"
    },
    {
      "role": "user",
      "content": "给我三个适合夏季饮料海报的创意方向。"
    }
  ],
  "stream": false
}
```

Python：

```python
import os
import requests

base_url = os.getenv("XG_API_BASE_URL", "http://127.0.0.1:3000")
api_key = os.environ["XG_API_KEY"]

response = requests.post(
    f"{base_url}/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    },
    json={
        "model": "auto",
        "messages": [
            {"role": "system", "content": "你是一名产品设计助手。"},
            {"role": "user", "content": "给我三个适合夏季饮料海报的创意方向。"},
        ],
        "stream": False,
    },
    timeout=300,
)
response.raise_for_status()
result = response.json()
answer = result["choices"][0]["message"]["content"]
print(answer)
```

典型响应：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1780000000,
  "model": "auto",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 200,
    "total_tokens": 300
  }
}
```

`usage` 是本项目按文本与图片尺寸计算的兼容统计，不应当作 OpenAI 官方账单数据。

### 5.2 多轮对话

此接口不要求客户端保存服务端会话 ID。需要上下文时，把历史消息一并传入：

```json
{
  "model": "auto",
  "messages": [
    {"role": "user", "content": "我要做一张咖啡新品海报。"},
    {"role": "assistant", "content": "你希望采用什么视觉风格？"},
    {"role": "user", "content": "极简、暖色、带手工纸张质感。"}
  ]
}
```

为避免请求越来越大，建议你的业务端保留最近几轮消息，或先对长历史进行摘要。

### 5.3 推理强度

兼容以下任一写法：

```json
{
  "reasoning_effort": "high"
}
```

```json
{
  "reasoning": {
    "effort": "high"
  }
}
```

支持值：

```text
low
medium
high
xhigh
extended
```

`xhigh` 会在内部归一化为 `extended`。具体模型是否采用该强度由 ChatGPT Web 上游决定。

## 6. 网页看图对话

看图对话必须使用文字模型，例如 `auto`。不要把模型写成 `gpt-image-2`，否则请求会被识别为图片生成，而不是图片理解。

### 6.1 使用公网图片 URL

```json
{
  "model": "auto",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "分析这张商品图的构图、光线和可以改进的地方。"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "https://example.com/product.png"
          }
        }
      ]
    }
  ],
  "stream": false
}
```

远程地址必须能被 XG生图服务所在机器访问，并直接返回图片内容。

### 6.2 使用 Base64 Data URL

```python
import base64
import mimetypes
import os
from pathlib import Path

import requests

base_url = os.getenv("XG_API_BASE_URL", "http://127.0.0.1:3000")
api_key = os.environ["XG_API_KEY"]
image_path = Path("reference.png")
mime = mimetypes.guess_type(image_path.name)[0] or "image/png"
encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
data_url = f"data:{mime};base64,{encoded}"

response = requests.post(
    f"{base_url}/v1/chat/completions",
    headers={"Authorization": f"Bearer {api_key}"},
    json={
        "model": "auto",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "描述图片内容，并给出三条优化建议。"},
                    {
                        "type": "image_url",
                        "image_url": {"url": data_url},
                    },
                ],
            }
        ],
    },
    timeout=300,
)
response.raise_for_status()
print(response.json()["choices"][0]["message"]["content"])
```

Chat/Responses JSON 图片支持：

- PNG
- JPEG/JPG
- WebP
- GIF
- Data URL
- 纯 Base64 对象
- HTTP/HTTPS 图片 URL

单张 JSON 图片最大 10 MB。大图建议先在客户端压缩，既能降低上传耗时，也能减少图片输入 token。

## 7. Chat Completions 流式对话

请求中设置：

```json
{
  "stream": true
}
```

服务返回 `text/event-stream`：

```text
: stream-open

data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...}

data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"你好"}}]}

data: [DONE]
```

Python 流式读取：

```python
import json
import os

import requests

base_url = os.getenv("XG_API_BASE_URL", "http://127.0.0.1:3000")
api_key = os.environ["XG_API_KEY"]

with requests.post(
    f"{base_url}/v1/chat/completions",
    headers={"Authorization": f"Bearer {api_key}"},
    json={
        "model": "auto",
        "messages": [{"role": "user", "content": "写一段产品发布文案。"}],
        "stream": True,
    },
    stream=True,
    timeout=300,
) as response:
    response.raise_for_status()
    for raw_line in response.iter_lines(decode_unicode=True):
        if not raw_line or not raw_line.startswith("data:"):
            continue
        payload = raw_line[5:].strip()
        if payload == "[DONE]":
            break
        event = json.loads(payload)
        choices = event.get("choices") or []
        if choices:
            print(choices[0].get("delta", {}).get("content", ""), end="", flush=True)
```

## 8. Responses：文字与看图对话

Responses 适合希望获得 `response.output` 和标准事件类型的调用方。

### 8.1 文字

```json
{
  "model": "auto",
  "instructions": "回答要简洁，使用中文。",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "帮我设计一个图片处理工作流。"
        }
      ]
    }
  ],
  "stream": false
}
```

典型文字响应：

```json
{
  "id": "resp_...",
  "object": "response",
  "created_at": 1780000000,
  "status": "completed",
  "model": "auto",
  "output": [
    {
      "id": "msg_...",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "...",
          "annotations": []
        }
      ]
    }
  ]
}
```

### 8.2 看图

```json
{
  "model": "auto",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "这张图里有哪些主体？"
        },
        {
          "type": "input_image",
          "image_url": "data:image/png;base64,<BASE64>"
        }
      ]
    }
  ]
}
```

`input_image.image_url` 也可以写成：

```json
{
  "url": "https://example.com/reference.png"
}
```

### 8.3 Responses 流式事件

设置 `"stream": true` 后，常见事件包括：

```text
response.created
response.output_item.added
response.output_text.delta
response.output_text.done
response.output_item.done
response.completed
```

整个 SSE 流仍以：

```text
data: [DONE]
```

结束。

## 9. 网页文生图

### 9.1 请求

```http
POST /v1/images/generations
Content-Type: application/json
Authorization: Bearer <XG_API_KEY>
```

```json
{
  "model": "gpt-image-2",
  "prompt": "一张极简纸雕风格的白鹤海报，暖白背景，柔和自然光",
  "n": 1,
  "size": "1024x1024",
  "quality": "auto",
  "response_format": "b64_json",
  "stream": false
}
```

字段：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 否 | `gpt-image-2` | Web-only 必须使用 `gpt-image-2` |
| `prompt` | string | 是 | 无 | 生图要求，不能为空 |
| `n` | integer | 否 | `1` | 生成数量，范围 `1-4` |
| `size` | string | 否 | 上游默认 | 推荐值见下方 |
| `quality` | string | 否 | `auto` | 可使用 `auto`、`low`、`high` |
| `response_format` | string | 否 | `b64_json` | `b64_json` 或 `url` |
| `stream` | boolean | 否 | `false` | 是否返回 SSE |

推荐尺寸：

| 比例 | `size` |
| --- | --- |
| 1:1 方图 | `1024x1024` |
| 3:2 横图 | `1536x1024` |
| 2:3 竖图 | `1024x1536` |

尺寸与质量会作为网页生图指令发送给上游；最终尺寸仍可能受到 ChatGPT Web 能力和策略影响。

### 9.2 Python

```python
import base64
import os
from pathlib import Path

import requests

base_url = os.getenv("XG_API_BASE_URL", "http://127.0.0.1:3000")
api_key = os.environ["XG_API_KEY"]

response = requests.post(
    f"{base_url}/v1/images/generations",
    headers={"Authorization": f"Bearer {api_key}"},
    json={
        "model": "gpt-image-2",
        "prompt": "一张极简纸雕风格的白鹤海报，暖白背景，柔和自然光",
        "n": 1,
        "size": "1024x1024",
        "quality": "auto",
        "response_format": "b64_json",
    },
    timeout=300,
)
response.raise_for_status()
result = response.json()

for index, item in enumerate(result.get("data", []), start=1):
    encoded = item.get("b64_json")
    if encoded:
        Path(f"generated-{index}.png").write_bytes(base64.b64decode(encoded))
```

### 9.3 响应

```json
{
  "created": 1780000000,
  "data": [
    {
      "b64_json": "<BASE64>",
      "url": "http://127.0.0.1:3000/images/...",
      "revised_prompt": "..."
    }
  ],
  "usage": {
    "input_tokens": 20,
    "output_tokens": 1056,
    "total_tokens": 1076,
    "input_tokens_details": {
      "text_tokens": 20,
      "image_tokens": 0,
      "cached_tokens": 0
    },
    "output_tokens_details": {
      "text_tokens": 0,
      "image_tokens": 1056,
      "reasoning_tokens": 0
    }
  }
}
```

当 `response_format=url` 时，客户端应及时下载结果，不要把生成图 URL 当作永久对象存储地址。

### 9.4 流式生图

把 `stream` 设置为 `true`。流中可能出现：

```json
{
  "object": "image.generation.chunk",
  "model": "gpt-image-2",
  "index": 1,
  "total": 1,
  "progress_text": "...",
  "data": []
}
```

最终图片事件：

```json
{
  "object": "image.generation.result",
  "model": "gpt-image-2",
  "index": 1,
  "total": 1,
  "data": [
    {
      "b64_json": "<BASE64>",
      "url": "http://127.0.0.1:3000/images/..."
    }
  ]
}
```

流以 `data: [DONE]` 结束。

## 10. 网页图片编辑与参考图生图

图片编辑统一使用：

```http
POST /v1/images/edits
```

适合以下任务：

- 修改参考图中的物体、文字、颜色或材质
- 保持主体，替换背景
- 商品图换场景
- 多张参考图融合
- 局部重绘
- 扩图和构图调整

模型必须是：

```text
gpt-image-2
```

### 10.1 multipart 文件上传

```powershell
curl.exe -X POST "http://127.0.0.1:3000/v1/images/edits" `
  -H "Authorization: Bearer $env:XG_API_KEY" `
  -F "model=gpt-image-2" `
  -F "prompt=保留人物和构图，把背景改成下雪的东京街头，电影感灯光" `
  -F "image=@reference.png" `
  -F "n=1" `
  -F "size=1024x1024" `
  -F "response_format=b64_json"
```

Python：

```python
import os

import requests

base_url = os.getenv("XG_API_BASE_URL", "http://127.0.0.1:3000")
api_key = os.environ["XG_API_KEY"]

with open("reference.png", "rb") as image_file:
    response = requests.post(
        f"{base_url}/v1/images/edits",
        headers={"Authorization": f"Bearer {api_key}"},
        data={
            "model": "gpt-image-2",
            "prompt": "保留人物和构图，把背景改成下雪的东京街头，电影感灯光",
            "n": "1",
            "size": "1024x1024",
            "quality": "auto",
            "response_format": "b64_json",
        },
        files={"image": ("reference.png", image_file, "image/png")},
        timeout=300,
    )

response.raise_for_status()
print(response.json())
```

### 10.2 多张参考图

multipart 中重复提交 `image` 或使用 `image[]`：

```python
import os

import requests

base_url = os.getenv("XG_API_BASE_URL", "http://127.0.0.1:3000")
api_key = os.environ["XG_API_KEY"]

with open("person.png", "rb") as person, open("style.jpg", "rb") as style:
    response = requests.post(
        f"{base_url}/v1/images/edits",
        headers={"Authorization": f"Bearer {api_key}"},
        data={
            "model": "gpt-image-2",
            "prompt": "第一张图的人物保持一致，使用第二张图的色彩和插画风格。",
            "n": "1",
        },
        files=[
            ("image[]", ("person.png", person, "image/png")),
            ("image[]", ("style.jpg", style, "image/jpeg")),
        ],
        timeout=300,
    )

response.raise_for_status()
print(response.json())
```

提示词应明确说明每张图的用途，例如“第一张作为主体，第二张只参考配色，第三张只参考服装”。

### 10.3 JSON 公网图片 URL

```json
{
  "model": "gpt-image-2",
  "prompt": "保留商品主体，把背景替换为浅灰色摄影棚。",
  "images": [
    {
      "image_url": "https://example.com/product.png"
    }
  ],
  "n": 1,
  "response_format": "b64_json"
}
```

图片 URL 必须：

- 使用 HTTP 或 HTTPS
- 直接返回图片
- 不带 URL 用户名或密码
- 解析到公网地址
- 重定向不超过 3 次
- 单张不超过 50 MB

出于 SSRF 防护，`localhost`、`127.0.0.1`、局域网 IP 和其他非公网地址会被拒绝。调用方若要传本地图片，应使用 multipart 或 Data URL。

### 10.4 JSON Data URL 或纯 Base64

Data URL：

```json
{
  "model": "gpt-image-2",
  "prompt": "把背景改成纯白，保留商品和阴影。",
  "image": "data:image/png;base64,<BASE64>",
  "n": 1
}
```

纯 Base64 对象：

```json
{
  "model": "gpt-image-2",
  "prompt": "把杯子的颜色改成深绿色。",
  "images": [
    {
      "base64": "<BASE64>",
      "filename": "cup.png",
      "mime_type": "image/png"
    }
  ]
}
```

### 10.5 Mask 局部编辑

multipart：

```python
with open("source.png", "rb") as source, open("mask.png", "rb") as mask:
    response = requests.post(
        f"{base_url}/v1/images/edits",
        headers={"Authorization": f"Bearer {api_key}"},
        data={
            "model": "gpt-image-2",
            "prompt": "只修改透明区域，增加一束白色鲜花。",
        },
        files={
            "image": ("source.png", source, "image/png"),
            "mask": ("mask.png", mask, "image/png"),
        },
        timeout=300,
    )
```

Mask 语义：

- 透明或低 Alpha 区域：需要编辑
- 不透明或高 Alpha 区域：尽量保留

Mask 会被调整到原图尺寸，并作为图片 Alpha 通道合成后发送到 Web 生图链路。

## 11. 在 Chat Completions 中进行参考图生图

此方式可以使用，但返回图片嵌在 `choices[0].message.content` 的 Markdown Data URL 中。业务系统更容易稳定解析 `/v1/images/edits`，因此优先使用上一节接口。

请求：

```json
{
  "model": "gpt-image-2",
  "n": 1,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "保持主体不变，把画面改成水彩插画。"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,<BASE64>"
          }
        }
      ]
    }
  ]
}
```

响应内容类似：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "![image_1](data:image/png;base64,<BASE64>)"
      }
    }
  ]
}
```

注意这里使用 `gpt-image-2` 是“参考图生成图片”。如果你想让模型描述或分析图片，应改用 `auto` 或其他文字模型。

## 12. Responses 图片生成与参考图编辑

### 12.1 文生图

```json
{
  "model": "gpt-image-2",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "生成一张东方幻想风格的山水海报。"
        }
      ]
    }
  ],
  "tools": [
    {
      "type": "image_generation",
      "size": "1024x1536",
      "quality": "auto"
    }
  ],
  "stream": false
}
```

非流式响应中的图片位于：

```text
output[].type == "image_generation_call"
output[].result
```

`result` 是不带 Data URL 前缀的 Base64 图片。

### 12.2 参考图编辑

```json
{
  "model": "gpt-image-2",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "保留人物，改成复古胶片风格。"
        },
        {
          "type": "input_image",
          "image_url": "data:image/png;base64,<BASE64>"
        }
      ]
    }
  ],
  "tools": [
    {
      "type": "image_generation",
      "size": "1024x1024"
    }
  ]
}
```

Responses 图片工具当前只提取一个有效参考图。需要多参考图时使用 `/v1/images/edits`。

## 13. OpenAI Python SDK 接入

安装：

```powershell
python -m pip install openai
```

文字对话：

```python
import os
from openai import OpenAI

base_url = os.getenv("XG_API_BASE_URL", "http://127.0.0.1:3000")

client = OpenAI(
    api_key=os.environ["XG_API_KEY"],
    base_url=f"{base_url.rstrip('/')}/v1",
    timeout=300,
)

completion = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "给我三个电商主图创意。"},
    ],
)
print(completion.choices[0].message.content)
```

文生图：

```python
result = client.images.generate(
    model="gpt-image-2",
    prompt="极简白底产品摄影，一只深绿色陶瓷杯",
    n=1,
    size="1024x1024",
    response_format="b64_json",
)
```

图片编辑的 multipart 字段扩展较多，建议直接使用 `requests`，以便明确提交多参考图、URL 或 Mask。

## 14. 项目内置零依赖客户端

项目提供：

```python
from sdk import XGAPIClient
```

```python
import os

from sdk import XGAPIClient

client = XGAPIClient(
    base_url=os.getenv("XG_API_BASE_URL", "http://127.0.0.1:3000"),
    api_key=os.environ["XG_API_KEY"],
)

chat_result = client.chat(
    [{"role": "user", "content": "给我一个海报创意。"}],
    model="auto",
)

image_result = client.generate_image(
    "极简纸雕风格白鹤海报",
    model="gpt-image-2",
    size="1024x1024",
)
client.save_images(image_result, "output")

edit_result = client.edit_image(
    "保持主体，把背景换成雪山",
    ["https://example.com/reference.png"],
    model="gpt-image-2",
)
client.save_images(edit_result, "output-edited")
```

该客户端处理非流式 JSON。流式 SSE 请使用 `requests`、`httpx` 或你所使用语言的 SSE 客户端。

## 15. 错误响应与处理策略

图片接口通常使用 OpenAI 风格错误：

```json
{
  "error": {
    "message": "no available image quota",
    "type": "insufficient_quota",
    "param": null,
    "code": "insufficient_quota"
  }
}
```

常见状态：

| HTTP 状态 | 含义 | 建议 |
| --- | --- | --- |
| `400` | 参数、图片、URL、Mask 或内容策略错误 | 修正请求，不要原样重试 |
| `401` | API Key 错误 | 停止重试，检查本项目 API Key |
| `422` | JSON 字段类型或范围不合法 | 修正参数 |
| `429` | 账号额度不足、全部账号限流或暂时无槽位 | 降低并发，遵守 `Retry-After`，检查账号池 |
| `502` | ChatGPT Web 上游失败、连接失败或未返回有效结果 | 指数退避后有限重试 |

推荐重试策略：

1. 连接超时、连接断开、`502`：最多重试 2 次。
2. `429`：优先读取 `Retry-After`，没有时从 2 秒开始指数退避。
3. `400`、`401`、`422`：不要自动重试。
4. 图片请求设置 300 秒以上的客户端超时。
5. 不要在客户端超时后立刻换业务任务 ID 重复提交，远端任务可能已经生成，重复提交会额外消耗额度。

## 16. 并发与额度建议

- `n=1` 时一个请求生成一张图。
- `n>1` 时项目可并行使用多个可用账号。
- 每张成功图片会消耗对应 Web `image_gen` 额度。
- 单账号剩余额度、状态和恢复时间来自 ChatGPT Web 上游，并由项目定时刷新。
- 业务端应控制批量并发，不要把账号池总额度等同于安全瞬时并发。
- 持续 `429` 时应暂停任务并查看网页“账号池”和“运行状态”。

建议业务端记录：

- 自己的任务 ID
- 调用接口
- 模型
- 请求开始和结束时间
- HTTP 状态
- 重试次数
- 输出文件路径或对象存储 Key

不要记录：

- 完整 Access Token
- Refresh Token
- API Key
- 完整 Base64 图片日志

## 17. 生产部署注意事项

1. 使用 HTTPS。
2. API Key 只保存在调用方服务端。
3. 通过反向代理限制请求体大小和请求频率。
4. 图片 URL 必须使用调用方可以访问的正式域名。
5. `response_format=url` 依赖请求 Host 生成图片地址，反向代理要正确传递 Host 和协议。
6. 长时间图片任务的代理读取超时建议不少于 300 秒。
7. Base64 会让 JSON 请求和响应体积增加约三分之一；大文件优先 multipart。
8. 使用自己的对象存储持久化最终图片，不要依赖临时返回 URL。

## 18. 最小接入检查表

- [ ] `/health?format=json` 返回成功
- [ ] `/v1/models` 可以读取
- [ ] 图片模型固定为 `gpt-image-2`
- [ ] 没有使用任何 `codex-*` 图片模型
- [ ] 文字/看图对话使用 `auto` 或文字模型
- [ ] 参考图修改优先调用 `/v1/images/edits`
- [ ] 客户端超时不低于 300 秒
- [ ] 对 `429` 和 `502` 做有限退避重试
- [ ] API Key 与 Access Token 没有进入前端或日志
- [ ] 生成图片已转存到自己的持久化存储
