// Public deployment entry, intentionally independent of the browser's local origin.
export const XG_PUBLIC_BASE_URL = "https://picture.museyin.com";
export const XG_PUBLIC_DOC_PATH = "/docs/xg-public-api.md";
export const XG_PUBLIC_SCHEMA_PATH = "/docs/xg-public-api.openapi.json";
export const XG_PUBLIC_CLIENT_PATH = "/docs/xg_image_client.py";

export const XG_AGENT_INSTRUCTIONS = `需要生成或编辑图片时，使用 XG 生图服务。
先读取开发文档：${XG_PUBLIC_BASE_URL}${XG_PUBLIC_DOC_PATH}
OpenAPI：${XG_PUBLIC_BASE_URL}${XG_PUBLIC_SCHEMA_PATH}
服务根地址：${XG_PUBLIC_BASE_URL}（异步任务接口不要加 /v1）
鉴权：Authorization: Bearer <XG_API_KEY>，从安全环境变量读取，缺失时向用户索取，不输出密钥。
使用 model=gpt-image-2（ChatGPT Web 图片链路），不要选择 codex-gpt-image-2。
文生图：POST /api/image-tasks/generations；参考图编辑：POST /api/image-tasks/edits。
每个业务任务生成并持久保存唯一 client_task_id；网络重试必须保持同一 ID 和相同参数。
每 3–5 秒 GET /api/image-tasks?ids=<client_task_id>，从 items 数组读取状态。
success 后读取 data[].url，将相对路径拼到服务根地址，下载 /images/* 时仍带 Bearer。
error 时报告 error_code 和 error；paused 时提示人工处理；不要把提交成功当作生成成功。
下载时不要把 API Key 转发给其他域名；不要调用管理接口或无限重试。
不要改用长连接同步生图规避错误。HTML 错误页先检查 Cloudflare/隧道，JSON 错误按文档处理。`;

export const XG_POWERSHELL_EXAMPLE = `$base = "${XG_PUBLIC_BASE_URL}"
# XG_API_KEY 由服务管理员单独提供，提前设置到环境变量
$headers = @{ Authorization = "Bearer $env:XG_API_KEY"; "User-Agent" = "XG-Agent/1.0" }
$taskId = [guid]::NewGuid().ToString() # 保存此 ID，网络重试不更换
$body = @{ client_task_id = $taskId; model = "gpt-image-2";
  prompt = "一只纸雕风格的白鹤，柔和自然光" } | ConvertTo-Json
$task = Invoke-RestMethod "$base/api/image-tasks/generations" \`
  -Method Post -Headers $headers -ContentType "application/json; charset=utf-8" \`
  -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60
# 异步提交只返回任务；每 3–5 秒查询一次，直到 success / error
Invoke-RestMethod "$base/api/image-tasks?ids=$taskId" -Headers $headers -TimeoutSec 30`;
