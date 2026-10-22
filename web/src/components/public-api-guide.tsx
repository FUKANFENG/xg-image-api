"use client";

import Link from "next/link";
import { Clipboard, FileCode2, Globe2, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  XG_PUBLIC_BASE_URL, XG_PUBLIC_DOC_PATH, XG_PUBLIC_SCHEMA_PATH,
  XG_PUBLIC_CLIENT_PATH, XG_AGENT_INSTRUCTIONS, XG_POWERSHELL_EXAMPLE,
} from "@/lib/public-api-guide";

const endpoints = [
  ["POST", "/api/image-tasks/generations", "文字生图 · 返回任务"],
  ["POST", "/api/image-tasks/edits", "参考图编辑 · 支持多图"],
  ["GET", "/api/image-tasks?ids={id}", "查询状态、结果与错误"],
  ["POST", "/api/image-tasks/{id}/cancel", "取消任务"],
  ["GET", "/images/{path}", "鉴权下载结果图片"],
];

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("已复制");
  } catch {
    toast.error("复制失败，请手动选择文本");
  }
}

export function PublicApiGuide() {
  return (
    <section aria-labelledby="public-api-title" className="min-w-0 space-y-5 rounded-2xl border border-stone-200/80 bg-white/80 p-5 shadow-sm sm:p-6 dark:border-white/10 dark:bg-stone-950/65">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-xs font-medium text-violet-700 dark:text-violet-300"><Globe2 className="size-4" />Cloudflare · HTTPS 公网接入</p>
          <h2 id="public-api-title" className="mt-2 text-xl font-semibold">让你的 Agent 直接使用 XG 生图</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500 dark:text-stone-400">不需要连接本机或操作网页。用 API Key 提交任务、查询进度并取回图片；默认使用 ChatGPT Web 生图链路。</p>
        </div>
        <Link href="/developers/" className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-violet-700 underline-offset-4 hover:underline dark:text-violet-300">完整开发文档<ArrowRight className="size-4" /></Link>
      </div>

      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        {[
          ["公网服务根地址 · 推荐异步接口", XG_PUBLIC_BASE_URL],
          ["OpenAI 兼容 Base URL · 同步接口", `${XG_PUBLIC_BASE_URL}/v1`],
        ].map(([label, value]) => (
          <div key={label} className="flex min-w-0 items-center gap-2 rounded-xl border border-stone-200 bg-stone-50/80 p-3 dark:border-white/10 dark:bg-white/5">
            <div className="min-w-0 flex-1"><p className="text-xs text-stone-500 dark:text-stone-400">{label}</p><code className="mt-1 block break-all text-sm">{value}</code></div>
            <Button variant="ghost" size="icon" aria-label={`复制${label}`} onClick={() => void copy(value)}><Clipboard className="size-4" /></Button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button className="h-auto min-h-10 whitespace-normal rounded-xl" onClick={() => void copy(XG_AGENT_INSTRUCTIONS)}><Clipboard className="size-4 shrink-0" />复制 Agent 接入说明</Button>
        <Button variant="outline" className="h-auto min-h-10 whitespace-normal rounded-xl" onClick={() => void copy(`${XG_PUBLIC_BASE_URL}${XG_PUBLIC_DOC_PATH}`)}><Clipboard className="size-4 shrink-0" />复制公网文档链接</Button>
        <a href={XG_PUBLIC_DOC_PATH} className="inline-flex min-h-10 items-center gap-2 px-2 text-sm underline underline-offset-4"><FileCode2 className="size-4" />Markdown</a>
        <a href={XG_PUBLIC_SCHEMA_PATH} className="inline-flex min-h-10 items-center px-2 text-sm underline underline-offset-4">OpenAPI JSON</a>
        <a href={XG_PUBLIC_CLIENT_PATH} download className="inline-flex min-h-10 items-center px-2 text-sm underline underline-offset-4">Python 示例客户端</a>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <div className="min-w-0 overflow-hidden rounded-xl bg-stone-950 text-stone-100">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-2"><span className="text-xs text-stone-300">PowerShell · 提交与查询</span><Button variant="ghost" size="sm" className="text-white hover:bg-white/10 hover:text-white" onClick={() => void copy(XG_POWERSHELL_EXAMPLE)}><Clipboard className="size-3.5" />复制</Button></div>
          <pre tabIndex={0} aria-label="PowerShell 生图示例" className="max-w-full overflow-x-auto p-4 text-xs leading-6"><code>{XG_POWERSHELL_EXAMPLE}</code></pre>
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold">提交 → 轮询 → 下载</h3>
          <div className="mt-3 divide-y divide-stone-200 dark:divide-white/10">
            {endpoints.map(([method, path, purpose]) => (
              <div key={path} className="py-3 first:pt-0"><div className="flex items-start gap-2"><span className="shrink-0 rounded bg-violet-50 px-1.5 py-1 font-mono text-[10px] text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">{method}</span><code className="min-w-0 break-all text-xs leading-6">{path}</code></div><p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{purpose}</p></div>
            ))}
          </div>
        </div>
      </div>
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
        网页免登录不等于 API 免鉴权。API Key 由管理员单独提供，不是账号 Access Token，也不要把管理员密钥发给不可信的 Agent。公网长任务优先异步接口；连接超时先查询原任务，不要换 ID 重复提交。
      </div>
    </section>
  );
}
