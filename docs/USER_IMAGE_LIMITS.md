# 用户生图额度与并发

管理员可通过 `POST /api/auth/users/{user_id}` 更新普通用户的策略：

```json
{
  "image_quota_unlimited": true,
  "image_concurrency_limit": 4
}
```

- `image_quota_unlimited` 默认为 `false`。启用后，不再预扣该用户的本地图片额度；原有限余额保留，旧任务已预扣的额度仍按原规则结算。它不会改变用户的密码、接口密钥或普通用户权限。
- `image_concurrency_limit` 范围为 `0–16`。`0` 表示沿用系统策略；大于零是该用户的硬上限，借用空闲槽位也不能超过。账户下所有 API Key、登录会话、文生图和参考图生图共用该上限，批量请求的每张图片单独占一个槽位。
- 超过并发上限的任务排队；任意任务释放槽位后，立即调度下一张。队列仍有容量限制，队满仍可返回 `429`。
- 用户会话返回 `image_quota_unlimited` 和 `image_concurrency_limit`；不限额用户不返回数值型 `image_quota`。管理员用户列表中的 `image_quota` 仍是保留的有限余额，展示时优先判断不限额标记。
- 不限额任务没有本地额度预扣，故不增加 `image_quota_used`（已消耗计费额度）；任务数、生成结果和运行状态请查看生图任务记录。
- 实际并发还受全局并发、上游账号可用槽位和公平调度影响。**本地不限额不代表上游无限额度，也不免除上游限流、冷却、账号过期等约束。**

回退时将 `image_quota_unlimited` 改为 `false`，并将 `image_concurrency_limit` 改为 `0`。策略变更仅影响后续调度，不会强行终止已经运行的任务。接口需管理员鉴权；普通用户不能修改自己的额度与并发策略。不要把真实密钥写入文档或提交到版本库。

回归测试：`python -m unittest test.test_password_user_accounts test.test_user_accounts_api test.test_user_image_policy test.test_fast_scheduler_v2 test.test_image_task_slot_utilization`。测试使用隔离数据和模拟图片处理器，不消耗真实上游额度。

## 2026-10-15 部署验证

- 上述额度、身份与调度相关测试：37 项通过；混合 6 张任务时，4 张运行、2 张等待，释放一槽即补位，其他用户可使用剩余槽位。
- 前端类型检查、Lint、25 项单元测试与生产构建通过。用户管理页已核验显示“本地额度不限 / 并发上限 4”。
- 本机与 Cloudflare 公网：该普通用户的临时会话验证 `/auth/session`、`/api/image-tasks/estimate`、`/v1/models` 均为 200；管理员账号接口 `/api/accounts` 返回 403。已有 API Key 哈希、密码哈希、角色和有限余额均保持不变。
- 完整隔离后端回归：共 428 项，406 项通过、17 项真实上游测试默认跳过、5 项未通过。未通过项均为 `test_image_task_service.py` 中使用 2026 年 7 月固定日期的历史记录用例，已在修改前镜像复现：记录超过 30 天保留期被清理。未为通过这些旧用例修改生产清理规则。
- 本次没有执行真实上游四图压力测试；验证的是本地并发硬上限、额度策略与公网鉴权。上游当时有效槽位为 4，后续会随账号健康和冷却状态变化。
- 部署前确认运行队列为空，保留镜像 `chatgpt2api:before-user-image-policy-20261015` 以便回退；未修改其他用户、全局并发或公网隧道。
