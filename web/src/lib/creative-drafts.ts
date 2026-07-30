export type StudioPromptDraft = {
  prompt: string;
  source: "reverse-prompt" | "project" | "toolbox" | "board" | "intelligence";
  assetId?: string;
  versionId?: string;
  branchId?: string;
  referenceUrl?: string;
  referenceUrls?: string[];
  createdAt: number;
};

const STUDIO_PROMPT_DRAFT_KEY = "xg:studio-prompt-draft";

export function saveStudioPromptDraft(
  draft: Omit<StudioPromptDraft, "createdAt">,
) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(
    STUDIO_PROMPT_DRAFT_KEY,
    JSON.stringify({ ...draft, createdAt: Date.now() }),
  );
}

export function consumeStudioPromptDraft(): StudioPromptDraft | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(STUDIO_PROMPT_DRAFT_KEY);
  window.sessionStorage.removeItem(STUDIO_PROMPT_DRAFT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StudioPromptDraft>;
    if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) return null;
    if (
      parsed.source !== "reverse-prompt" &&
      parsed.source !== "project" &&
      parsed.source !== "toolbox" &&
      parsed.source !== "board" &&
      parsed.source !== "intelligence"
    )
      return null;
    return {
      prompt: parsed.prompt.trim(),
      source: parsed.source,
      assetId: typeof parsed.assetId === "string" ? parsed.assetId : undefined,
      versionId:
        typeof parsed.versionId === "string" ? parsed.versionId : undefined,
      branchId:
        typeof parsed.branchId === "string" ? parsed.branchId : undefined,
      referenceUrl:
        typeof parsed.referenceUrl === "string"
          ? parsed.referenceUrl
          : undefined,
      referenceUrls: Array.isArray(parsed.referenceUrls)
        ? parsed.referenceUrls
            .filter((item): item is string => typeof item === "string")
            .slice(0, 4)
        : undefined,
      createdAt:
        typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}
