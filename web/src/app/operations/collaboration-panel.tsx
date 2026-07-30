"use client";

import { useState } from "react";
import { Check, MessageSquareText, Scan, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  addReviewAnnotation,
  addReviewComment,
  confirmReviewDelivery,
  fetchAssetProvenance,
  fetchReviewComments,
  type AssetProvenance,
} from "@/lib/api";

import { EmptyState, SectionHeading, Surface } from "./operations-ui";

export function CollaborationPanel() {
  const [reviewId, setReviewId] = useState("");
  const [comment, setComment] = useState("");
  const [comments, setComments] = useState<Array<Record<string, unknown>>>([]);
  const [annotation, setAnnotation] = useState("0.10,0.10,0.30,0.30");
  const [annotationBody, setAnnotationBody] = useState("请调整这个区域的细节");
  const [assetId, setAssetId] = useState("");
  const [provenance, setProvenance] = useState<AssetProvenance[]>([]);
  const [busy, setBusy] = useState("");

  const loadComments = async () => {
    if (!reviewId.trim()) {
      toast.error("请输入审核 ID");
      return;
    }
    setBusy("comments");
    try {
      const result = await fetchReviewComments(reviewId.trim());
      setComments(result.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "评论加载失败");
    } finally {
      setBusy("");
    }
  };

  const submitComment = async () => {
    if (!reviewId.trim() || !comment.trim()) {
      toast.error("请填写审核 ID 和评论");
      return;
    }
    setBusy("comment");
    try {
      await addReviewComment(reviewId.trim(), comment.trim());
      setComment("");
      await loadComments();
      toast.success("评论已添加");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "评论提交失败");
    } finally {
      setBusy("");
    }
  };

  const submitAnnotation = async () => {
    const values = annotation.split(",").map((value) => Number(value.trim()));
    if (
      !reviewId.trim() ||
      values.length !== 4 ||
      values.some((value) => !Number.isFinite(value))
    ) {
      toast.error("请输入审核 ID 和四个有效坐标");
      return;
    }
    setBusy("annotation");
    try {
      await addReviewAnnotation(reviewId.trim(), {
        label: "客户标注",
        x: values[0],
        y: values[1],
        width: values[2],
        height: values[3],
        body: annotationBody,
      });
      toast.success("坐标标注已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "标注保存失败");
    } finally {
      setBusy("");
    }
  };

  const confirm = async (decision: "approved" | "changes_requested") => {
    if (!reviewId.trim()) {
      toast.error("请输入审核 ID");
      return;
    }
    setBusy(decision);
    try {
      await confirmReviewDelivery(reviewId.trim(), decision, comment.trim());
      toast.success(decision === "approved" ? "已确认交付" : "已要求修改");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认失败");
    } finally {
      setBusy("");
    }
  };

  const loadProvenance = async () => {
    if (!assetId.trim()) {
      toast.error("请输入作品 ID");
      return;
    }
    setBusy("provenance");
    try {
      const result = await fetchAssetProvenance(assetId.trim());
      setProvenance(result.data);
    } catch (error) {
      setProvenance([]);
      toast.error(error instanceof Error ? error.message : "来源记录加载失败");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Surface>
        <SectionHeading
          eyebrow="P2 · REVIEW WORKFLOW"
          title="团队协作审核"
          description="围绕已有审核单追加评论、图片坐标标注以及客户确认结论。"
          action={
            <MessageSquareText
              className="size-5 text-violet-600"
              aria-hidden="true"
            />
          }
        />
        <div className="space-y-4 p-5">
          <div className="flex gap-2">
            <Input
              value={reviewId}
              onChange={(event) => setReviewId(event.target.value)}
              placeholder="审核 ID"
              aria-label="审核 ID"
              className="min-h-11 rounded-xl"
            />
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0 rounded-xl"
              disabled={busy === "comments"}
              onClick={() => void loadComments()}
            >
              加载
            </Button>
          </div>
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="输入审核意见或客户反馈"
            aria-label="审核评论"
            className="min-h-24 rounded-xl"
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 gap-2 rounded-xl"
              disabled={busy === "comment"}
              onClick={() => void submitComment()}
            >
              <MessageSquareText className="size-4" />
              添加评论
            </Button>
            <Button
              type="button"
              className="min-h-11 gap-2 rounded-xl bg-emerald-700 text-white hover:bg-emerald-600"
              disabled={busy === "approved"}
              onClick={() => void confirm("approved")}
            >
              <Check className="size-4" />
              确认交付
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 gap-2 rounded-xl border-rose-200 text-rose-700"
              disabled={busy === "changes_requested"}
              onClick={() => void confirm("changes_requested")}
            >
              <X className="size-4" />
              要求修改
            </Button>
          </div>

          <div className="rounded-xl border border-stone-200 p-4 dark:border-white/10">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Scan className="size-4 text-violet-600" />
              坐标标注
            </div>
            <p className="mb-2 text-xs leading-5 text-stone-500">
              使用归一化坐标 x,y,width,height，范围为 0–1。
            </p>
            <Input
              value={annotation}
              onChange={(event) => setAnnotation(event.target.value)}
              aria-label="标注坐标"
              className="min-h-11 rounded-xl font-mono"
            />
            <Textarea
              value={annotationBody}
              onChange={(event) => setAnnotationBody(event.target.value)}
              aria-label="标注说明"
              className="mt-2 min-h-20 rounded-xl"
            />
            <Button
              type="button"
              variant="outline"
              className="mt-2 min-h-11 w-full rounded-xl"
              disabled={busy === "annotation"}
              onClick={() => void submitAnnotation()}
            >
              保存标注
            </Button>
          </div>

          <div className="space-y-2">
            {comments.length ? (
              comments.map((item, index) => (
                <div
                  key={String(item.id || index)}
                  className="rounded-xl bg-stone-50 px-4 py-3 dark:bg-white/[0.05]"
                >
                  <div className="flex items-center justify-between gap-3 text-xs text-stone-500">
                    <strong className="text-stone-700 dark:text-stone-300">
                      {String(item.actor_name || "用户")}
                    </strong>
                    <span>
                      {item.created_at
                        ? new Date(String(item.created_at)).toLocaleString()
                        : ""}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-6">
                    {String(item.body || "")}
                  </p>
                </div>
              ))
            ) : (
              <EmptyState>加载审核单后查看协作评论。</EmptyState>
            )}
          </div>
        </div>
      </Surface>

      <Surface>
        <SectionHeading
          eyebrow="P2 · PROVENANCE"
          title="版权与来源记录"
          description="按版本记录模型、提示词摘要、参考图哈希、生成时间与操作者。"
          action={
            <ShieldCheck
              className="size-5 text-emerald-600"
              aria-hidden="true"
            />
          }
        />
        <div className="space-y-4 p-5">
          <div className="flex gap-2">
            <Input
              value={assetId}
              onChange={(event) => setAssetId(event.target.value)}
              placeholder="作品 ID"
              aria-label="作品 ID"
              className="min-h-11 rounded-xl"
            />
            <Button
              type="button"
              className="min-h-11 shrink-0 rounded-xl bg-stone-950 text-white dark:bg-white dark:text-stone-950"
              disabled={busy === "provenance"}
              onClick={() => void loadProvenance()}
            >
              查询来源
            </Button>
          </div>
          {provenance.length ? (
            provenance.map((item) => (
              <article
                key={item.version_id}
                className="rounded-xl border border-stone-200 p-4 dark:border-white/10"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm text-stone-950 dark:text-white">
                    版本 {item.version_id.slice(0, 10)}
                  </strong>
                  <span className="text-xs text-stone-500">
                    {new Date(item.created_at).toLocaleString()}
                  </span>
                </div>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-stone-500">模型</dt>
                    <dd className="mt-0.5 font-medium">{item.model}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-stone-500">操作</dt>
                    <dd className="mt-0.5 font-medium">{item.operation}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-stone-500">操作者</dt>
                    <dd className="mt-0.5 font-medium">{item.created_by}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-stone-500">参考文件</dt>
                    <dd className="mt-0.5 font-medium">
                      {item.reference_files.length}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 line-clamp-3 text-sm leading-6 text-stone-600 dark:text-stone-300">
                  {item.prompt}
                </p>
                <p className="mt-2 break-all font-mono text-[10px] text-stone-400">
                  SHA-256 {item.prompt_sha256}
                </p>
              </article>
            ))
          ) : (
            <EmptyState>新生成并归档的作品会自动留下来源记录。</EmptyState>
          )}
        </div>
      </Surface>
    </div>
  );
}
