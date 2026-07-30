"use client";

import {
  Activity,
  Bot,
  Cloud,
  Database,
  Globe2,
  ImageIcon,
  KeyRound,
  Layers3,
  LoaderCircle,
  Network,
  PlugZap,
  Presentation,
  RefreshCw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ImageStorageMode } from "@/lib/api";
import { testProxy, type ProxyTestResult } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "../store";

const inputClass =
  "h-10 rounded-xl border-stone-200 bg-white shadow-none focus-visible:border-violet-400 focus-visible:ring-violet-200/50 dark:border-white/10 dark:bg-stone-950/50 dark:focus-visible:border-violet-400";
const textareaClass =
  "rounded-xl border-stone-200 bg-white shadow-none focus-visible:border-violet-400 focus-visible:ring-violet-200/50 dark:border-white/10 dark:bg-stone-950/50 dark:focus-visible:border-violet-400";

function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white/85 shadow-sm dark:border-white/10 dark:bg-stone-950/55">
      <header className="flex items-start gap-3 border-b border-stone-200/70 px-5 py-4 dark:border-white/10">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-stone-100 text-stone-700 dark:bg-white/8 dark:text-stone-200">
          <Icon className="size-4.5" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-stone-950 dark:text-stone-50">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{description}</p>
        </div>
      </header>
      <div className="p-5 sm:p-6">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  description,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  description?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-stone-800 dark:text-stone-200">
        {label}
      </label>
      {children}
      {description ? <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">{description}</p> : null}
    </div>
  );
}

function ToggleCard({
  checked,
  onCheckedChange,
  title,
  description,
  icon: Icon,
  disabled = false,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  title: string;
  description: string;
  icon?: LucideIcon;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex min-h-20 cursor-pointer items-start gap-3 rounded-xl border border-stone-200 bg-stone-50/70 p-4 transition-colors hover:border-stone-300 hover:bg-stone-50 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.05]",
        disabled && "cursor-not-allowed opacity-55",
      )}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(Boolean(value))}
        aria-label={title}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium text-stone-900 dark:text-stone-100">
          {Icon ? <Icon className="size-4 text-violet-600 dark:text-violet-300" /> : null}
          {title}
        </span>
        <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-stone-400">{description}</span>
      </span>
    </label>
  );
}

