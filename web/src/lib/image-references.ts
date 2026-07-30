export const MAX_REFERENCE_IMAGES = 4;
export const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;

const supportedMimeTypes = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const supportedFileNamePattern = /\.(jpe?g|png|webp)$/i;
const supportedFormatLabel = "PNG、JPG、JPEG 或 WEBP";

export type ReferenceImageValidation = {
  accepted: File[];
  errors: string[];
};

type ImageRequest = (input: RequestInfo | URL) => Promise<Response>;

function isSupportedReferenceImage(file: File) {
  const mimeType = file.type.trim().toLowerCase();
  return mimeType ? supportedMimeTypes.has(mimeType) : supportedFileNamePattern.test(file.name);
}

export function validateReferenceImages(
  files: Iterable<File>,
  currentCount = 0,
): ReferenceImageValidation {
  const accepted: File[] = [];
  const errors: string[] = [];
  const availableSlots = Math.max(0, MAX_REFERENCE_IMAGES - Math.max(0, currentCount));
  let ignoredForCount = 0;

  for (const file of files) {
    if (!isSupportedReferenceImage(file)) {
      errors.push(`${file.name || "该文件"} 不是支持的图片格式，请上传 ${supportedFormatLabel}。`);
      continue;
    }
    if (file.size === 0) {
      errors.push(`${file.name || "该图片"} 是空文件，请重新选择。`);
      continue;
    }
    if (file.size > MAX_REFERENCE_IMAGE_BYTES) {
      errors.push(`${file.name || "该图片"} 超过 50 MB，请压缩后重试。`);
      continue;
    }
    if (accepted.length >= availableSlots) {
      ignoredForCount += 1;
      continue;
    }
    accepted.push(file);
  }

  if (ignoredForCount > 0) {
    errors.push(`最多添加 ${MAX_REFERENCE_IMAGES} 张参考图，已忽略其余 ${ignoredForCount} 张。`);
  }

  return { accepted, errors };
}

export async function imageSourceToReferenceFile(
  source: string,
  fileName: string,
  request: ImageRequest = fetch,
) {
  const response = await request(source);
  if (!response.ok) {
    throw new Error(`读取作品图片失败（${response.status}）`);
  }

  const blob = await response.blob();
  if (blob.type && !blob.type.toLowerCase().startsWith("image/")) {
    throw new Error("作品地址返回的不是图片，无法用于二创。");
  }
  if (blob.size === 0) {
    throw new Error("作品图片为空，无法用于二创。");
  }

  return new File([blob], fileName, { type: blob.type || "image/png" });
}
