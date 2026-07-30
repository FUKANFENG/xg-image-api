"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  Crop,
  Play,
  RefreshCw,
  Route,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  analyzeLocalEditSuggestions,
  cancelGenerationSchedule,
  createGenerationSchedule,
  fetchGenerationSchedules,
  fetchPromptTemplates,
  fetchUsabilityMetrics,
  renderPromptTemplate,
  routeImageModel,
  savePromptTemplate,
  type LocalEditSuggestion,
  type ModelRouteResult,
  type PromptTemplate,
  type ScheduledGeneration,
  type UsabilityMetrics,
} from "@/lib/api";

import {
  EmptyState,
  MetricCard,
  SectionHeading,
  StatusPill,
  Surface,
} from "./operations-ui";

function defaultRunAt() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function parseVariables(value: string) {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("变量必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

export function EfficiencyPanel() {
  const [metrics, setMetrics] = useState<UsabilityMetrics | null>(null);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [schedules, setSchedules] = useState<ScheduledGeneration[]>([]);
  const [prompt, setPrompt] = useState(
    "电商商品主图，纯净背景，突出材质和卖点",
  );
  const [route, setRoute] = useState<ModelRouteResult | null>(null);
  const [templateName, setTemplateName] = useState("商品场景批量模板");
  const [template, setTemplate] = useState(
    "{{商品}}置于{{场景}}中，{{光线}}，商业摄影，高级质感",
  );
  const [variablesText, setVariablesText] = useState(
    '{\n  "商品": ["香水", "咖啡杯"],\n  "场景": ["极简展台", "自然石材桌面"],\n  "光线": ["柔和侧光"]\n}',
  );
  const [renderedPrompts, setRenderedPrompts] = useState<string[]>([]);
  const [runAt, setRunAt] = useState(defaultRunAt);
  const [lowPeakOnly, setLowPeakOnly] = useState(true);
  const [editFile, setEditFile] = useState<File | null>(null);
  const [editPreview, setEditPreview] = useState("");
  const [editInstruction, setEditInstruction] = useState(
    "识别需要优化的人物、商品、文字和背景区域",
  );
  const [suggestion, setSuggestion] = useState<LocalEditSuggestion | null>(
    null,
  );
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const [metricResult, templateResult, scheduleResult] = await Promise.all([
        fetchUsabilityMetrics(),
        fetchPromptTemplates(),
        fetchGenerationSchedules(),
      ]);
      setMetrics(metricResult.data);
      setTemplates(templateResult.data);
      setSchedules(scheduleResult.data);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "创作效率数据加载失败",
      );
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    return () => {
      if (editPreview) URL.revokeObjectURL(editPreview);
    };
  }, [editPreview]);

  const activeSchedules = useMemo(
    () =>
      schedules.filter(
        (item) => !["completed", "cancelled"].includes(item.status),
      ).length,
    [schedules],
  );

  const runRoute = async () => {
    setBusy("route");
    try {
      const result = await routeImageModel({ mode: "generate", prompt });
      setRoute(result.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模型路由失败");
    } finally {
      setBusy("");
    }
  };

  const renderTemplate = async () => {
    setBusy("render");
    try {
      const result = await renderPromptTemplate({
        template,
        variables: parseVariables(variablesText),
      });
      setRenderedPrompts(result.data.items);
      toast.success(`已展开 ${result.data.total} 条提示词`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模板展开失败");
    } finally {
      setBusy("");
    }
  };

  const saveTemplate = async () => {
    setBusy("save-template");
    try {
      await savePromptTemplate({
        name: templateName,
        template,
        variables: parseVariables(variablesText),
      });
      await load();
      toast.success("模板已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模板保存失败");
    } finally {
      setBusy("");
    }
  };

  const createSchedule = async () => {
    if (!runAt) {
      toast.error("请选择执行时间");
      return;
    }
    setBusy("schedule");
    try {
      await createGenerationSchedule({
        prompts: renderedPrompts.length ? renderedPrompts : [prompt],
        model: "auto",
        size: "1024x1024",
        quality: "high",
        run_at: new Date(runAt).toISOString(),
        low_peak_only: lowPeakOnly,
        window_start: 0,
        window_end: 7,
      });
      await load();
      toast.success("定时生成任务已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "定时任务创建失败");
    } finally {
      setBusy("");
    }
  };

  const analyzeEdit = async () => {
    if (!editFile) {
      toast.error("请先选择图片");
      return;
    }
    setBusy("edit");
    try {
      const result = await analyzeLocalEditSuggestions(
        editFile,
        editInstruction,
      );
      setSuggestion(result.data);
      toast.success(`识别到 ${result.data.regions.length} 个可编辑区域`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "局部修改分析失败");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="历史作品"
          value={metrics?.asset_count ?? "—"}
          hint="纳入可用率统计"
        />
        <MetricCard
          label="已质检"
          value={metrics?.reviewed ?? "—"}
          hint="综合、文字、人物与构图"
        />
        <MetricCard
          label="可交付率"
          value={`${metrics?.usable_rate ?? 0}%`}
          hint="综合评分达到 70 分"
        />
        <MetricCard
          label="每张可用图成本"
          value={metrics?.credits_per_usable ?? "—"}
          hint="按成功核销额度计算"
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Surface>
          <SectionHeading
            eyebrow="P1 · MODEL ROUTING"
            title="智能模型路由"
            description="用户明确选择始终优先；选择自动时，根据任务类型和约束给出模型与原因。"
            action={
              <Route className="size-5 text-violet-600" aria-hidden="true" />
            }
          />
          <div className="space-y-4 p-5">
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              className="min-h-28 rounded-xl"
              aria-label="待分析提示词"
            />
            <Button
              type="button"
              className="min-h-11 w-full gap-2 rounded-xl bg-stone-950 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-950"
              disabled={busy === "route"}
              onClick={() => void runRoute()}
            >
              <Sparkles className="size-4" />
              分析并推荐模型
            </Button>
            {route ? (
              <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-400/20 dark:bg-violet-400/[0.08]">
                <div className="flex items-center justify-between gap-3">
                  <strong className="text-stone-950 dark:text-white">
                    {route.model}
                  </strong>
                  <span className="text-xs font-medium text-violet-700 dark:text-violet-300">
                    置信度 {Math.round(route.confidence * 100)}%
                  </span>
                </div>
                <ul className="mt-2 space-y-1 text-sm leading-6 text-stone-600 dark:text-stone-300">
                  {route.reasons.map((reason) => (
                    <li key={reason}>• {reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Surface>

        <Surface>
          <SectionHeading
            eyebrow="P1 · QUALITY ECONOMICS"
            title="可用率与真实成本"
            description="AI 质检结果与额度核销流水合并计算，不再只看生成成功率。"
            action={
              <Button
                type="button"
                variant="outline"
                className="min-h-11 gap-2 rounded-xl"
                onClick={() => void load()}
              >
                <RefreshCw className="size-4" />
                刷新
              </Button>
            }
          />
          <div className="space-y-3 p-5">
            {metrics?.top_issues.length ? (
              metrics.top_issues.map((issue) => (
                <div
                  key={issue.label}
                  className="flex items-center justify-between rounded-xl bg-stone-50 px-4 py-3 dark:bg-white/[0.05]"
                >
                  <span className="text-sm text-stone-700 dark:text-stone-300">
                    {issue.label}
                  </span>
                  <strong className="text-stone-950 dark:text-white">
                    {issue.count}
                  </strong>
                </div>
              ))
            ) : (
              <EmptyState>完成作品质检后，这里会显示主要质量问题。</EmptyState>
            )}
          </div>
        </Surface>
      </div>

      <Surface>
        <SectionHeading
          eyebrow="P1 · PROMPT MATRIX"
          title="提示词变量批量生成"
          description="使用 {{变量}} 创建组合，最多展开 50 条；可以保存模板或安排低峰生成。"
          action={
            <CalendarClock
              className="size-5 text-violet-600"
              aria-hidden="true"
            />
          }
        />
        <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <div className="space-y-3">
            <Input
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
              aria-label="模板名称"
              className="min-h-11 rounded-xl"
            />
            <Textarea
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              aria-label="提示词模板"
              className="min-h-28 rounded-xl font-medium"
            />
            <Textarea
              value={variablesText}
              onChange={(event) => setVariablesText(event.target.value)}
              aria-label="变量 JSON"
              className="min-h-40 rounded-xl font-mono text-xs"
            />
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 flex-1 rounded-xl"
                disabled={busy === "render"}
                onClick={() => void renderTemplate()}
              >
                展开预览
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 flex-1 rounded-xl"
                disabled={busy === "save-template"}
                onClick={() => void saveTemplate()}
              >
                保存模板
              </Button>
            </div>
          </div>
          <div className="space-y-4">
            <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {renderedPrompts.length ? (
                renderedPrompts.map((item, index) => (
                  <div
                    key={`${item}-${index}`}
                    className="rounded-xl border border-stone-200 px-3 py-2 text-sm leading-6 dark:border-white/10"
                  >
                    <span className="mr-2 text-xs font-semibold text-violet-600">
                      #{index + 1}
                    </span>
                    {item}
                  </div>
                ))
              ) : (
                <EmptyState>展开模板后在这里检查所有提示词。</EmptyState>
              )}
            </div>
            <div className="space-y-2 rounded-xl border border-stone-200 p-4 dark:border-white/10">
              <label
                htmlFor="schedule-run-at"
                className="text-sm font-medium text-stone-800 dark:text-stone-200"
              >
                执行时间
              </label>
              <Input
                id="schedule-run-at"
                type="datetime-local"
                value={runAt}
                onChange={(event) => setRunAt(event.target.value)}
                className="min-h-11 rounded-xl"
              />
              <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl bg-stone-50 px-3 text-sm dark:bg-white/[0.05]">
                <input
                  type="checkbox"
                  checked={lowPeakOnly}
                  onChange={(event) => setLowPeakOnly(event.target.checked)}
                  className="size-4 accent-violet-600"
                />
                仅在 00:00–07:00 低峰窗口执行
              </label>
              <Button
                type="button"
                className="min-h-11 w-full gap-2 rounded-xl bg-violet-700 text-white hover:bg-violet-600"
                disabled={busy === "schedule"}
                onClick={() => void createSchedule()}
              >
                <Clock3 className="size-4" />
                创建定时任务
              </Button>
            </div>
          </div>
        </div>
        <div className="border-t border-stone-200/80 px-5 py-4 dark:border-white/10">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-semibold text-stone-950 dark:text-white">
              定时任务 · 进行中 {activeSchedules}
            </h3>
            <span className="text-xs text-stone-500">
              已保存模板 {templates.length}
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {schedules.length ? (
              schedules.slice(0, 9).map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-stone-200 p-3 dark:border-white/10"
                >
                  <div className="flex items-center justify-between gap-2">
                    <StatusPill value={item.status} />
                    <span className="text-xs text-stone-400">
                      {item.prompts.length} 条
                    </span>
                  </div>
                  <p className="mt-2 truncate text-sm font-medium">
                    {item.prompts[0]}
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    {new Date(item.run_at).toLocaleString()}
                  </p>
                  {!["completed", "cancelled"].includes(item.status) ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="mt-2 min-h-9 w-full gap-2 text-rose-600"
                      onClick={async () => {
                        await cancelGenerationSchedule(item.id);
                        await load();
                      }}
                    >
                      <Trash2 className="size-4" />
                      取消
                    </Button>
                  ) : null}
                </div>
              ))
            ) : (
              <EmptyState>还没有定时生成任务。</EmptyState>
            )}
          </div>
        </div>
      </Surface>

      <Surface>
        <SectionHeading
          eyebrow="P1 · LOCAL EDIT COPILOT"
          title="AI 局部修改助手"
          description="识别人、商品、文字、Logo 与背景区域，返回可直接用于画布蒙版的归一化坐标。"
          action={
            <Crop className="size-5 text-violet-600" aria-hidden="true" />
          }
        />
        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-3">
            <Input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="min-h-11 rounded-xl"
              aria-label="上传待分析图片"
              onChange={(event) => {
                const file = event.target.files?.[0] || null;
                setEditFile(file);
                setSuggestion(null);
                setEditPreview((current) => {
                  if (current) URL.revokeObjectURL(current);
                  return file ? URL.createObjectURL(file) : "";
                });
              }}
            />
            <Textarea
              value={editInstruction}
              onChange={(event) => setEditInstruction(event.target.value)}
              className="min-h-24 rounded-xl"
              aria-label="局部修改分析要求"
            />
            <Button
              type="button"
              className="min-h-11 w-full gap-2 rounded-xl bg-stone-950 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-950"
              disabled={busy === "edit"}
              onClick={() => void analyzeEdit()}
            >
              <Play className="size-4" />
              分析可编辑区域
            </Button>
            {suggestion?.global_suggestion ? (
              <p className="rounded-xl bg-stone-50 p-3 text-sm leading-6 text-stone-600 dark:bg-white/[0.05] dark:text-stone-300">
                {suggestion.global_suggestion}
              </p>
            ) : null}
          </div>
          <div className="relative min-h-80 overflow-hidden rounded-xl border border-stone-200 bg-stone-100 dark:border-white/10 dark:bg-white/[0.04]">
            {editPreview ? (
              <>
                <Image
                  src={editPreview}
                  alt="局部修改分析预览"
                  fill
                  unoptimized
                  className="object-contain"
                />
                <div className="absolute inset-0">
                  {suggestion?.regions.map((region) => (
                    <button
                      key={region.id}
                      type="button"
                      title={`${region.label}：${region.suggestion}`}
                      className="absolute border-2 border-violet-500 bg-violet-500/10 text-left outline-none focus-visible:ring-2 focus-visible:ring-white"
                      style={{
                        left: `${region.x * 100}%`,
                        top: `${region.y * 100}%`,
                        width: `${region.width * 100}%`,
                        height: `${region.height * 100}%`,
                      }}
                    >
                      <span className="absolute -top-7 left-0 whitespace-nowrap rounded-md bg-stone-950 px-2 py-1 text-[11px] font-medium text-white">
                        {region.label}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState>上传图片后预览识别区域。</EmptyState>
            )}
          </div>
        </div>
        {suggestion?.regions.length ? (
          <div className="grid gap-2 border-t border-stone-200/80 p-5 md:grid-cols-2 xl:grid-cols-3 dark:border-white/10">
            {suggestion.regions.map((region) => (
              <div
                key={region.id}
                className="rounded-xl border border-stone-200 p-3 dark:border-white/10"
              >
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-emerald-600" />
                  <strong className="text-sm">{region.label}</strong>
                </div>
                <p className="mt-2 text-xs leading-5 text-stone-500">
                  {region.issue || "未发现明显问题"}
                </p>
                <p className="mt-1 text-sm leading-6 text-stone-700 dark:text-stone-300">
                  {region.suggestion}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </Surface>
    </div>
  );
}
