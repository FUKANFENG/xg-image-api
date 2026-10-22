import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PublicApiGuide } from "@/components/public-api-guide";

export const metadata: Metadata = {
  title: "XG 公网生图 API · Agent 开发文档",
  description: "通过 Cloudflare 公网接口接入 XG 文生图、多参考图编辑、异步任务和结果下载。",
};

export default function DevelopersPage() {
  // One public Markdown source for both human readers and agents. No live secrets.
  const guide = readFileSync(join(process.cwd(), "public/docs/xg-public-api.md"), "utf8");
  return (
    <main className="mx-auto min-w-0 max-w-6xl space-y-6 pb-10">
      <PublicApiGuide />
      <article aria-label="完整公网 API 开发文档" className="min-w-0 rounded-2xl border border-stone-200/80 bg-white/80 p-5 text-sm leading-7 shadow-sm sm:p-8 dark:border-white/10 dark:bg-stone-950/65 [&_h1]:mb-5 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-10 [&_h2]:mb-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:mb-3 [&_h3]:font-semibold [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:break-words [&_a]:text-violet-700 [&_a]:underline dark:[&_a]:text-violet-300 [&_code]:break-words [&_code]:text-xs [&_pre_code]:break-normal [&_blockquote]:border-l-2 [&_blockquote]:border-violet-300 [&_blockquote]:pl-4 [&_blockquote]:text-stone-500">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          pre: ({ children }) => <pre tabIndex={0} className="my-4 max-w-full overflow-x-auto rounded-xl bg-stone-950 p-4 text-xs leading-6 text-stone-100">{children}</pre>,
          table: ({ children }) => <div tabIndex={0} className="my-4 max-w-full overflow-x-auto rounded-xl border border-stone-200 dark:border-white/10"><table className="w-full min-w-[540px] text-left text-xs [&_td]:border-t [&_td]:border-stone-200 [&_td]:p-3 [&_th]:p-3 dark:[&_td]:border-white/10">{children}</table></div>,
        }}>{guide}</ReactMarkdown>
      </article>
    </main>
  );
}
