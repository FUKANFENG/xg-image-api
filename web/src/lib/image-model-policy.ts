export const USER_DEFAULT_IMAGE_MODEL = "gpt-image-2";

type ModelLike = { id?: unknown };

export function isUserWebImageModel(value: unknown): value is string {
  const model = String(value || "").trim().toLowerCase();
  return Boolean(model) && model.includes("image") && !model.includes("codex");
}

function normalizeUserWebImageModels(values: unknown[]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const value of values) {
    const model = String(value || "").trim();
    const key = model.toLowerCase();
    if (!isUserWebImageModel(model) || seen.has(key)) continue;
    seen.add(key);
    models.push(model);
  }
  return models.sort((left, right) => {
    const leftDefault = left.toLowerCase() === USER_DEFAULT_IMAGE_MODEL;
    const rightDefault = right.toLowerCase() === USER_DEFAULT_IMAGE_MODEL;
    if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
    return left.localeCompare(right);
  });
}

export function getUserWebImageModels(items: ModelLike[]): string[] {
  const models = normalizeUserWebImageModels(items.map((item) => item.id));
  return models.length > 0 ? models : [USER_DEFAULT_IMAGE_MODEL];
}

export function resolveUserWebImageModel(
  candidate: unknown,
  availableModels: unknown[],
): string {
  const models = normalizeUserWebImageModels(availableModels);
  if (models.length === 0) return USER_DEFAULT_IMAGE_MODEL;

  const normalizedCandidate = String(candidate || "").trim().toLowerCase();
  const matched = models.find(
    (model) => model.toLowerCase() === normalizedCandidate,
  );
  return matched || models[0];
}
