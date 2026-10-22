# 网页生图链路排查与单图验证（2026-10-15 至 2026-10-16）

## 结论：单图网页生图已通过

本地服务、公网入口和网页生图上游均已通过一次真实单图验收。
2026-10-15 部署模型目录兼容修正后，诊断任务仍返回 HTTP 404；2026-10-16 未再修改生成代码，新单图任务成功生成并通过下载校验。两次结果不能证明失败由旧任务状态或服务加载延迟导致，恢复的直接原因仍未确认。
没有改走 Codex 生图，也没有进行批量重试。

## 已确认的证据

- 本地 Docker 容器 `chatgpt2api` 为 healthy，监听 `18082`；`/health?format=json` 返回 `status=ok`。
- 公网 `https://picture.museyin.com/developers/` 返回 HTTP 200，正常校验 TLS 证书。
- 普通用户身份通过公网成功提交、查询和重试测试任务，说明公网入口和本地队列之间可达。
- 原网页生图实现将 `gpt-image-2` 固定映射为 `gpt-5-3`，而当前账号返回的模型目录中没有这一型号。
- 第一版将内部路由改为 `auto` 后，真实请求仍返回 404；因此 `auto` 不是可接受的修复结论。
- 只读模型目录返回默认型号 `gpt-6`，并在多个型号的 `enabled_tools` 中声明 `image_gen_tool_enabled`。
- 第二版按账号实时模型目录选择支持生图的默认型号后，10 月 15 日旧诊断任务重试仍返回 404；10 月 16 日新任务通过。尚无证据将前者归因于旧任务状态。
- 不含消息和提示词的协议验证请求在 `/backend-api/f/conversation` 返回 `Model not found`。这是诊断请求的响应，不能等同于已经读取到了真实流式请求的完整错误正文。
- 另一条已有网页对话接口 `/backend-api/conversation` 的验证请求返回 HTTP 403，正文提示检测到异常活动。没有增加绕过风控、切换身份规避封禁或自动切换到 Codex 的处理。
- 当前三个上游账号均标记为 Codex 导入来源。这个字段表示凭据来源，不表示本次调用了 Codex；资料/模型接口可读也不证明网页生成接口权限正常。
- 10 月 15 日实际失败为 404，不是已观测到的 429，也不是用户并发上限或本地排队造成的失败。

10 月 16 日的成功验证说明当时网页链路可用，但单次结果不能保证长期稳定。仍不能据此断言之前是 Token 过期、账号被封或单一接口路径变更。

## 已部署的兼容性及诊断改动

1. `services/openai_backend_api.py`
   - 不再固定绑定已经不在模型目录中的 `gpt-5-3`，也不把 `auto` 当作网页接口必然接受的型号。
   - 读取当前账号模型目录，仅选择声明支持图片工具的 GPT 型号，优先使用有效的默认型号。
   - 每个后端实例缓存选择，保证 prepare 与 submit 使用同一型号。
   - 无支持型号时提前明确报错；认证错误直接传播。
   - 保留原网页接口与 `picture_v2`，Codex 路由不受影响。
2. `services/protocol/conversation.py`
   - 失败日志增加异常类型和上游 HTTP 状态。
   - 网页 404 返回安全、可读的中文提示及 `upstream_not_found`，不再仅显示笼统英文错误。
   - 不为 404 增加自动换号或批量重试。
3. `test/test_web_image_model_routing.py`
   - 新增目录选择、能力过滤、缓存一致性、认证失败传播、Codex 隔离和 404 安全提示测试。
4. `test/test_image_upload_retry.py`
   - 为原有参考图请求测试补充离线模型目录响应，继续验证参考图列表保持完整。

以上是局部兼容性改进；后续单图验证通过，但没有证明所有上游故障已被消除。

## 真实单图测试（最终通过）

- 10 月 15 日测试：同一个单图任务；真实任务 ID 仅保存在本地运行数据中。
- 外部接口：`POST /api/image-tasks/generations`
- 外部模型：`gpt-image-2`
- 数量：单图；未发送多图数量参数。
- 内容：白色陶瓷杯、绿叶、米白背景的正方形产品摄影。
- 验证身份：已有普通用户；使用仅保存在测试进程内的临时会话，没有打印密钥或修改原 API Key。
- 尝试一：内部 `auto`，上游 404，结果 0 张。
- 尝试二：实时模型目录选择；通过 `/api/image-tasks/{id}/retry` 重试同一任务，上游仍 404，结果 0 张。
- 10 月 15 日停止继续提交，结果为 0 张，当日未通过图片验收。
- 10 月 16 日复测：只提交一个新的单图任务，真实任务 ID 仅保存在本地运行数据中。
- 最终任务状态：`success`，返回 1 张图，耗时 `25685 ms`。
- XG 结果下载：带用户身份请求返回 HTTP 200；PNG；实际 `1254 x 1254`（请求期望尺寸为 `1024 x 1024`）；`1648061` 字节。
- 返回地址为 XG 自己的 `/images/...png` 路径，不是上游 ChatGPT 图片地址。这不是旧额度 Portal 的 `/api/share/*` 链路。
- 本次检查了带身份下载，没有据此声称匿名下载权限也已验证。图片和真实路径保留在本地，不随源码发布。
- 收尾时队列：运行 0，等待 0。

## 回归测试

- 相关离线测试：47 项全部通过，包括参考图、超时、调度、用户限额及 Codex 路由隔离。
- 全量离线测试：435 项，413 项通过，17 项跳过，5 项失败（3 failure、2 error）。
- 这 5 项失败来自 `test_image_task_service.py` 中固定为 2026 年 7 月的历史测试时间，被当前 30 天保留策略清理；旧镜像基线也已复现。没有为让测试变绿而修改生产保留规则。
- `git diff --check` 通过（仅有工作区原有 CRLF 转换提示）。

未通过的历史测试：

- `test_task_feed_is_bounded_and_reports_pagination`
- `test_task_feed_hides_legacy_retry_duplicate_and_reuses_the_visible_task`
- `test_resume_poll_rejects_legacy_task_without_account_context_before_reserving_credit`
- `test_resume_thread_start_failure_restores_failed_task_and_reserved_credit`
- `test_resume_poll_rejects_an_empty_download_instead_of_marking_success`

## 部署与回退

已更新本地 `chatgpt2api:local-v1.8.0` 镜像，并在队列空闲时仅重建 Compose 的 `app` 服务。
保留部署前镜像 `chatgpt2api:before-web-image-model-fix-20261015`。

需要回退时，先确认没有运行/等待中的任务，再在项目目录执行：

```powershell
docker tag chatgpt2api:before-web-image-model-fix-20261015 chatgpt2api:local-v1.8.0
docker compose -f docker-compose.yml -f docker-compose.lan.yml up -d --no-build --no-deps app
```

回退只恢复镜像，不删除账号、任务或图片；源码需另行审阅本次差异。
没有修改 VPS、Nginx、Cloudflare、隧道、账号密码、API Key 或并发策略，也没有提交或推送 GitHub。

## 再次失败时的核验建议

由账号持有人在官方 ChatGPT 网页正常登录，确认同一账号能否直接生成一张简单图片。
若网页要求验证或提示异常活动，应按官方流程处理，不能用程序绕过。
若官方网页可生成，再在本地账号页更新该网页会话的有效凭据，继续核验授权与网页协议兼容性。
凭据只能在本地受控入口导入，不要写入聊天、文档或公开仓库。
