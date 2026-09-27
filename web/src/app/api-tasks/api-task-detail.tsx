"use client";

import { Check, Copy, ExternalLink, ImageIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RuntimeImage } from "@/components/runtime-image";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  formatImageTaskBytes,
  formatImageTaskDuration,
} from "@/lib/api-image-task-presentation";
import type { ImageTask } from "@/lib/api";

type ApiTaskDetailProps = {
  task: ImageTask | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function readableTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value.replace(" ", "T"));
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}

function storageLabel(value?: string) {
  return (
    {
      local: "本地存储",
      both: "本地 + 远端",
      webdav: "远端备份",
      missing: "历史记录",
    }[value || ""] || "图片结果"
  );
}

export function ApiTaskDetail({
  task,
  open,
  onOpenChange,
}: ApiTaskDetailProps) {
  const [copied, setCopied] = useState("");
  const referenceImages = task?.reference_images || [];

  const copy = async (label: string, value?: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1500);
      toast.success(`${label}已复制`);
    } catch {
      toast.error("复制失败，请手动选择内容");
    }
  };

  const details = task
    ? [
        ["任务 ID", task.id],
        ["任务来源", task.source === "api" ? "同步 API" : "异步队列"],
        ["接口", task.endpoint || "-"],
        ["调用方", task.caller_key_name || task.owner_id || "-"],
        ["模式", task.mode === "edit" ? "以图生图 / 编辑" : "文生图"],
        ["模型", task.model || "-"],
        ["请求尺寸", task.size || "自动"],
        ["质量", task.quality || "auto"],
        ["请求张数", task.request_n ? String(task.request_n) : "-"],
        [
          "子任务进度",
          task.child_total
            ? `${task.completed_children || 0}/${task.child_total} 完成${
                task.failed_children ? `，${task.failed_children} 失败` : ""
              }`
            : "-",
        ],
        ["返回格式", task.response_format || "-"],
        ["创建时间", readableTime(task.created_at)],
        ["更新时间", readableTime(task.updated_at)],
        [
          "耗时",
          formatImageTaskDuration(task.duration_ms, task.elapsed_secs),
        ],
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem-env(safe-area-inset-bottom))] w-auto flex-col gap-0 overflow-hidden rounded-2xl border-stone-200 bg-white p-0 sm:max-h-[90vh] sm:w-[min(94vw,940px)] sm:rounded-3xl dark:border-white/10 dark:bg-stone-900">
        <DialogHeader className="shrink-0 border-b border-stone-100 px-4 py-4 pr-12 sm:px-7 sm:py-5 dark:border-white/10">
          <DialogTitle>生图任务详情</DialogTitle>
          <DialogDescription>
            查看参考图、请求信息、运行结果及输出图片元数据。
          </DialogDescription>
        </DialogHeader>
        {task ? (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:space-y-6 sm:px-7 sm:py-6">
            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="text-sm font-bold text-stone-900 dark:text-white">
                  提示词
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-lg text-stone-500"
                  onClick={() => void copy("提示词", task.prompt)}
                >
                  {copied === "提示词" ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  复制
                </Button>
              </div>
              <p className="rounded-2xl bg-stone-50 p-4 text-sm leading-7 whitespace-pre-wrap text-stone-700 dark:bg-white/5 dark:text-stone-200">
                {task.prompt || "未记录提示词"}
              </p>
            </section>

            {task.error ? (
              <section className="rounded-2xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-500/20 dark:bg-rose-500/10">
                <h2 className="text-sm font-bold text-rose-800 dark:text-rose-200">
                  失败信息
                </h2>
                <p className="mt-2 text-sm leading-6 text-rose-700 dark:text-rose-300">
                  {task.error}
                </p>
                {task.error_code ? (
                  <p className="mt-2 font-mono text-xs text-rose-500">
                    {task.error_code}
                  </p>
                ) : null}
              </section>
            ) : null}

            {referenceImages.length ? (
              <section>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-stone-900 dark:text-white">
                      参考图
                    </h2>
                    <p className="mt-1 text-xs text-stone-400">
                      本次图片编辑实际使用的输入素材
                    </p>
                  </div>
                  <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">
                    {referenceImages.length} 张
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
                  {referenceImages.map((image, index) => (
                    <article
                      key={`${image.path}-${index}`}
                      className="overflow-hidden rounded-2xl border border-violet-100 bg-violet-50/40 dark:border-violet-400/15 dark:bg-violet-400/5"
                    >
                      <a
                        href={image.url}
                        target="_blank"
                        rel="noreferrer"
                        className="group relative block aspect-square overflow-hidden bg-stone-100"
                        aria-label={`放大查看第 ${index + 1} 张参考图`}
                      >
                        <RuntimeImage
                          src={image.url}
                          alt={`参考图 ${index + 1}：${image.name}`}
                          className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                        />
                        <span className="absolute right-2 bottom-2 grid size-8 place-items-center rounded-full bg-black/65 text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                          <ExternalLink className="size-3.5" />
                        </span>
                      </a>
                      <div className="p-2.5">
                        <p className="truncate text-xs font-semibold text-stone-700 dark:text-stone-200" title={image.name}>
                          {image.name}
                        </p>
                        <p className="mt-1 text-[11px] text-stone-400">
                          {image.kind === "profile" ? "一致性档案参考" : "用户上传参考"}
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-bold text-stone-900 dark:text-white">
                  输出图片
                </h2>
                <span className="text-xs text-stone-400">
                  {task.data?.length || 0} 张
                </span>
              </div>
              {task.data?.length ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {task.data.map((image, index) => (
                    <article
                      key={`${image.url || image.path || index}-${index}`}
                      className="overflow-hidden rounded-2xl border border-stone-200 bg-stone-50 dark:border-white/10 dark:bg-white/5"
                    >
                      {image.url && image.storage !== "missing" ? (
                        <a
                          href={image.url}
                          target="_blank"
                          rel="noreferrer"
                          className="group relative block aspect-square overflow-hidden bg-stone-100"
                          aria-label={`在新窗口打开第 ${index + 1} 张图片`}
                        >
                          <RuntimeImage
                            src={image.url}
                            alt={`任务输出 ${index + 1}`}
                            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
                          />
                          <span className="absolute right-2 bottom-2 grid size-8 place-items-center rounded-full bg-black/65 text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                            <ExternalLink className="size-3.5" />
                          </span>
                        </a>
                      ) : (
                        <div className="grid aspect-square place-items-center bg-stone-100 text-stone-400 dark:bg-white/5">
                          <ImageIcon className="size-8" />
                        </div>
                      )}
                      <div className="space-y-1.5 p-3 text-xs text-stone-500">
                        <div className="flex items-center justify-between gap-3">
                          <span>
                            {image.width && image.height
                              ? `${image.width} × ${image.height}`
                              : "尺寸待获取"}
                          </span>
                          <span>{formatImageTaskBytes(image.size_bytes)}</span>
                        </div>
                        <p className="truncate" title={image.storage || image.path}>
                          {storageLabel(image.storage)}
                          {image.path ? ` · ${image.path}` : ""}
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="grid min-h-36 place-items-center rounded-2xl border border-dashed border-stone-200 text-center dark:border-white/10">
                  <div>
                    <ImageIcon className="mx-auto size-7 text-stone-300" />
                    <p className="mt-2 text-sm text-stone-500">
                      {task.status === "success"
                        ? "本次调用未保留可展示的图片地址"
                        : "任务完成后将在这里显示结果"}
                    </p>
                  </div>
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-3 text-sm font-bold text-stone-900 dark:text-white">
                请求信息
              </h2>
              <dl className="grid overflow-hidden rounded-2xl border border-stone-200 sm:grid-cols-2 dark:border-white/10">
                {details.map(([label, value]) => (
                  <div
                    key={label}
                    className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 border-b border-stone-100 px-4 py-3 text-sm last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 dark:border-white/10"
                  >
                    <dt className="text-stone-400">{label}</dt>
                    <dd className="min-w-0 break-all text-stone-700 dark:text-stone-200">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <Button
                type="button"
                variant="outline"
                className="mt-3 h-10 rounded-xl"
                onClick={() => void copy("任务 ID", task.id)}
              >
                {copied === "任务 ID" ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
                复制任务 ID
              </Button>
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
