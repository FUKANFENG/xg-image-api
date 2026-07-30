export type ImageTaskRecoveryAction =
  | "retry"
  | "continue_wait"
  | "edit_prompt"
  | "none";

export type ImageTaskErrorPresentation = {
  title: string;
  detail: string;
  action: ImageTaskRecoveryAction;
};

const PROGRESS_STAGES = ["排队", "检查账号", "准备请求", "生成画面", "接收结果"] as const;

const PROGRESS_STAGE_INDEX: Record<string, number> = {
  queued: 0,
  getting_account: 1,
  uploading: 2,
  bootstrapping: 2,
  getting_token: 2,
  preparing_conversation: 2,
  starting_generation: 3,
  generating: 3,
  image_stream_resolve_start: 3,
  receiving_image: 4,
};

export function getImageTaskProgressPresentation(progress?: string) {
  const normalized = String(progress || "queued").trim();
  const activeIndex = PROGRESS_STAGE_INDEX[normalized] ?? 0;
  return {
    activeIndex,
    label: PROGRESS_STAGES[activeIndex],
    stages: PROGRESS_STAGES,
  };
}

const ERROR_PRESENTATIONS: Record<string, ImageTaskErrorPresentation> = {
  cancelled_by_user: {
    title: "任务已停止",
    detail: "本次生成已安全停止，额度已退回，可以随时重新生成。",
    action: "retry",
  },
  service_restarted: {
    title: "服务重启中断",
    detail: "后台重启时任务被中断，额度已退回，请重新生成。",
    action: "retry",
  },
  content_policy_violation: {
    title: "提示词需要调整",
    detail: "上游安全策略拒绝了当前描述，请修改敏感内容后重新提交。",
    action: "edit_prompt",
  },
  account_pool_exhausted: {
    title: "暂无可用生图账号",
    detail: "账号可能额度触顶或处于冷却中，系统会在恢复后重新调度。",
    action: "retry",
  },
  account_precheck_failed: {
    title: "账号连接检查失败",
    detail: "系统已尝试自动切换账号；请稍后重试，管理员可在监控页检查账号状态。",
    action: "retry",
  },
  no_image_result: {
    title: "上游未返回图片",
    detail: "请求已经完成但没有有效图片，重新生成会自动更换账号。",
    action: "retry",
  },
  no_image_generated: {
    title: "上游未生成图片",
    detail: "上游没有触发图片工具，重新生成会自动更换账号。",
    action: "retry",
  },
  upstream_text_reply: {
    title: "上游返回了文字",
    detail: "模型没有生成图片，系统重试后仍未成功，请重新提交。",
    action: "retry",
  },
  image_timeout: {
    title: "生成时间较长",
    detail: "远程任务可能仍在处理，可以继续等待，避免重复生成。",
    action: "continue_wait",
  },
  upstream_connection_error: {
    title: "上游连接中断",
    detail: "网络连接暂时不稳定，稍后重试会重新选择可用账号。",
    action: "retry",
  },
  tokenization_error: {
    title: "本地依赖加载失败",
    detail: "文本编码资源暂时不可用，请检查网络后重试。",
    action: "retry",
  },
};

function safeFallbackDetail(error?: string) {
  const text = String(error || "").trim();
  if (!text) return "本次任务未完成，请稍后重试。";
  const lower = text.toLowerCase();
  if (["backend-api/", "status=", "body=", "chatgpt.com"].some((part) => lower.includes(part))) {
    return "上游服务暂时未完成请求，请稍后重试。";
  }
  return text;
}

export function getImageTaskErrorPresentation(
  errorCode?: string,
  error?: string,
): ImageTaskErrorPresentation {
  const normalized = String(errorCode || "").trim();
  return ERROR_PRESENTATIONS[normalized] || {
    title: "图片生成未完成",
    detail: safeFallbackDetail(error),
    action: "retry",
  };
}
