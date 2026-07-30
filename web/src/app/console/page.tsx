"use client";

import Link from "next/link";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clipboard,
  Code2,
  ImageIcon,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Server,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import webConfig from "@/constants/common-env";
import {
  fetchAccounts,
  fetchImageRuntimeMetrics,
  fetchModels,
  type Account,
  type ImageRuntimeMetrics,
  type Model,
} from "@/lib/api";
import { httpRequest } from "@/lib/request";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

type HealthResponse = {
  status?: string;
  version?: string;
};

type ConsoleSnapshot = {
  health: HealthResponse | null;
  accounts: Account[];
  metrics: ImageRuntimeMetrics | null;
  models: Model[];
};

const initialSnapshot: ConsoleSnapshot = {
  health: null,
  accounts: [],
  metrics: null,
  models: [],
};

const coreEndpoints = [
  {
    method: "GET",
    path: "/v1/models",
    purpose: "读取当前可用模型",
  },
  {
    method: "POST",
    path: "/v1/images/generations",
    purpose: "文本生成图片",
  },
  {
    method: "POST",
    path: "/v1/images/edits",
    purpose: "图片编辑与重绘",
  },
  {
    method: "POST",
    path: "/v1/chat/completions",
    purpose: "OpenAI 兼容对话",
  },
  {
    method: "POST",
    path: "/v1/responses",
    purpose: "Responses 兼容接口",
  },
];

const quickActions = [
  {
    href: "/image",
    title: "生图链路测试",
    description: "直接发起请求，确认账号、调度和返回结果均正常。",
    icon: ImageIcon,
  },
  {
    href: "/settings?tab=api-docs",
    title: "API 接入",
    description: "查看地址、鉴权方式和可直接复制的请求示例。",
    icon: KeyRound,
  },
  {
    href: "/accounts",
    title: "账号池",
    description: "维护 Access Token、状态、额度与限流恢复。",
    icon: UsersRound,
  },
  {
    href: "/monitor",
    title: "运行状态",
    description: "查看队列、并发、成功率和账号健康度。",
    icon: Activity,
  },
];

function Metric({
  label,
  value,
  detail,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Server;
  tone?: "default" | "success" | "warning";
}) {
  return (
    <div className="border-b border-stone-200/80 py-4 last:border-b-0 dark:border-white/10 sm:border-r sm:border-b-0 sm:px-5 sm:first:pl-0 sm:last:border-r-0 sm:last:pr-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-stone-500 dark:text-stone-400">
          {label}
        </span>
        <Icon
          aria-hidden="true"
          className={cn(
            "size-4",
            tone === "success"
              ? "text-emerald-600 dark:text-emerald-300"
              : tone === "warning"
                ? "text-amber-600 dark:text-amber-300"
                : "text-stone-400",
          )}
        />
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-stone-950 dark:text-white">
        {value}
      </div>
      <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
        {detail}
      </p>
    </div>
  );
}

