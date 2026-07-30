"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ArrowUp, Check, Clipboard, Eye, LayoutTemplate, LoaderCircle, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  INSPIRATION_DRAFT_STORAGE_KEY,
  INSPIRATION_PREVIEW_ATLAS_SOURCE,
  inspirationCategories,
  inspirationTemplates,
  type InspirationCategory,
  type InspirationTemplate,
} from "@/lib/inspiration-templates";
import { fetchInspirationLibrary, type InspirationLibraryItem } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

async function copyPrompt(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

const levelClassName: Record<InspirationTemplate["level"], string> = {
  入门: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-200",
  进阶: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-400/25 dark:bg-violet-400/10 dark:text-violet-200",
  创意: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200",
};

function TemplatePreview({ template, className }: { template: InspirationTemplate; className: string }) {
  const crop = template.previewCrop;

  if (!crop) {
    return (
      // Generated project assets are served as static files.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={template.preview} alt={`${template.title} 模板预览`} className={className} loading="lazy" />
    );
  }

  const horizontalPosition = `${(crop.x / Math.max(INSPIRATION_PREVIEW_ATLAS_SOURCE.width - crop.width, 1)) * 100}%`;
  const verticalPosition = `${(crop.y / Math.max(INSPIRATION_PREVIEW_ATLAS_SOURCE.height - crop.height, 1)) * 100}%`;

  return (
    <div
      role="img"
      aria-label={`${template.title} 模板预览`}
      className={className}
      style={{
        backgroundImage: `url(${template.preview})`,
        backgroundPosition: `${horizontalPosition} ${verticalPosition}`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${(INSPIRATION_PREVIEW_ATLAS_SOURCE.width / crop.width) * 100}% ${(INSPIRATION_PREVIEW_ATLAS_SOURCE.height / crop.height) * 100}%`,
      }}
    />
  );
}

function toCuratedTemplate(item: InspirationLibraryItem): InspirationTemplate {
  return {
    id: item.id,
    title: item.title,
    prompt: item.prompt,
    size: item.size,
    quality: item.quality,
    category: item.category,
    categoryLabel: item.category_label,
    level: item.level,
    preview: item.preview,
    description: item.description,
    tags: item.tags,
  };
}

export default function InspirationPage() {
  const { isCheckingAuth, session } = useAuthGuard(["user"]);
  const router = useRouter();
  const [category, setCategory] = useState<InspirationCategory>("all");
  const [selectedTemplate, setSelectedTemplate] = useState<InspirationTemplate | null>(null);
  const [copiedTemplateId, setCopiedTemplateId] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [curatedTemplates, setCuratedTemplates] = useState<InspirationTemplate[]>([]);

  const allTemplates = useMemo(() => [...curatedTemplates, ...inspirationTemplates], [curatedTemplates]);
  const templates = useMemo(
    () => category === "all" ? allTemplates : allTemplates.filter((item) => item.category === category),
    [allTemplates, category],
  );

  useEffect(() => {
    if (!session) {
      return;
    }
    let isCurrent = true;
    void fetchInspirationLibrary()
      .then((result) => {
        if (isCurrent) {
          setCuratedTemplates(result.items.map(toCuratedTemplate));
        }
      })
      .catch(() => {
        if (isCurrent) {
          setAnnouncement("用户精选暂时无法加载，已为你保留内置灵感模板。");
        }
      });
    return () => {
      isCurrent = false;
    };
  }, [session]);

  useEffect(() => {
    let frame = 0;
    const updateVisibility = () => {
      if (frame) {
        return;
      }

      frame = window.requestAnimationFrame(() => {
        const nextVisibility = window.scrollY > 480;
        setShowBackToTop((current) => current === nextVisibility ? current : nextVisibility);
        frame = 0;
      });
    };

    updateVisibility();
    window.addEventListener("scroll", updateVisibility, { passive: true });
    return () => {
      window.removeEventListener("scroll", updateVisibility);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  const handleCopy = async (template: InspirationTemplate) => {
    try {
      await copyPrompt(template.prompt);
      setCopiedTemplateId(template.id);
      setAnnouncement(`已复制「${template.title}」提示词。`);
      toast.success("提示词已复制");
      window.setTimeout(() => setCopiedTemplateId((current) => current === template.id ? "" : current), 1_500);
    } catch {
      const message = "复制失败，请在展开的提示词窗口中手动复制。";
      setAnnouncement(message);
      toast.error(message);
    }
  };

  const handleUse = (template: InspirationTemplate) => {
    window.sessionStorage.setItem(
      INSPIRATION_DRAFT_STORAGE_KEY,
      JSON.stringify({ title: template.title, prompt: template.prompt, size: template.size, quality: template.quality }),
    );
    router.push("/studio");
  };

  const handleBackToTop = () => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
  };

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center" aria-live="polite">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
        <span className="sr-only">正在验证访问权限</span>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl pb-10 sm:pb-14">
      <p className="sr-only" aria-live="polite">{announcement}</p>

      <section className="relative overflow-hidden rounded-3xl border border-stone-200/80 bg-white/90 px-5 py-7 shadow-[0_24px_60px_-44px_rgba(67,56,202,0.36)] dark:border-white/10 dark:bg-stone-900/80 sm:px-8 sm:py-9">
        <div aria-hidden="true" className="pointer-events-none absolute -left-20 top-0 size-64 rounded-full bg-violet-100/75 blur-3xl dark:bg-violet-400/10" />
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 bottom-0 size-56 rounded-full bg-rose-100/65 blur-3xl dark:bg-rose-400/10" />
        <div className="relative max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full bg-violet-50 px-3 py-1.5 text-xs font-semibold tracking-wide text-violet-700 dark:bg-violet-400/10 dark:text-violet-200"><LayoutTemplate className="size-3.5" aria-hidden="true" />XG生图 · 灵感模板库</span>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-stone-950 sm:text-4xl dark:text-white">从一个好提示词开始</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-600 sm:text-base dark:text-stone-300">选择原创模板，查看完整提示词后复制，或一键带入创作台继续调整。所有卡片封面和文案均为 XG 生图原创素材。</p>
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-stone-500 dark:text-stone-400">
            <span className="inline-flex items-center gap-1.5"><Sparkles className="size-4 text-violet-600 dark:text-violet-300" aria-hidden="true" />可直接编辑后生成</span>
            <span>{allTemplates.length} 个精选模板</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="inspiration-templates-heading" className="mt-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span className="text-xs font-semibold tracking-wide text-violet-700 dark:text-violet-200">精选灵感</span>
            <h2 id="inspiration-templates-heading" className="mt-1 text-2xl font-semibold tracking-tight text-stone-950 dark:text-white">按创作方向选择模板</h2>
          </div>
          <span className="text-sm tabular-nums text-stone-500 dark:text-stone-400">{templates.length} 个模板</span>
        </div>

        <div role="tablist" aria-label="提示词模板分类" className="mt-5 flex gap-2 overflow-x-auto pb-1">
          {inspirationCategories.map((item) => {
            const active = category === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategory(item.id)}
                className={cn(
                  "min-h-11 shrink-0 rounded-xl border px-4 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-950",
                  active ? "border-stone-950 bg-stone-950 text-white shadow-sm dark:border-white dark:bg-white dark:text-stone-950" : "border-stone-200 bg-white text-stone-600 hover:border-violet-200 hover:bg-violet-50 hover:text-violet-800 dark:border-white/10 dark:bg-stone-900/60 dark:text-stone-300 dark:hover:border-violet-400/30 dark:hover:bg-violet-400/10 dark:hover:text-violet-100",
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <article key={template.id} className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-stone-200/85 bg-white shadow-[0_16px_38px_-32px_rgba(41,37,36,0.42)] transition-shadow duration-200 hover:shadow-[0_22px_46px_-30px_rgba(109,40,217,0.28)] motion-reduce:transition-none dark:border-white/10 dark:bg-stone-900">
              <button
                type="button"
                onClick={() => setSelectedTemplate(template)}
                className="relative block aspect-[16/10] w-full overflow-hidden bg-stone-100 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 dark:bg-white/10"
                aria-label={`预览「${template.title}」完整提示词`}
              >
                <TemplatePreview template={template} className="size-full object-cover transition duration-300 group-hover:scale-[1.025] motion-reduce:transition-none" />
                <span className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/55 to-transparent" />
                <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur"><Eye className="size-3.5" aria-hidden="true" />查看提示词</span>
              </button>

              <div className="flex flex-1 flex-col p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("rounded-md border px-2 py-1 text-[11px] font-semibold tracking-wide", levelClassName[template.level])}>{template.level}</span>
                  <span className="text-[11px] font-semibold tracking-wide text-stone-400 dark:text-stone-500">{template.categoryLabel}</span>
                </div>
                <h3 className="mt-3 text-lg font-semibold tracking-tight text-stone-950 dark:text-white">{template.title}</h3>
                <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-300">{template.description}</p>
                <button type="button" onClick={() => setSelectedTemplate(template)} className="mt-4 line-clamp-3 rounded-xl border border-stone-200 bg-stone-50/70 px-3 py-2.5 text-left text-xs leading-5 text-stone-600 transition hover:border-violet-200 hover:bg-violet-50/60 dark:border-white/10 dark:bg-white/[0.03] dark:text-stone-300 dark:hover:border-violet-400/25 dark:hover:bg-violet-400/10">
                  {template.prompt}
                </button>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {template.tags.map((tag) => <span key={tag} className="rounded-md bg-stone-100 px-2 py-1 text-[11px] font-medium text-stone-500 dark:bg-white/8 dark:text-stone-300">{tag}</span>)}
                </div>
                <div className="mt-auto grid grid-cols-2 gap-2 pt-4">
                  <Button type="button" variant="outline" className="h-11 rounded-xl border-stone-200 bg-white text-stone-700 hover:border-violet-200 hover:bg-violet-50 hover:text-violet-800 dark:border-white/10 dark:bg-white/[0.03] dark:text-stone-200 dark:hover:border-violet-400/25 dark:hover:bg-violet-400/10" onClick={() => void handleCopy(template)}>
                    {copiedTemplateId === template.id ? <Check className="size-4" aria-hidden="true" /> : <Clipboard className="size-4" aria-hidden="true" />}
                    {copiedTemplateId === template.id ? "已复制" : "复制"}
                  </Button>
                  <Button type="button" className="h-11 rounded-xl bg-violet-700 text-white hover:bg-violet-800 dark:bg-violet-500 dark:hover:bg-violet-400" onClick={() => handleUse(template)}>
                    使用
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <Dialog open={Boolean(selectedTemplate)} onOpenChange={(open) => { if (!open) setSelectedTemplate(null); }}>
        <DialogContent className="max-h-[min(88dvh,760px)] overflow-y-auto rounded-3xl p-5 sm:p-6">
          {selectedTemplate ? (
            <>
              <DialogHeader className="pr-8">
                <div className="flex flex-wrap items-center gap-2"><span className={cn("rounded-md border px-2 py-1 text-[11px] font-semibold tracking-wide", levelClassName[selectedTemplate.level])}>{selectedTemplate.level}</span><span className="text-xs font-semibold tracking-wide text-stone-400">{selectedTemplate.categoryLabel}</span></div>
                <DialogTitle className="mt-2 text-2xl tracking-tight">{selectedTemplate.title}</DialogTitle>
                <DialogDescription className="leading-6">{selectedTemplate.description}</DialogDescription>
              </DialogHeader>
              <div className="overflow-hidden rounded-2xl border border-stone-200 bg-stone-100 dark:border-white/10 dark:bg-white/5">
                <TemplatePreview template={selectedTemplate} className="aspect-[16/9] w-full object-cover" />
              </div>
              <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm leading-7 text-stone-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-200">
                <p className="mb-2 text-xs font-semibold tracking-wide text-stone-400 dark:text-stone-500">可直接复制的提示词</p>
                <p className="whitespace-pre-wrap">{selectedTemplate.prompt}</p>
              </div>
              <DialogFooter className="gap-2 pt-1 sm:justify-between">
                <Button type="button" variant="outline" className="h-11 rounded-xl border-stone-200 bg-white text-stone-700 dark:border-white/10 dark:bg-white/[0.03] dark:text-stone-200" onClick={() => void handleCopy(selectedTemplate)}>
                  {copiedTemplateId === selectedTemplate.id ? <Check className="size-4" aria-hidden="true" /> : <Clipboard className="size-4" aria-hidden="true" />}
                  {copiedTemplateId === selectedTemplate.id ? "已复制提示词" : "复制提示词"}
                </Button>
                <Button type="button" className="h-11 rounded-xl bg-violet-700 text-white hover:bg-violet-800 dark:bg-violet-500 dark:hover:bg-violet-400" onClick={() => handleUse(selectedTemplate)}>
                  带入创作台
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <button
        type="button"
        onClick={handleBackToTop}
        aria-label="回到灵感库顶部"
        aria-hidden={!showBackToTop}
        tabIndex={showBackToTop ? 0 : -1}
        className={cn(
          "fixed bottom-5 right-5 z-40 inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-full border border-violet-200 bg-white/95 px-3 text-sm font-semibold text-violet-700 shadow-[0_14px_32px_-16px_rgba(76,29,149,0.7)] backdrop-blur transition-[opacity,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-[0_18px_36px_-16px_rgba(76,29,149,0.78)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 active:translate-y-0 dark:border-violet-300/25 dark:bg-stone-900/95 dark:text-violet-200 dark:hover:border-violet-300/50 motion-reduce:transform-none motion-reduce:transition-none sm:bottom-7 sm:right-7",
          showBackToTop ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0",
        )}
      >
        <ArrowUp className="size-4" aria-hidden="true" />
        <span>回顶部</span>
      </button>
    </div>
  );
}