export function ConfigCard() {
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | null>(null);
  const logLevelOptions = ["debug", "info", "warning", "error"];
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setRefreshAccountIntervalMinute = useSettingsStore((state) => state.setRefreshAccountIntervalMinute);
  const setImageRetentionDays = useSettingsStore((state) => state.setImageRetentionDays);
  const setImagePollTimeoutSecs = useSettingsStore((state) => state.setImagePollTimeoutSecs);
  const setImageAccountConcurrency = useSettingsStore((state) => state.setImageAccountConcurrency);
  const setImageSettleEnabled = useSettingsStore((state) => state.setImageSettleEnabled);
  const setImageRemoveConversationAfterResult = useSettingsStore((state) => state.setImageRemoveConversationAfterResult);
  const setImageSettleSecs = useSettingsStore((state) => state.setImageSettleSecs);
  const setImageTimeoutRetrySecs = useSettingsStore((state) => state.setImageTimeoutRetrySecs);
  const setAutoRemoveInvalidAccounts = useSettingsStore((state) => state.setAutoRemoveInvalidAccounts);
  const setAutoRemoveRateLimitedAccounts = useSettingsStore((state) => state.setAutoRemoveRateLimitedAccounts);
  const setAutoReloginAfterRefresh = useSettingsStore((state) => state.setAutoReloginAfterRefresh);
  const setLogLevel = useSettingsStore((state) => state.setLogLevel);
  const setProxy = useSettingsStore((state) => state.setProxy);
  const setBaseUrl = useSettingsStore((state) => state.setBaseUrl);
  const setGlobalSystemPrompt = useSettingsStore((state) => state.setGlobalSystemPrompt);
  const setSensitiveWordsText = useSettingsStore((state) => state.setSensitiveWordsText);
  const setAIReviewField = useSettingsStore((state) => state.setAIReviewField);
  const setImageStorageField = useSettingsStore((state) => state.setImageStorageField);
  const setUserToolEnabled = useSettingsStore((state) => state.setUserToolEnabled);
  const testImageStorage = useSettingsStore((state) => state.testImageStorage);
  const syncImagesToWebDAV = useSettingsStore((state) => state.syncImagesToWebDAV);
  const isTestingImageStorage = useSettingsStore((state) => state.isTestingImageStorage);
  const isSyncingImageStorage = useSettingsStore((state) => state.isSyncingImageStorage);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  const handleTestProxy = async () => {
    const candidate = String(config?.proxy || "").trim();
    if (!candidate) {
      toast.error("请先填写代理地址");
      return;
    }
    setIsTestingProxy(true);
    setProxyTestResult(null);
    try {
      const data = await testProxy(candidate);
      setProxyTestResult(data.result);
      if (data.result.ok) {
        toast.success(`代理可用（${data.result.latency_ms} ms，HTTP ${data.result.status}）`);
      } else {
        toast.error(`代理不可用：${data.result.error ?? "未知错误"}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  if (isLoadingConfig) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-2xl border border-stone-200/80 bg-white/80 dark:border-white/10 dark:bg-stone-950/50">
        <span className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
          <LoaderCircle className="size-4 animate-spin" />
          正在读取配置
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-sm leading-6 text-amber-950 dark:border-amber-400/20 dark:bg-amber-400/8 dark:text-amber-100">
        <KeyRound className="mt-1 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
        <p>
          管理员登录密钥继续从部署配置读取，不在页面中展示。需要分发访问权限时，请在“接口接入”中创建普通用户密钥。
        </p>
      </div>

      <SettingsSection
        icon={SlidersHorizontal}
        title="普通用户能力"
        description="控制普通用户可以看到和调用的工具入口；管理员调试页不受影响。"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <ToggleCard
            checked={Boolean(config?.user_tools?.search)}
            onCheckedChange={(checked) => setUserToolEnabled("search", checked)}
            title="网页搜索"
            description="查询网页并返回来源链接。"
            icon={Globe2}
          />
          <ToggleCard
            checked={Boolean(config?.user_tools?.ppt)}
            onCheckedChange={(checked) => setUserToolEnabled("ppt", checked)}
            title="PPT 生成"
            description="按需求生成演示文稿和素材包。"
            icon={Presentation}
          />
          <ToggleCard
            checked={Boolean(config?.user_tools?.psd)}
            onCheckedChange={(checked) => setUserToolEnabled("psd", checked)}
            title="PSD 生成"
            description="按参考图拆分可编辑图层。"
            icon={Layers3}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        icon={ImageIcon}
        title="账号与生图调度"
        description="调整账号刷新、图片任务并发、等待窗口和结果清理策略。"
      >
        <div className="grid gap-x-5 gap-y-6 md:grid-cols-2 xl:grid-cols-3">
          <Field
            label="账号刷新间隔"
            htmlFor="refresh-account-interval"
            description="单位分钟，控制账号自动刷新频率。"
          >
            <Input
              id="refresh-account-interval"
              value={String(config?.refresh_account_interval_minute || "")}
              onChange={(event) => setRefreshAccountIntervalMinute(event.target.value)}
              placeholder="5"
              inputMode="numeric"
              className={inputClass}
            />
          </Field>
          <Field
            label="图片访问地址"
            htmlFor="image-base-url"
            description="生成图片结果对外返回的访问前缀。"
            className="xl:col-span-2"
          >
            <Input
              id="image-base-url"
              value={String(config?.base_url || "")}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://example.com"
              className={inputClass}
            />
          </Field>
          <Field
            label="图片自动清理"
            htmlFor="image-retention-days"
            description="自动删除多少天前的本地图片。"
          >
            <Input
              id="image-retention-days"
              value={String(config?.image_retention_days || "")}
              onChange={(event) => setImageRetentionDays(event.target.value)}
              placeholder="30"
              inputMode="numeric"
              className={inputClass}
            />
          </Field>
          <Field
            label="图片轮询超时"
            htmlFor="image-poll-timeout"
            description="单位秒，等待上游图片结果的最长时间。"
          >
            <Input
              id="image-poll-timeout"
              value={String(config?.image_poll_timeout_secs || "")}
              onChange={(event) => setImagePollTimeoutSecs(event.target.value)}
              placeholder="300"
              inputMode="numeric"
              className={inputClass}
            />
          </Field>
          <Field
            label="单账号图片并发"
            htmlFor="image-account-concurrency"
            description="限制单个账号同时处理的图片请求数量。"
          >
            <Input
              id="image-account-concurrency"
              value={String(config?.image_account_concurrency || "")}
              onChange={(event) => setImageAccountConcurrency(event.target.value)}
              placeholder="3"
              inputMode="numeric"
              className={inputClass}
            />
          </Field>
          <Field
            label="超时继续等待"
            htmlFor="image-timeout-retry"
            description="单位秒，用户选择继续等待后的额外窗口。"
          >
            <Input
              id="image-timeout-retry"
              value={String(config?.image_timeout_retry_secs || "30")}
              onChange={(event) => setImageTimeoutRetrySecs(event.target.value)}
              placeholder="30"
              inputMode="numeric"
              className={inputClass}
            />
          </Field>
          <Field
            label="二次确认等待"
            htmlFor="image-settle-secs"
            description="找到图片后再次确认的等待时间，单位秒。"
          >
            <Input
              id="image-settle-secs"
              value={String(config?.image_settle_secs || "2.0")}
              onChange={(event) => setImageSettleSecs(event.target.value)}
              placeholder="2.0"
              inputMode="decimal"
              className={inputClass}
              disabled={!config?.image_settle_enabled}
            />
          </Field>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <ToggleCard
            checked={Boolean(config?.image_settle_enabled !== false)}
            onCheckedChange={setImageSettleEnabled}
            title="图片二次确认"
            description="找到图片后短暂等待并再次确认，提高结果获取稳定性。"
            icon={Activity}
          />
          <ToggleCard
            checked={Boolean(config?.image_remove_conversation_after_result)}
            onCheckedChange={setImageRemoveConversationAfterResult}
            title="出图后移除本地对话"
            description="成功拿到图片后，异步隐藏 ChatGPT 侧对应的对话记录。"
            icon={RefreshCw}
          />
          <ToggleCard
            checked={Boolean(config?.auto_relogin_after_refresh)}
            onCheckedChange={setAutoReloginAfterRefresh}
            title="刷新后尝试恢复账号"
            description="刷新时尝试重新登录并移除可恢复的异常状态。"
          />
          <ToggleCard
            checked={Boolean(config?.auto_remove_invalid_accounts)}
            onCheckedChange={setAutoRemoveInvalidAccounts}
            title="自动移除异常账号"
            description="账号刷新检测到认证失效时自动移除。"
          />
          <ToggleCard
            checked={Boolean(config?.auto_remove_rate_limited_accounts)}
            onCheckedChange={setAutoRemoveRateLimitedAccounts}
            title="自动移除限流账号"
            description="账号进入上游限流状态后自动从账号池移除。"
          />
        </div>
      </SettingsSection>

      <SettingsSection
        icon={Network}
        title="网络与代理"
        description="为上游请求设置统一代理，并在保存前验证连通性。"
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <Field
            label="全局代理"
            htmlFor="global-proxy"
            description="支持协议://账号:密码@主机:端口，也支持主机:端口:账号:密码。账号密码包含特殊字符时需要 URL 编码。"
          >
            <Input
              id="global-proxy"
              value={String(config?.proxy || "")}
              onChange={(event) => {
                setProxy(event.target.value);
                setProxyTestResult(null);
              }}
              placeholder="http://127.0.0.1:7890"
              className={inputClass}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white px-4 text-stone-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-200"
            onClick={() => void handleTestProxy()}
            disabled={isTestingProxy}
          >
            {isTestingProxy ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            测试代理
          </Button>
        </div>
        {proxyTestResult ? (
          <div
            role="status"
            className={cn(
              "mt-4 rounded-xl border px-4 py-3 text-sm leading-6",
              proxyTestResult.ok
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200"
                : "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200",
            )}
          >
            {proxyTestResult.ok
              ? `代理可用：HTTP ${proxyTestResult.status}，用时 ${proxyTestResult.latency_ms} ms`
              : `代理不可用：${proxyTestResult.error ?? "未知错误"}（用时 ${proxyTestResult.latency_ms} ms）`}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        icon={ShieldCheck}
        title="内容安全"
        description="在请求进入账号池之前完成规则约束、敏感词拦截和可选的 AI 审核。"
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <Field
            label="全局附加指令"
            htmlFor="global-system-prompt"
            description="每次请求都会作为 system 消息注入，用于统一审核规则和模型行为。"
          >
            <Textarea
              id="global-system-prompt"
              value={String(config?.global_system_prompt || "")}
              onChange={(event) => setGlobalSystemPrompt(event.target.value)}
              placeholder="例如：先判断用户提示词是否合规；遇到违法、色情、暴力、仇恨等请求时拒绝回答。"
              className={cn(textareaClass, "min-h-32 font-mono text-xs")}
            />
          </Field>
          <Field
            label="敏感词"
            htmlFor="sensitive-words"
            description="一行一个；用户请求命中任意敏感词时直接拒绝。"
          >
            <Textarea
              id="sensitive-words"
              value={(config?.sensitive_words || []).join("\n")}
              onChange={(event) => setSensitiveWordsText(event.target.value)}
              placeholder="一行一个，命中即拒绝"
              className={cn(textareaClass, "min-h-32 font-mono text-xs")}
            />
          </Field>
        </div>

        <div className="mt-6 rounded-xl border border-stone-200 bg-stone-50/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
          <ToggleCard
            checked={Boolean(config?.ai_review?.enabled)}
            onCheckedChange={(checked) => setAIReviewField("enabled", checked)}
            title="启用 AI 审核"
            description="审核不通过时直接拒绝，减少违规提示词触达生图账号造成风控的风险。"
            icon={Bot}
          />
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <Field label="Base URL" htmlFor="ai-review-base-url">
              <Input
                id="ai-review-base-url"
                value={String(config?.ai_review?.base_url || "")}
                onChange={(event) => setAIReviewField("base_url", event.target.value)}
                placeholder="https://api.openai.com"
                className={inputClass}
              />
            </Field>
            <Field label="API Key">
              <div className="flex h-10 items-center rounded-xl border border-stone-200 bg-white px-3 text-sm text-stone-600 dark:border-white/10 dark:bg-stone-950/50 dark:text-stone-300">
                {config?.ai_review?.has_api_key ? "已通过环境变量配置" : "请设置 MINIMAX_API_KEY"}
              </div>
            </Field>
            <Field label="Model" htmlFor="ai-review-model">
              <Input
                id="ai-review-model"
                value={String(config?.ai_review?.model || "")}
                onChange={(event) => setAIReviewField("model", event.target.value)}
                placeholder="gpt-5.4-mini"
                className={inputClass}
              />
            </Field>
          </div>
          <Field label="审核提示词" htmlFor="ai-review-prompt" className="mt-4">
            <Textarea
              id="ai-review-prompt"
              value={String(config?.ai_review?.prompt || "")}
              onChange={(event) => setAIReviewField("prompt", event.target.value)}
              placeholder="判断用户请求是否允许。只回答 ALLOW 或 REJECT。"
              className={cn(textareaClass, "min-h-24 text-xs")}
            />
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={Database}
        title="图片存储"
        description="保留本机存储，或将生成结果同步到 WebDAV。"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <ToggleCard
            checked={Boolean(config?.image_storage?.enabled)}
            onCheckedChange={(checked) => setImageStorageField("enabled", checked)}
            title="启用 WebDAV 图片存储"
            description="开启后可选择仅 WebDAV，或同时保留本机副本。"
            icon={Cloud}
          />
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-10 rounded-xl border-stone-200 bg-white px-4 text-stone-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-200"
              onClick={() => void testImageStorage()}
              disabled={isTestingImageStorage || !config?.image_storage?.enabled}
            >
              {isTestingImageStorage ? <LoaderCircle className="size-4 animate-spin" /> : <Cloud className="size-4" />}
              测试连接
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-10 rounded-xl border-stone-200 bg-white px-4 text-stone-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-200"
              onClick={() => void syncImagesToWebDAV()}
              disabled={isSyncingImageStorage || !config?.image_storage?.enabled || config?.image_storage?.mode === "local"}
            >
              {isSyncingImageStorage ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              全量同步
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-stone-300">
          <span>待保存模式</span>
          <strong className="rounded-full bg-white px-2.5 py-1 text-stone-900 shadow-sm dark:bg-white/10 dark:text-stone-100">
            {config?.image_storage?.enabled
              ? config.image_storage.mode === "both"
                ? "本机 + WebDAV"
                : config.image_storage.mode === "webdav"
                  ? "仅 WebDAV"
                  : "仅本机"
              : "仅本机"}
          </strong>
          <span className="text-stone-400">全量同步会把已有本地图片补传到远端。</span>
        </div>

        <div className="mt-5 grid gap-5 md:grid-cols-3">
          <Field label="保存模式">
            <Select
              value={String(config?.image_storage?.mode || "local")}
              onValueChange={(value) => setImageStorageField("mode", value as ImageStorageMode)}
              disabled={!config?.image_storage?.enabled}
            >
              <SelectTrigger className={inputClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">仅本机</SelectItem>
                <SelectItem value="webdav">仅 WebDAV</SelectItem>
                <SelectItem value="both">本机 + WebDAV</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="WebDAV URL" htmlFor="webdav-url" className="md:col-span-2">
            <Input
              id="webdav-url"
              value={String(config?.image_storage?.webdav_url || "")}
              onChange={(event) => setImageStorageField("webdav_url", event.target.value)}
              placeholder="https://example.com/dav"
              className={inputClass}
              disabled={!config?.image_storage?.enabled}
            />
          </Field>
          <Field label="用户名" htmlFor="webdav-username">
            <Input
              id="webdav-username"
              value={String(config?.image_storage?.webdav_username || "")}
              onChange={(event) => setImageStorageField("webdav_username", event.target.value)}
              className={inputClass}
              disabled={!config?.image_storage?.enabled}
            />
          </Field>
          <Field label="密码" htmlFor="webdav-password">
            <Input
              id="webdav-password"
              type="password"
              value={String(config?.image_storage?.webdav_password || "")}
              onChange={(event) => setImageStorageField("webdav_password", event.target.value)}
              className={inputClass}
              disabled={!config?.image_storage?.enabled}
            />
          </Field>
          <Field label="远端目录" htmlFor="webdav-root-path">
            <Input
              id="webdav-root-path"
              value={String(config?.image_storage?.webdav_root_path || "")}
              onChange={(event) => setImageStorageField("webdav_root_path", event.target.value)}
              placeholder="chatgpt2api/images"
              className={inputClass}
              disabled={!config?.image_storage?.enabled}
            />
          </Field>
          <Field
            label="公开访问前缀"
            htmlFor="webdav-public-url"
            description="留空时返回本应用 /images/... 代理地址；填写后直接返回公开图片地址。"
            className="md:col-span-3"
          >
            <Input
              id="webdav-public-url"
              value={String(config?.image_storage?.public_base_url || "")}
              onChange={(event) => setImageStorageField("public_base_url", event.target.value)}
              placeholder="https://cdn.example.com/chatgpt2api/images"
              className={inputClass}
              disabled={!config?.image_storage?.enabled}
            />
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={TerminalSquare}
        title="运行日志"
        description="选择控制台需要显示的日志级别；不选择时使用默认 info、warning 和 error。"
      >
        <div className="grid gap-2 sm:grid-cols-4">
          {logLevelOptions.map((level) => (
            <label
              key={level}
              className="flex cursor-pointer items-center gap-3 rounded-xl border border-stone-200 bg-stone-50/70 px-4 py-3 text-sm font-medium capitalize text-stone-700 dark:border-white/10 dark:bg-white/[0.03] dark:text-stone-200"
            >
              <Checkbox
                checked={Boolean(config?.log_levels?.includes(level))}
                onCheckedChange={(checked) => setLogLevel(level, Boolean(checked))}
              />
              {level}
            </label>
          ))}
        </div>
      </SettingsSection>

      <div className="z-20 flex flex-col gap-3 rounded-2xl border border-stone-200/90 bg-white/95 p-3 shadow-lg shadow-stone-900/8 backdrop-blur sm:sticky sm:bottom-3 sm:flex-row sm:items-center sm:justify-between dark:border-white/10 dark:bg-stone-950/92">
        <div className="flex items-center gap-2 px-1 text-xs text-stone-500 dark:text-stone-400">
          <Save className="size-3.5" />
          页面修改仅在保存后生效
        </div>
        <Button
          className="h-10 rounded-xl bg-stone-950 px-6 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-950 dark:hover:bg-stone-200"
          onClick={() => void saveConfig()}
          disabled={isSavingConfig}
        >
          {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          保存基础配置
        </Button>
      </div>
    </div>
  );
}