function ConsoleContent() {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>(initialSnapshot);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [baseUrl] = useState(() =>
    (
      webConfig.apiUrl ||
      (typeof window !== "undefined" ? window.location.origin : "")
    ).replace(/\/$/, ""),
  );

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [healthResult, accountsResult, modelsResult, metricsResult] =
        await Promise.allSettled([
          httpRequest<HealthResponse>("/health?format=json", {
            redirectOnUnauthorized: false,
          }),
          fetchAccounts(),
          fetchModels(),
          fetchImageRuntimeMetrics(),
        ]);

      const next: ConsoleSnapshot = {
        health:
          healthResult.status === "fulfilled" ? healthResult.value : null,
        accounts:
          accountsResult.status === "fulfilled"
            ? accountsResult.value.items
            : [],
        models:
          modelsResult.status === "fulfilled" ? modelsResult.value.data : [],
        metrics:
          metricsResult.status === "fulfilled" ? metricsResult.value : null,
      };
      const successfulRequests = [
        healthResult,
        accountsResult,
        modelsResult,
        metricsResult,
      ].filter((result) => result.status === "fulfilled").length;

      setSnapshot(next);
      setError(
        successfulRequests === 0
          ? "控制台数据暂时无法读取，请确认服务与登录状态。"
          : successfulRequests < 4
            ? "部分运行数据暂时不可用，核心 API 仍可单独测试。"
            : "",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "控制台加载失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const copyText = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label}已复制`);
    } catch {
      toast.error("复制失败，请手动选择文本");
    }
  }, []);

  const normalAccounts = useMemo(
    () => snapshot.accounts.filter((account) => account.status === "正常").length,
    [snapshot.accounts],
  );
  const activeQueue =
    (snapshot.metrics?.queue.queued ?? 0) +
    (snapshot.metrics?.queue.running ?? 0);
  const isHealthy =
    snapshot.health?.status === "ok" || snapshot.health?.status === "healthy";
  const primaryModel =
    snapshot.models.find((model) => model.id.toLowerCase() === "gpt-image-2")
      ?.id ||
    snapshot.models.find(
      (model) =>
        model.id.toLowerCase().includes("image") &&
        !model.id.toLowerCase().includes("codex"),
    )?.id ||
    snapshot.models[0]?.id ||
    "--";
  const openAIBaseUrl = baseUrl ? `${baseUrl}/v1` : "";
  const curlExample = `curl "${baseUrl || "http://127.0.0.1:8000"}/v1/images/generations" \\
  -H "Authorization: Bearer $XG_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-image-2","prompt":"一只纸雕风格的白鹤","n":1,"response_format":"b64_json"}'`;

  if (loading) {
    return (
      <div className="grid min-h-[50vh] place-items-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <section className="mx-auto w-full max-w-7xl space-y-6 pb-10">
      <header className="relative overflow-hidden rounded-[28px] border border-stone-200/80 bg-stone-950 px-5 py-7 text-white shadow-[0_20px_55px_rgba(28,25,23,0.12)] sm:px-8 sm:py-9 dark:border-white/10">
        <div
          aria-hidden="true"
          className="absolute -top-24 -right-20 size-72 rounded-full bg-violet-500/25 blur-3xl"
        />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <Badge className="border-white/15 bg-white/10 text-violet-100">
              API-first
            </Badge>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              工作流 API 控制台
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-stone-300 sm:text-base">
              网页只保留接入、测试和运维入口。日常调用直接使用 OpenAI
              兼容接口，复杂功能收纳在“更多”中，不影响原有能力与数据。
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-fit rounded-xl border-white/15 bg-white/8 text-white shadow-none hover:bg-white/15 hover:text-white"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            刷新状态
          </Button>
        </div>
      </header>

      {error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid rounded-2xl border border-stone-200/80 bg-white/80 px-5 shadow-sm backdrop-blur sm:grid-cols-2 lg:grid-cols-4 dark:border-white/10 dark:bg-stone-950/65">
        <Metric
          label="服务状态"
          value={isHealthy ? "正常" : snapshot.health ? "异常" : "未读取"}
          detail={
            snapshot.health?.version
              ? `当前版本 ${snapshot.health.version}`
              : "健康检查 /health"
          }
          icon={isHealthy ? CheckCircle2 : Server}
          tone={isHealthy ? "success" : "warning"}
        />
        <Metric
          label="可用账号"
          value={`${normalAccounts} / ${snapshot.accounts.length}`}
          detail="正常账号可参与自动调度"
          icon={UsersRound}
          tone={normalAccounts > 0 ? "success" : "warning"}
        />
        <Metric
          label="当前队列"
          value={String(activeQueue)}
          detail={`${snapshot.metrics?.queue.running ?? 0} 运行中 · ${snapshot.metrics?.queue.queued ?? 0} 等待`}
          icon={Activity}
          tone={activeQueue > 0 ? "default" : "success"}
        />
        <Metric
          label="默认模型"
          value={primaryModel}
          detail={`共读取 ${snapshot.models.length} 个模型`}
          icon={Code2}
        />
      </div>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <article className="min-w-0 max-w-full rounded-2xl border border-stone-200/80 bg-white/80 p-5 shadow-sm sm:p-6 dark:border-white/10 dark:bg-stone-950/65">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-stone-950 dark:text-white">
                工作流接入地址
              </h2>
              <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">
                兼容 OpenAI SDK；鉴权使用 Bearer API Key。
              </p>
            </div>
            <Link
              href="/settings?tab=api-docs"
              className="inline-flex items-center gap-1 text-sm font-medium text-violet-700 hover:text-violet-900 dark:text-violet-300 dark:hover:text-violet-100"
            >
              完整文档
              <ArrowRight className="size-4" />
            </Link>
          </div>

          <div className="mt-5 space-y-3">
            {[
              { label: "服务地址", value: baseUrl },
              { label: "OpenAI Base URL", value: openAIBaseUrl },
            ].map((item) => (
              <div
                key={item.label}
                className="flex min-w-0 flex-col gap-2 rounded-xl border border-stone-200 bg-stone-50/80 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-white/10 dark:bg-white/5"
              >
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold tracking-wide text-stone-400 uppercase">
                    {item.label}
                  </div>
                  <code className="mt-1 block truncate text-sm text-stone-800 dark:text-stone-200">
                    {item.value || "正在读取…"}
                  </code>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="self-end rounded-lg sm:self-auto"
                  disabled={!item.value}
                  onClick={() => void copyText(item.value, item.label)}
                >
                  <Clipboard className="size-4" />
                  <span className="sr-only">复制{item.label}</span>
                </Button>
              </div>
            ))}
          </div>

          <div className="mt-5 min-w-0 max-w-full overflow-hidden rounded-xl bg-stone-950 text-stone-100">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
              <span className="text-xs font-medium text-stone-400">
                最小生图请求
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 rounded-lg text-stone-300 hover:bg-white/10 hover:text-white"
                onClick={() => void copyText(curlExample, "请求示例")}
              >
                <Clipboard className="size-3.5" />
                复制
              </Button>
            </div>
            <pre className="max-w-full overflow-x-auto p-4 text-xs leading-6 text-stone-300">
              <code>{curlExample}</code>
            </pre>
          </div>
        </article>

        <article className="min-w-0 max-w-full rounded-2xl border border-stone-200/80 bg-white/80 p-5 shadow-sm sm:p-6 dark:border-white/10 dark:bg-stone-950/65">
          <h2 className="text-lg font-semibold tracking-tight text-stone-950 dark:text-white">
            核心接口
          </h2>
          <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">
            工作流通常只需要下面五个端点。
          </p>
          <div className="mt-4 divide-y divide-stone-200 dark:divide-white/10">
            {coreEndpoints.map((endpoint) => (
              <div key={endpoint.path} className="py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "w-11 shrink-0 rounded-md px-1.5 py-1 text-center font-mono text-[10px] font-semibold",
                      endpoint.method === "GET"
                        ? "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300"
                        : "bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300",
                    )}
                  >
                    {endpoint.method}
                  </span>
                  <code className="min-w-0 truncate text-xs text-stone-800 dark:text-stone-200">
                    {endpoint.path}
                  </code>
                </div>
                <p className="mt-1.5 pl-[52px] text-xs text-stone-500 dark:text-stone-400">
                  {endpoint.purpose}
                </p>
              </div>
            ))}
          </div>
        </article>
      </div>

      <div>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-stone-950 dark:text-white">
              需要网页时
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              四个入口覆盖日常接入、联调和运维。
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {quickActions.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="group rounded-2xl border border-stone-200/80 bg-white/75 p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md dark:border-white/10 dark:bg-stone-950/60 dark:hover:border-violet-400/30"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="grid size-9 place-items-center rounded-xl bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">
                  <action.icon className="size-4" />
                </span>
                <ArrowRight className="size-4 text-stone-300 transition group-hover:translate-x-0.5 group-hover:text-violet-600 dark:text-stone-600 dark:group-hover:text-violet-300" />
              </div>
              <h3 className="mt-4 text-sm font-semibold text-stone-900 dark:text-stone-100">
                {action.title}
              </h3>
              <p className="mt-1.5 text-xs leading-5 text-stone-500 dark:text-stone-400">
                {action.description}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function ConsolePage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <ConsoleContent />;
}
