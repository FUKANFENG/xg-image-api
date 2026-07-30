"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import {
  CalendarDays,
  Download,
  Eye,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  downloadPublicCreativeShare,
  fetchPublicCreativeShare,
  type PublicCreativeShare,
} from "@/lib/api";

export default function PublicSharePage() {
  const [token, setToken] = useState("");
  const [share, setShare] = useState<PublicCreativeShare | null>(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const currentToken =
        new URLSearchParams(window.location.search).get("token") || "";
      setToken(currentToken);
      if (!currentToken) {
        setError("分享链接不完整");
        return;
      }
      void fetchPublicCreativeShare(currentToken)
        .then(setShare)
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : "分享已失效"),
        );
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const download = async () => {
    if (!share) return;
    setDownloading(true);
    try {
      await downloadPublicCreativeShare(token, share.asset.name);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  };

  if (!share && !error)
    return (
      <main className="grid min-h-screen place-items-center bg-stone-950 text-white">
        <LoaderCircle className="size-8 animate-spin text-violet-400" />
      </main>
    );
  if (error)
    return (
      <main className="grid min-h-screen place-items-center bg-stone-950 px-6 text-center text-white">
        <div>
          <ShieldCheck className="mx-auto size-12 text-stone-500" />
          <h1 className="mt-5 text-2xl font-black">分享内容暂不可用</h1>
          <p className="mt-2 text-sm text-stone-400">{error}</p>
        </div>
      </main>
    );
  if (!share) return null;

  return (
    <main className="min-h-screen bg-stone-950 px-4 py-6 text-white sm:px-8 lg:py-10">
      <div className="mx-auto max-w-[1500px]">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold tracking-[0.18em] text-violet-300">
              <ShieldCheck className="size-4" />
              XG 只读交付
            </div>
            <h1 className="mt-3 text-2xl font-black sm:text-4xl">
              {share.asset.name}
            </h1>
            <div className="mt-3 flex flex-wrap gap-3 text-xs text-stone-400">
              <span>版本 V{share.version.version_number}</span>
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="size-3.5" />
                有效期至{" "}
                {new Date(share.expires_at).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </span>
              <span className="inline-flex items-center gap-1">
                <Eye className="size-3.5" />
                {share.downloads} 次下载
              </span>
            </div>
          </div>
          <Button
            disabled={downloading}
            onClick={() => void download()}
            className="min-h-12 rounded-xl bg-violet-600 px-6 text-white hover:bg-violet-500"
          >
            {downloading ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            下载当前成品
          </Button>
        </header>
        <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="relative min-h-[55vh] overflow-hidden rounded-3xl border border-white/10 bg-black/30 p-3 sm:p-6">
            <Image
              fill
              sizes="(min-width: 1280px) calc(100vw - 440px), 100vw"
              src={`/api/shared/${encodeURIComponent(token)}/download`}
              alt={share.asset.name}
              className="object-contain p-3 shadow-2xl sm:p-6"
              unoptimized
            />
          </div>
          <aside className="space-y-4">
            <article className="rounded-3xl border border-white/10 bg-white/5 p-5">
              <h2 className="font-bold">创作提示词</h2>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-stone-300">
                {share.version.prompt || "该版本未保存提示词"}
              </p>
            </article>
            <article className="rounded-3xl border border-white/10 bg-white/5 p-5">
              <h2 className="font-bold">作品信息</h2>
              <dl className="mt-4 grid grid-cols-[80px_1fr] gap-y-3 text-sm">
                <dt className="text-stone-500">类型</dt>
                <dd>{share.asset.asset_type}</dd>
                <dt className="text-stone-500">生成时间</dt>
                <dd>
                  {new Date(share.version.created_at).toLocaleString("zh-CN", {
                    hour12: false,
                  })}
                </dd>
                <dt className="text-stone-500">标签</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {share.asset.tags.length
                    ? share.asset.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-white/10 px-2 py-1 text-xs"
                        >
                          {tag}
                        </span>
                      ))
                    : "暂无"}
                </dd>
              </dl>
            </article>
            <p className="px-2 text-xs leading-5 text-stone-500">
              此页面仅用于预览和下载，不包含账号、后台或管理入口。
            </p>
          </aside>
        </section>
      </div>
    </main>
  );
}
