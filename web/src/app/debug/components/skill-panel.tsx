"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, Download, FileCode2, KeyRound } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import webConfig from "@/constants/common-env";
import { fetchSettingsConfig } from "@/lib/api";
import { getStoredAuthSession } from "@/store/auth";

export function SkillPanel() {
  const [browserBaseUrl, setBrowserBaseUrl] = useState("");
  const [configuredBaseUrl, setConfiguredBaseUrl] = useState("");
  const [authKey, setAuthKey] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setBrowserBaseUrl(window.location.origin), 0);
    void fetchSettingsConfig().then((data) => setConfiguredBaseUrl(String(data.config.base_url || "").replace(/\/$/, ""))).catch(() => undefined);
    void getStoredAuthSession().then((session) => setAuthKey(session?.key || ""));
    return () => window.clearTimeout(timer);
  }, []);

  const apiBaseUrl = configuredBaseUrl || webConfig.apiUrl.replace(/\/$/, "") || browserBaseUrl;
  const skillZh = useMemo(() => `---
name: chatgpt2api-search
description: 当用户需要联网搜索、查询最新信息、核实事实或需要来源链接时，调用本地 chatgpt2api 搜索接口。
---

# ChatGPT2API 搜索

当用户要求联网搜索、查询最新信息、核实资料、查新闻、查价格、查文档更新或需要来源链接时，使用这个 skill。

## 接口

POST ${apiBaseUrl}/v1/search

Headers:

Authorization: Bearer ${authKey}
Content-Type: application/json

Body:

{
  "prompt": "<用户要搜索的问题>"
}

## 返回处理

- 使用接口返回的 \`answer\` 作为主要回答。
- 如果有 \`sources\`，在回答里附上来源链接。
- 如果接口报错，简要说明错误并询问是否重试。`, [apiBaseUrl, authKey]);

  const skillEn = useMemo(() => `---
name: chatgpt2api-search
description: Use when current web search is needed through this chatgpt2api server. Call the configured HTTP search endpoint with a prompt and return the answer with source URLs.
---

# ChatGPT2API Search

Use this skill when the user asks for current web search, online lookup, recent information, or source-backed answers. It calls the local chatgpt2api search endpoint and returns an answer with source links.

## When to use

- The user asks to search the web, look something up, verify current information, or find the latest status.
- The answer needs source URLs, recent details, prices, releases, docs, laws, schedules, or news.
- Do not use it for purely local codebase questions unless the user explicitly asks for web search.

## Request

POST ${apiBaseUrl}/v1/search

Headers:

Authorization: Bearer ${authKey}
Content-Type: application/json

JSON body:

{
  "prompt": "<search question>"
}

## Response handling

- Use \`answer\` as the main response.
- Include source URLs from \`sources\` when available.
- If the endpoint returns an error, summarize the error and ask the user whether to retry.
- Keep the final answer concise unless the user asks for detail.`, [apiBaseUrl, authKey]);

  const zhPrompt = useMemo(() => `请帮我在本机安装一个用于联网搜索的 skill。

要求：
1. 请按你当前环境的 skill 安装规范，把它安装成本地 skill。
2. skill 名称为：chatgpt2api-search
3. 文件名为：SKILL.md
4. 如果你无法确定本地 skills 目录在哪里，先告诉我需要放到哪个目录，不要猜路径。
5. 只创建或更新这个 skill 文件，不要修改其他无关文件。
6. SKILL.md 请写入下面的完整内容。

SKILL.md 内容：

\`\`\`markdown
${skillZh}
\`\`\``, [skillZh]);

  const enPrompt = useMemo(() => `Please install a local web-search skill on this machine.

Requirements:
1. Install this as a local skill according to the skill installation rules of your current environment.
2. Skill name: chatgpt2api-search
3. File name: SKILL.md
4. If you cannot determine the local skills directory, tell me which directory is required before writing files.
5. Only create or update this skill file. Do not modify unrelated files.
6. Write the full content below into SKILL.md.

SKILL.md content:

\`\`\`markdown
${skillEn}
\`\`\``, [skillEn]);

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success("已复制");
  };

  const downloadSkill = (text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "SKILL.md";
    link.click();
    URL.revokeObjectURL(url);
  };

  const versions = [
    { title: "中文安装指令", language: "ZH-CN", desc: "复制后直接发给 Codex 或 Claude，让它安装到本地。", prompt: zhPrompt, skill: skillZh },
    { title: "English install prompt", language: "EN", desc: "Copy and send this to Codex or Claude to install locally.", prompt: enPrompt, skill: skillEn },
  ];

  return (
    <section className="space-y-4">
      <div className="flex items-start gap-3 rounded-2xl border border-emerald-200/80 bg-emerald-50/75 px-4 py-3 text-sm text-emerald-950 dark:border-emerald-400/20 dark:bg-emerald-400/8 dark:text-emerald-100">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300" />
        <p className="leading-6">
          页面预览会隐藏本地鉴权密钥；复制安装指令和下载的 SKILL.md 仍会带上当前可用配置。
        </p>
      </div>
      <div className="grid items-stretch gap-4 xl:grid-cols-2">
        {versions.map((item) => {
          const preview = authKey ? item.prompt.split(authKey).join("••••••••••••") : item.prompt;
          return (
            <article key={item.title} className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-white/85 shadow-sm dark:border-white/10 dark:bg-stone-950/55">
              <header className="flex flex-col gap-4 border-b border-stone-200/70 p-4 sm:flex-row sm:items-start sm:justify-between dark:border-white/10">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-stone-100 text-stone-700 dark:bg-white/8 dark:text-stone-200">
                    <FileCode2 className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate font-semibold text-stone-950 dark:text-stone-50">{item.title}</h2>
                      <span className="rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-stone-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-400">
                        {item.language}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{item.desc}</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="rounded-xl" onClick={() => downloadSkill(item.skill)}>
                    <Download className="size-4" />
                    下载
                  </Button>
                  <Button size="sm" className="rounded-xl bg-stone-950 text-white dark:bg-white dark:text-stone-950" onClick={() => void copyText(item.prompt)}>
                    <Copy className="size-4" />
                    复制指令
                  </Button>
                </div>
              </header>
              <div className="flex flex-wrap items-center gap-2 border-b border-stone-200/70 bg-stone-50/70 px-4 py-2.5 text-xs text-stone-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-stone-400">
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-300" />
                  POST /v1/search
                </span>
                <span aria-hidden="true">·</span>
                <span>{authKey ? "鉴权已就绪" : "等待读取本地密钥"}</span>
              </div>
              <pre className="max-h-[30rem] flex-1 overflow-auto whitespace-pre-wrap bg-stone-950 p-5 font-mono text-xs leading-6 text-stone-200 selection:bg-violet-400/30">
                {preview}
              </pre>
            </article>
          );
        })}
      </div>
    </section>
  );
}
