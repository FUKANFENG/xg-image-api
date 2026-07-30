import type { ImageTask } from "@/lib/api";

export type RestoreMode =
  "general" | "portrait" | "old_photo" | "product" | "text" | "denoise";

export type RestoreStrength = "natural" | "standard" | "strong";

export const RESTORE_PROMPT_PREFIX = "[XG_HD_RESTORE";

export const RESTORE_MODES: Array<{
  value: RestoreMode;
  label: string;
  description: string;
  instruction: string;
}> = [
  {
    value: "general",
    label: "通用高清",
    description: "日常图片均衡增强",
    instruction: "均衡修复清晰度、纹理、曝光和色彩，保持自然观感。",
  },
  {
    value: "portrait",
    label: "人像修复",
    description: "保护五官与肤质",
    instruction:
      "重点恢复眼睛、发丝、服装等人像细节，严格保持人物身份与真实肤质，避免磨皮和改脸。",
  },
  {
    value: "old_photo",
    label: "老照片修复",
    description: "修补划痕与褪色",
    instruction:
      "重点清理老照片的划痕、折痕、霉点、褪色和局部缺损，尊重原始年代质感，不添加不存在的内容。",
  },
  {
    value: "product",
    label: "商品增强",
    description: "突出材质与轮廓",
    instruction:
      "重点恢复商品轮廓、材质、包装和标签细节，保持颜色、比例、文字与品牌元素准确。",
  },
  {
    value: "text",
    label: "文字截图",
    description: "提升文字与界面清晰度",
    instruction:
      "重点恢复截图、文档和界面中的文字边缘与图形线条，保持所有文字内容、排版和位置完全一致。",
  },
  {
    value: "denoise",
    label: "去噪去模糊",
    description: "清理噪点与拖影",
    instruction:
      "重点去除高 ISO 噪点、压缩色块、轻微运动模糊和重影，恢复真实边缘，避免产生光晕。",
  },
];

export const RESTORE_STRENGTHS: Array<{
  value: RestoreStrength;
  label: string;
  description: string;
  instruction: string;
}> = [
  {
    value: "natural",
    label: "自然",
    description: "轻度修复",
    instruction: "采用轻度增强，优先保持原始颗粒、质感和细节，不做明显重建。",
  },
  {
    value: "standard",
    label: "标准",
    description: "均衡修复",
    instruction: "采用均衡增强，在清晰度提升与原图一致性之间取得平衡。",
  },
  {
    value: "strong",
    label: "强力",
    description: "深度修复",
    instruction:
      "采用较强的去噪、去模糊与细节恢复，但仍严格禁止改脸、改字或改变构图。",
  },
];

const BASE_RESTORE_PROMPT =
  "对上传图片进行高清修复和智能放大。严格保持原始人物身份、面部特征、表情、姿态、服装、构图、文字内容与位置、主体数量和色彩关系，不增加或删除任何主体。去除模糊、压缩噪点、锯齿、色块和轻微瑕疵，恢复自然纹理、清晰边缘与真实细节，避免过度锐化、塑料皮肤和风格化重绘，输出干净、自然、真实的高质量图像。";

export function buildRestorePrompt(
  mode: RestoreMode,
  strength: RestoreStrength,
) {
  const modeOption =
    RESTORE_MODES.find((item) => item.value === mode) || RESTORE_MODES[0];
  const strengthOption =
    RESTORE_STRENGTHS.find((item) => item.value === strength) ||
    RESTORE_STRENGTHS[1];
  return `${RESTORE_PROMPT_PREFIX} mode=${modeOption.value} strength=${strengthOption.value}] ${BASE_RESTORE_PROMPT} ${modeOption.instruction} ${strengthOption.instruction}`;
}

export function parseRestorePrompt(prompt?: string) {
  const source = String(prompt || "");
  const metadata = source.match(
    /^\[XG_HD_RESTORE\s+mode=([a-z_]+)\s+strength=([a-z_]+)\]/,
  );
  const mode = RESTORE_MODES.some((item) => item.value === metadata?.[1])
    ? (metadata?.[1] as RestoreMode)
    : "general";
  const strength = RESTORE_STRENGTHS.some(
    (item) => item.value === metadata?.[2],
  )
    ? (metadata?.[2] as RestoreStrength)
    : "standard";

  return {
    mode,
    strength,
    modeLabel:
      RESTORE_MODES.find((item) => item.value === mode)?.label || "通用高清",
    strengthLabel:
      RESTORE_STRENGTHS.find((item) => item.value === strength)?.label ||
      "标准",
  };
}

export function isRestoreTask(task: ImageTask) {
  const prompt = String(task.prompt || "");
  return (
    task.mode === "edit" &&
    (prompt.startsWith(RESTORE_PROMPT_PREFIX) ||
      prompt.includes("对上传图片进行高清修复"))
  );
}
