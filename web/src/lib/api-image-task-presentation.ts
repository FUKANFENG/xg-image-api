export const API_IMAGE_TASK_STATUS = {
  queued: { label: "等待中", tone: "amber" },
  paused: { label: "已暂停", tone: "stone" },
  running: { label: "生成中", tone: "sky" },
  success: { label: "已完成", tone: "emerald" },
  error: { label: "失败", tone: "rose" },
} as const;

export function formatImageTaskBytes(value?: number) {
  if (!value || value < 1) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatImageTaskDuration(
  durationMs?: number,
  elapsedSecs?: number,
) {
  const seconds =
    typeof durationMs === "number" && durationMs > 0
      ? durationMs / 1000
      : elapsedSecs || 0;
  if (!seconds) return "-";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes} 分 ${remainder} 秒`;
}

export function shortImageTaskId(value: string) {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
