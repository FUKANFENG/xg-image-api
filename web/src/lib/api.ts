import { httpRequest, request } from "@/lib/request";
import { USER_DEFAULT_IMAGE_MODEL } from "@/lib/image-model-policy";

export type AccountType = string;
export type AccountStatus = "正常" | "限流" | "异常" | "禁用";
export type ImageModel = string;
export type AuthRole = "admin" | "user";

export type ImageRuntimeMetrics = {
  generated_at: string;
  queue: {
    queued: number;
    paused: number;
    running: number;
    capacity: number;
    global_concurrency: number;
    effective_global_concurrency?: number;
    per_user_concurrency: number;
    account_slot_capacity?: number | null;
    available_dispatch_slots?: number;
    borrowed_user_slots?: number;
    work_conserving?: boolean;
    slot_utilization_percent?: number;
    active_users: number;
    rejected_total: number;
    saturation_percent: number;
  };
  performance: {
    p50_secs: number;
    p95_secs: number;
    throughput_per_minute: number;
    estimated_task_secs: number;
  };
  tasks: Record<string, number> & { total: number };
  errors: Record<string, number>;
  storage: {
    healthy: boolean;
    journal_mode: string;
    quick_check: string;
    task_count: number;
  };
  accounts: {
    total_slots: number;
    used_slots: number;
    cooling_accounts: number;
    accounts: Array<{
      email: string;
      source_type: string;
      status: string;
      quota: number;
      inflight: number;
      concurrency_limit: number;
      circuit_state: string;
      cooldown_remaining_secs: number;
      latency_ema_ms: number;
      average_duration_secs: number;
      success_count: number;
      failure_count: number;
      success_rate: number | null;
      health_score: number;
      health_level: "healthy" | "warning" | "critical";
      consecutive_failures: number;
      last_failure_kind: string;
    }>;
  };
  user_quotas: { users: number; remaining: number; used: number };
  analytics: {
    summary: { success_rate: number; average_duration_secs: number };
    daily: Array<{
      date: string;
      total: number;
      success: number;
      error: number;
    }>;
    models: Array<{ name: string; count: number }>;
    features: Array<{ name: string; count: number }>;
  };
  user_rankings: Array<{
    owner_id: string;
    name: string;
    username?: string | null;
    group: string;
    total: number;
    success: number;
    error: number;
    remaining_quota?: number | null;
    used_quota?: number | null;
  }>;
  security: {
    weak_admin_password: boolean;
    ai_review_enabled: boolean;
    backup_enabled: boolean;
    backup_last_status: string | null;
  };
};
export type ImageStorageMode = "local" | "webdav" | "both";

export type ImageStorageSettings = {
  enabled: boolean;
  mode: ImageStorageMode;
  webdav_url: string;
  webdav_username: string;
  webdav_password: string;
  webdav_root_path: string;
  public_base_url: string;
};

export type Account = {
  access_token: string;
  type: AccountType;
  source_type?: string | null;
  status: AccountStatus;
  quota: number;
  created_at?: string | null;
  email?: string | null;
  user_id?: string | null;
  limits_progress?: Array<{
    feature_name?: string;
    remaining?: number;
    reset_after?: string;
  }>;
  default_model_slug?: string | null;
  restore_at?: string | null;
  success: number;
  fail: number;
  /** 当前图片在途数(正在生成、尚未结束的图片数)。号池空闲时持续 > 0 表示并发槽位泄漏。 */
  image_inflight?: number;
  last_used_at?: string | null;
  proxy?: string | null;
};

export type AccountImportPayload = {
  access_token: string;
  accessToken?: string;
  type?: string;
  export_type?: string;
  source_type?: string;
  [key: string]: unknown;
};

export type Model = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  permission: unknown[];
  root: string;
  parent: string | null;
};

type AccountListResponse = {
  items: Account[];
};

type ModelListResponse = {
  object: string;
  data: Model[];
};

type AccountMutationResponse = {
  items: Account[];
  added?: number;
  skipped?: number;
  removed?: number;
  refreshed?: number;
  relogined?: number;
  errors?: Array<{ access_token: string; error: string }>;
};

export type AccountRefreshResponse = {
  items: Account[];
  refreshed: number;
  relogined?: number;
  errors: Array<{ access_token: string; error: string }>;
};

export type RefreshProgressResponse = {
  total: number;
  processed: number;
  done: boolean;
  error: string | null;
  status_counts?: Record<string, number>;
  total_quota?: number;
  result?: AccountRefreshResponse | null;
  results?: Array<{ token: string; status: string; error?: string | null }>;
};

type AccountUpdateResponse = {
  item: Account;
  items: Account[];
};

export type ProxyRuntimeEgressMode = "direct" | "single_proxy";
export type ProxyRuntimeClearanceMode = "none" | "manual" | "flaresolverr";

export type ProxyRuntimeClearanceSettings = {
  enabled: boolean;
  mode: ProxyRuntimeClearanceMode;
  cf_cookies: string;
  cf_clearance: string;
  user_agent: string;
  browser: string;
  flaresolverr_url: string;
  timeout_sec: number | string;
  refresh_interval: number | string;
  warm_up_on_start: boolean;
  has_cf_cookies?: boolean;
  has_cf_clearance?: boolean;
};

export type ProxyRuntimeSettings = {
  enabled: boolean;
  egress_mode: ProxyRuntimeEgressMode;
  proxy_url: string;
  resource_proxy_url: string;
  skip_ssl_verify: boolean;
  reset_session_status_codes: number[];
  clearance: ProxyRuntimeClearanceSettings;
};

export type ProxyRuntimeStatus = {
  enabled: boolean;
  egress_mode: ProxyRuntimeEgressMode | string;
  proxy_source: string;
  has_proxy: boolean;
  clearance_enabled: boolean;
  clearance_mode: ProxyRuntimeClearanceMode | string;
  has_clearance_bundle: boolean;
  cached_clearance_hosts: string[];
};

export type ProxyRuntimeResponse = {
  runtime: ProxyRuntimeSettings;
  status: ProxyRuntimeStatus;
};

export type ThirdPartyAppsSettings = {
  infinite_canvas: {
    enabled: boolean;
    url: string;
  };
};

export type UserToolsSettings = {
  search: boolean;
  ppt: boolean;
  psd: boolean;
};

export type SettingsConfig = {
  proxy: string;
  base_url?: string;
  global_system_prompt?: string;
  sensitive_words?: string[];
  ai_review?: {
    enabled?: boolean;
    base_url?: string;
    api_key?: string;
    has_api_key?: boolean;
    model?: string;
    prompt?: string;
  };
  refresh_account_interval_minute?: number | string;
  image_retention_days?: number | string;
  image_poll_timeout_secs?: number | string;
  image_account_concurrency?: number | string;
  image_parallel_generation?: boolean;
  image_settle_enabled?: boolean;
  image_check_before_hit_enabled?: boolean;
  image_remove_conversation_after_result?: boolean;
  image_settle_secs?: number | string;
  image_timeout_retry_secs?: number | string;
  auto_remove_invalid_accounts?: boolean;
  auto_remove_rate_limited_accounts?: boolean;
  auto_relogin_after_refresh?: boolean;
  log_levels?: string[];
  image_storage?: ImageStorageSettings;
  proxy_runtime?: ProxyRuntimeSettings;
  third_party_apps?: ThirdPartyAppsSettings;
  user_tools?: UserToolsSettings;
  backup?: BackupSettings;
  backup_state?: BackupState;
  [key: string]: unknown;
};

export type BackupInclude = {
  config: boolean;
  cpa: boolean;
  sub2api: boolean;
  logs: boolean;
  image_tasks: boolean;
  accounts_snapshot: boolean;
  auth_keys_snapshot: boolean;
  inspirations: boolean;
  images: boolean;
};

export type BackupSettings = {
  enabled: boolean;
  provider: "local" | "cloudflare_r2";
  account_id: string;
  access_key_id: string;
  secret_access_key: string;
  bucket: string;
  prefix: string;
  interval_minutes: number | string;
  rotation_keep: number | string;
  encrypt: boolean;
  passphrase: string;
  include: BackupInclude;
};

export type BackupState = {
  running: boolean;
  last_started_at?: string | null;
  last_finished_at?: string | null;
  last_status?: string;
  last_error?: string | null;
  last_object_key?: string | null;
};

export type BackupItem = {
  key: string;
  name: string;
  size: number;
  updated_at?: string | null;
  encrypted: boolean;
};

export type BackupDetail = {
  key: string;
  name: string;
  encrypted: boolean;
  created_at?: string | null;
  trigger?: string | null;
  app_version?: string | null;
  storage_backend?: Record<string, unknown> | null;
  files: Array<{
    name: string;
    exists: boolean;
    content_type?: string;
    size: number;
    sha256?: string;
  }>;
  snapshots: Array<{
    name: string;
    count: number;
  }>;
};

export type ManagedImage = {
  rel: string;
  path?: string;
  name: string;
  date: string;
  size: number;
  url: string;
  thumbnail_url?: string;
  created_at: string;
  width?: number;
  height?: number;
  tags?: string[];
};

export type InspirationLibraryItem = {
  id: string;
  title: string;
  prompt: string;
  size: string;
  quality: string;
  category: "curated";
  category_label: string;
  level: "入门" | "进阶" | "创意";
  preview: string;
  description: string;
  tags: string[];
  published_at: string;
};

export type InspirationCandidate = {
  owner_id: string;
  task_id: string;
  image_index: number;
  prompt: string;
  preview_url: string;
  size: string;
  quality: string;
  created_at: string;
  is_curated: boolean;
};

export type InspirationCandidatePagination = {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

export type InspirationCandidatePage = {
  items: InspirationCandidate[];
  pagination: InspirationCandidatePagination;
};

export type SystemLog = {
  id: string;
  time: string;
  type: "call" | "account" | string;
  summary?: string;
  detail?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ImageResponse = {
  created: number;
  data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
};

export type ImageTask = {
  id: string;
  status: "queued" | "paused" | "running" | "success" | "error";
  mode: "generate" | "edit";
  model?: ImageModel;
  size?: string;
  quality?: string;
  created_at: string;
  updated_at: string;
  prompt?: string;
  conversation_id?: string;
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: string;
  error_code?: string;
  progress?: string;
  elapsed_secs?: number;
  duration_ms?: number;
  queue_position?: number;
  queue_total?: number;
  estimated_wait_secs?: number;
  remaining_image_quota?: number;
  retryable?: boolean;
  recovery_mode?: "resume_poll" | "retry";
  resume_count?: number;
  last_checkpoint?: string;
  priority?: number;
  owner_id?: string;
  workflow?: {
    batch_id?: string;
    project_id?: string;
    asset_id?: string;
    parent_version_id?: string;
    branch_id?: string;
    operation_type?: string;
    conversation_id?: string;
    [key: string]: unknown;
  };
};

export type ImageQueueEstimate = {
  accepting: boolean;
  queue_position: number;
  queued: number;
  running: number;
  capacity: number;
  global_concurrency: number;
  user_concurrency: number;
  estimated_wait_secs: number;
  estimated_generation_secs: number;
  estimated_total_secs: number;
  estimated_range_secs: { low: number; high: number };
  sample_count: number;
  confidence: "low" | "medium" | "high";
};

export type CreativeBatchItem = {
  id: string;
  task_id: string;
  source_name: string;
  source_path: string;
  prompt: string;
  params: Record<string, unknown>;
  submit_error: string;
  created_at: string;
  task: ImageTask;
};

export type CreativeBatch = {
  id: string;
  mode: "generate" | "restore";
  name: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  item_count?: number;
  items?: CreativeBatchItem[];
  counts?: {
    total: number;
    queued: number;
    paused: number;
    running: number;
    success: number;
    error: number;
    cancelled: number;
  };
  completed?: boolean;
};

export type CreativeProject = {
  id: string;
  name: string;
  description: string;
  favorite: boolean;
  tags: string[];
  asset_count: number;
  created_at: string;
  updated_at: string;
};

export type CreativeVersion = {
  id: string;
  asset_id: string;
  parent_version_id?: string | null;
  branch_id?: string | null;
  task_id: string;
  image_index: number;
  version_number: number;
  operation: string;
  image_path: string;
  image_url: string;
  prompt: string;
  params: Record<string, unknown>;
  created_at: string;
};

export type CreativeAsset = {
  id: string;
  project_id?: string | null;
  name: string;
  asset_type: "image" | "prompt" | "ppt" | "psd" | string;
  favorite: boolean;
  tags: string[];
  metadata: Record<string, unknown>;
  current_version_id?: string | null;
  current_image_url?: string;
  current_image_path?: string;
  current_version_number?: number;
  versions?: CreativeVersion[];
  created_at: string;
  updated_at: string;
};

export type CreativeQualityScores = {
  overall: number;
  text: number;
  anatomy: number;
  face: number;
  brand: number;
  composition: number;
};

export type CreativeQualityReview = {
  version_id: string;
  asset_id: string;
  status: "not_started" | "pending" | "running" | "ready" | "retryable_failed";
  scores: Partial<CreativeQualityScores>;
  issues: string[];
  strengths: string[];
  recommendation: string;
  model: string;
  error: string;
  elapsed_ms: number;
  created_at?: string;
  updated_at?: string;
};

export type SemanticCreativeAsset = Pick<
  CreativeAsset,
  "name" | "project_id" | "asset_type" | "tags" | "favorite" | "created_at"
> & {
  asset_id: string;
  version_id: string;
  image_path: string;
  image_url: string;
  prompt: string;
  semantic_score: number;
};

export type CreativeDerivative = {
  id: string;
  asset_id: string;
  source_version_id: string;
  preset: "xiaohongshu" | "ecommerce" | "wechat" | "poster";
  label: string;
  width: number;
  height: number;
  mode: "cover" | "contain";
  image_path: string;
  image_url: string;
  created_at: string;
};

export type CreativeBranch = {
  id: string;
  asset_id: string;
  name: string;
  root_version_id: string;
  head_version_id: string;
  status: "active" | "archived";
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type CreativeVersionTree = {
  asset_id: string;
  current_version_id?: string | null;
  branches: CreativeBranch[];
  nodes: CreativeVersion[];
  edges: Array<{ from: string; to: string }>;
};

export type CreativeBoardItem = {
  id: string;
  board_id: string;
  item_type: "image" | "reference" | "text" | "color";
  content: string;
  image_path: string;
  image_url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type CreativeBoard = {
  id: string;
  project_id?: string | null;
  name: string;
  description: string;
  item_count?: number;
  items?: CreativeBoardItem[];
  created_at: string;
  updated_at: string;
};

export type CreativeNotification = {
  id: string;
  event: string;
  title: string;
  message: string;
  payload: Record<string, unknown>;
  channel_results: Record<string, { ok?: boolean; error?: string }>;
  read: boolean;
  created_at: string;
};

export type CreativeNotificationSettings = {
  in_app: boolean;
  browser: boolean;
  email: boolean;
  email_to: string;
  webhook: boolean;
  webhook_url: string;
  wecom: boolean;
  wecom_url: string;
  events: string[];
  updated_at?: string;
};

export type CreativeProjectBudget = {
  project_id: string;
  owner_id?: string;
  configured?: boolean;
  budget_type?: "project" | "department" | "client";
  label?: string;
  credit_limit?: number;
  used_credits?: number;
  reserved_credits?: number;
  remaining_credits?: number;
  unit_cost?: number;
  estimated_cost?: number;
  warning_percent?: number;
  warning?: boolean;
  enabled?: boolean;
  success_rate?: number | null;
  average_duration_ms?: number;
  created_at?: string;
  updated_at?: string;
};

export type ImageIntegrityItem = {
  path: string;
  exists: boolean;
  local: boolean;
  remote: boolean;
  recoverable: boolean;
  backed_up: boolean;
  invalid_local: boolean;
  storage: "both" | "local" | "webdav" | "missing";
  reference_count: number;
  asset_ids: string[];
  asset_names: string[];
};

export type ImageIntegrityReport = {
  summary: {
    version_references: number;
    unique_images: number;
    available: number;
    missing: number;
    recoverable: number;
    backed_up: number;
    local_only: number;
    remote_only: number;
    invalid_local: number;
    backup_mode: string;
  };
  items: ImageIntegrityItem[];
  problems: ImageIntegrityItem[];
  scanned_at: string;
};

export type ImageStorageReadiness = {
  image_protection: {
    mode: "local" | "webdav" | "both";
    status: "protected" | "warning" | "unprotected" | "misconfigured";
    remote_enabled: boolean;
    remote_configured: boolean;
    recommendation: string;
  };
  integrity: Pick<
    ImageIntegrityReport["summary"],
    | "unique_images"
    | "backed_up"
    | "local_only"
    | "remote_only"
    | "recoverable"
    | "missing"
  >;
  system_backup: {
    enabled: boolean;
    provider: string;
    includes_images: boolean;
    last_status: string;
  };
  scanned_at: string;
};

export type CreativeConversationMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  task_id: string;
  version_id: string;
  status: "running" | "success" | "error";
  created_at: string;
};

export type CreativeConversation = {
  id: string;
  asset_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages?: CreativeConversationMessage[];
};

export type CreativePolicy = {
  subject_id: string;
  subject_type: "user" | "group";
  features: Record<string, boolean>;
  rate_limit_per_minute: number;
  frozen: boolean;
  abnormal_reason: string;
  updated_at: string;
};

export type CreativeRecipe = {
  id: string;
  name: string;
  category: string;
  description: string;
  settings: Record<string, unknown>;
  scope_type: "private" | "group" | "global";
  scope_id: string;
  builtin: boolean;
  owner_id: string;
  created_at: string;
  updated_at: string;
};

export type ConsistencyStrength = "strict" | "balanced" | "creative";

export type ConsistencyProfile = {
  id: string;
  profile_type: "brand" | "person" | "product" | "style";
  name: string;
  instructions: string;
  colors: string[];
  fonts: string[];
  logo_paths: string[];
  reference_paths: string[];
  default_strength: ConsistencyStrength;
  created_at: string;
  updated_at: string;
};

export type ReversePromptResult = {
  prompt: string;
  summary: string;
  subject: string;
  composition: string;
  lighting: string;
  colors: string[];
  style: string;
  text_content: string[];
  model: string;
  elapsed_ms: number;
};

export type CreativeReview = {
  id: string;
  owner_id: string;
  asset_id: string;
  asset_name: string;
  version_id: string;
  version_number: number;
  status: "pending" | "approved" | "rejected";
  submitted_by: string;
  submitted_at: string;
  reviewed_by: string;
  reviewed_at: string;
  comment: string;
  image_url: string;
};

export type CreativeTrashItem = {
  id: string;
  owner_id: string;
  entity_type: "project" | "asset" | "version";
  entity_id: string;
  snapshot: Record<string, unknown>;
  deleted_at: string;
  expires_at: string;
};

export type CreativeAudit = {
  id: string;
  owner_id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
  ip_address: string;
  user_agent: string;
  created_at: string;
};

export type PublicCreativeShare = {
  token: string;
  asset: { id: string; name: string; asset_type: string; tags: string[] };
  version: {
    id: string;
    version_number: number;
    image_url: string;
    prompt: string;
    params: Record<string, unknown>;
    created_at: string;
  };
  expires_at: string;
  downloads: number;
};

type ImageTaskListResponse = {
  items: ImageTask[];
  missing_ids: string[];
  total?: number;
  has_more?: boolean;
  next_offset?: number | null;
};

export type LoginResponse = {
  ok: boolean;
  version: string;
  role: AuthRole;
  subject_id: string;
  name: string;
  image_quota?: number;
};

export type AuthSessionResponse =
  | (LoginResponse & { authenticated: true })
  | { ok: false; authenticated: false; version: string };

export type UserAccount = {
  id: string;
  name: string;
  username: string | null;
  role: "user";
  enabled: boolean;
  image_quota: number;
  group?: string;
  image_quota_used: number;
  password_configured: boolean;
  legacy_key_enabled: boolean;
  created_at: string | null;
  last_used_at: string | null;
};

export async function fetchAuthSession() {
  return httpRequest<AuthSessionResponse>("/auth/session", {
    method: "POST",
    body: {},
    redirectOnUnauthorized: false,
  });
}

export async function fetchAccounts() {
  return httpRequest<AccountListResponse>("/api/accounts");
}

export async function fetchModels() {
  return httpRequest<ModelListResponse>("/v1/models");
}

export async function enhanceImagePrompt(prompt: string, instruction = "") {
  return httpRequest<{ prompt: string; fallback?: boolean; message?: string }>(
    "/api/prompt-enhancements",
    {
      method: "POST",
      body: { prompt, instruction },
    },
  );
}

export async function createAccounts(
  tokens: string[],
  accounts: AccountImportPayload[] = [],
) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "POST",
    body: { tokens, accounts },
  });
}

export type OAuthLoginStartResponse = {
  session_id: string;
  authorize_url: string;
  expires_in: string;
  redirect_uri_prefix: string;
};

export async function startOAuthLogin(emailHint?: string) {
  return httpRequest<OAuthLoginStartResponse>("/api/accounts/oauth/start", {
    method: "POST",
    body: { email_hint: emailHint ?? "" },
  });
}

export async function finishOAuthLogin(sessionId: string, callback: string) {
  return httpRequest<AccountMutationResponse>("/api/accounts/oauth/finish", {
    method: "POST",
    body: { session_id: sessionId, callback },
  });
}

export async function deleteAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "DELETE",
    body: { tokens },
  });
}

export async function refreshAccounts(accessTokens: string[]) {
  return httpRequest<{ progress_id: string }>("/api/accounts/refresh", {
    method: "POST",
    body: { access_tokens: accessTokens },
  });
}

export async function fetchRefreshProgress(progressId: string) {
  return httpRequest<RefreshProgressResponse>(
    `/api/accounts/refresh/progress/${progressId}`,
  );
}

export async function reLoginAccounts(accessTokens: string[]) {
  return httpRequest<{ progress_id: string }>("/api/accounts/re-login", {
    method: "POST",
    body: { access_tokens: accessTokens },
  });
}

export async function fetchReLoginProgress(progressId: string) {
  return httpRequest<RefreshProgressResponse>(
    `/api/accounts/re-login/progress/${progressId}`,
  );
}

export async function updateAccount(
  accessToken: string,
  updates: {
    type?: AccountType;
    status?: AccountStatus;
    quota?: number;
    proxy?: string;
  },
) {
  return httpRequest<AccountUpdateResponse>("/api/accounts/update", {
    method: "POST",
    body: {
      access_token: accessToken,
      ...updates,
    },
  });
}

export async function generateImage(
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality = "auto",
) {
  return httpRequest<ImageResponse>("/v1/images/generations", {
    method: "POST",
    body: {
      prompt,
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
      quality,
      n: 1,
      response_format: "b64_json",
    },
  });
}

export async function editImage(
  files: File | File[],
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality = "auto",
) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  formData.append("quality", quality);
  formData.append("n", "1");

  return httpRequest<ImageResponse>("/v1/images/edits", {
    method: "POST",
    body: formData,
  });
}

export async function createImageGenerationTask(
  clientTaskId: string,
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality = "auto",
  workflow: {
    project_id?: string;
    asset_id?: string;
    parent_version_id?: string;
    branch_id?: string;
    operation_type?: string;
    conversation_id?: string;
    asset_name?: string;
    priority?: number;
    recipe_id?: string;
    profile_id?: string;
    profile_strength?: ConsistencyStrength;
    profile_reference_included?: boolean;
  } = {},
) {
  return httpRequest<ImageTask>("/api/image-tasks/generations", {
    method: "POST",
    body: {
      client_task_id: clientTaskId,
      prompt,
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
      quality,
      ...workflow,
    },
  });
}

export async function createImageEditTask(
  clientTaskId: string,
  files: File | File[],
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality = "auto",
  workflow: {
    project_id?: string;
    asset_id?: string;
    parent_version_id?: string;
    branch_id?: string;
    operation_type?: string;
    conversation_id?: string;
    source_path?: string;
    asset_name?: string;
    priority?: number;
    recipe_id?: string;
    profile_id?: string;
    profile_strength?: ConsistencyStrength;
    profile_reference_included?: boolean;
    canvas_ratio?: "" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
    outpaint_directions?: string | string[];
    preserve_strength?: ConsistencyStrength;
  } = {},
  masks: File | File[] | null = null,
) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  const maskFiles = masks ? (Array.isArray(masks) ? masks : [masks]) : [];
  maskFiles.forEach((file) => formData.append("mask", file));
  formData.append("client_task_id", clientTaskId);
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  formData.append("quality", quality);
  Object.entries(workflow).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "")
      formData.append(key, String(value));
  });

  return httpRequest<ImageTask>("/api/image-tasks/edits", {
    method: "POST",
    body: formData,
  });
}

export async function fetchImageTasks(
  ids: string[],
  page: { limit?: number; offset?: number } = {},
) {
  const params = new URLSearchParams();
  if (ids.length > 0) {
    params.set("ids", ids.join(","));
  } else {
    params.set("limit", String(page.limit ?? 64));
    params.set("offset", String(page.offset ?? 0));
  }
  params.set("_t", String(Date.now()));
  return httpRequest<ImageTaskListResponse>(
    `/api/image-tasks?${params.toString()}`,
  );
}

export async function fetchImageRuntimeMetrics() {
  return httpRequest<ImageRuntimeMetrics>(
    `/api/image-tasks/metrics?_t=${Date.now()}`,
  );
}

export async function fetchImageQueueEstimate() {
  return httpRequest<ImageQueueEstimate>(
    `/api/image-tasks/estimate?_t=${Date.now()}`,
  );
}

export async function retryImageGenerationTask(taskId: string) {
  return httpRequest<ImageTask>(
    `/api/image-tasks/${encodeURIComponent(taskId)}/retry`,
    {
      method: "POST",
      body: {},
    },
  );
}

export async function bulkRetryImageTasks(taskIds: string[]) {
  return httpRequest<{
    items: ImageTask[];
    errors: Array<{ task_id: string; error: string }>;
  }>("/api/image-tasks/bulk-retry", {
    method: "POST",
    body: { task_ids: taskIds },
  });
}

export async function cancelImageTask(taskId: string) {
  return httpRequest<ImageTask>(
    `/api/image-tasks/${encodeURIComponent(taskId)}/cancel`,
    {
      method: "POST",
      body: {},
    },
  );
}

export async function pauseImageTask(taskId: string) {
  return httpRequest<ImageTask>(
    `/api/image-tasks/${encodeURIComponent(taskId)}/pause`,
    { method: "POST", body: {} },
  );
}

export async function resumePausedImageTask(taskId: string) {
  return httpRequest<ImageTask>(
    `/api/image-tasks/${encodeURIComponent(taskId)}/resume`,
    { method: "POST", body: {} },
  );
}

export async function updateImageTaskPriority(
  taskId: string,
  priority: number,
) {
  return httpRequest<ImageTask>(
    `/api/image-tasks/${encodeURIComponent(taskId)}/priority`,
    { method: "PUT", body: { priority } },
  );
}

export async function fetchAdminImageQueue(limit = 300) {
  return httpRequest<{ items: ImageTask[] }>(
    `/api/image-tasks/admin/queue?limit=${limit}&_t=${Date.now()}`,
  );
}

export async function deleteFailedImageTask(taskId: string) {
  return httpRequest<{ ok: boolean; id: string }>(
    `/api/image-tasks/${encodeURIComponent(taskId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function resumeImagePoll(taskId: string, extraTimeoutSecs = 30) {
  return httpRequest<ImageTask>(
    `/api/image-tasks/${encodeURIComponent(taskId)}/resume-poll`,
    {
      method: "POST",
      body: { extra_timeout_secs: extraTimeoutSecs },
    },
  );
}

export async function fetchSettingsConfig() {
  return httpRequest<{ config: SettingsConfig }>("/api/settings");
}

export async function updateSettingsConfig(settings: SettingsConfig) {
  return httpRequest<{ config: SettingsConfig }>("/api/settings", {
    method: "POST",
    body: settings,
  });
}

export async function fetchThirdPartyApps() {
  return httpRequest<{ third_party_apps: ThirdPartyAppsSettings }>(
    "/api/third-party-apps",
  );
}

export async function fetchUserTools() {
  return httpRequest<{ tools: UserToolsSettings }>("/api/user-tools");
}

export async function testBackupConnection() {
  return httpRequest<{ result: { ok: boolean; status: number } }>(
    "/api/backup/test",
    {
      method: "POST",
      body: {},
    },
  );
}

export async function testImageStorageConnection() {
  return httpRequest<{
    result: { ok: boolean; status: number; error?: string };
  }>("/api/image-storage/test", {
    method: "POST",
    body: {},
  });
}

export async function fetchImageStorageReadiness(force = false) {
  return httpRequest<ImageStorageReadiness>(
    `/api/image-storage/readiness?force=${force ? "true" : "false"}&_t=${Date.now()}`,
  );
}

export async function syncImageStorage() {
  return httpRequest<{
    result: { uploaded: number; skipped: number; failed: number };
  }>("/api/image-storage/sync", {
    method: "POST",
    body: {},
  });
}

export async function fetchBackups() {
  return httpRequest<{
    items: BackupItem[];
    state: BackupState;
    settings: BackupSettings;
  }>("/api/backups");
}

export async function runBackupNow() {
  return httpRequest<{
    result: { key: string; size: number; encrypted: boolean };
  }>("/api/backups/run", {
    method: "POST",
    body: {},
  });
}

export async function deleteBackup(key: string) {
  return httpRequest<{ ok: boolean }>("/api/backups/delete", {
    method: "POST",
    body: { key },
  });
}

export async function fetchBackupDetail(key: string) {
  const params = new URLSearchParams();
  params.set("key", key);
  return httpRequest<{ item: BackupDetail }>(
    `/api/backups/detail?${params.toString()}`,
  );
}

export function getBackupDownloadUrl(key: string) {
  const params = new URLSearchParams();
  params.set("key", key);
  return `/api/backups/download?${params.toString()}`;
}

export async function fetchManagedImages(filters: {
  start_date?: string;
  end_date?: string;
}) {
  const params = new URLSearchParams();
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  return httpRequest<{
    items: ManagedImage[];
    groups: Array<{ date: string; items: ManagedImage[] }>;
  }>(`/api/images${params.toString() ? `?${params.toString()}` : ""}`);
}

export async function deleteManagedImages(body: {
  paths?: string[];
  start_date?: string;
  end_date?: string;
  all_matching?: boolean;
}) {
  return httpRequest<{ removed: number }>("/api/images/delete", {
    method: "POST",
    body,
  });
}

export async function downloadImages(paths: string[]) {
  const response = await request.post(
    "/api/images/download",
    { paths },
    { responseType: "blob" },
  );
  const blob = response.data as Blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "images.zip";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function downloadSingleImage(path: string) {
  const response = await request.get(`/api/images/download/${path}`, {
    responseType: "blob",
  });
  const blob = response.data as Blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() || "image.png";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function fetchImageTags() {
  return httpRequest<{ tags: string[] }>("/api/images/tags");
}

export async function setImageTags(path: string, tags: string[]) {
  return httpRequest<{ ok: boolean; tags: string[] }>("/api/images/tags", {
    method: "POST",
    body: { path, tags },
  });
}

export async function deleteImageTag(tag: string) {
  return httpRequest<{ ok: boolean; removed_from: number }>(
    `/api/images/tags/${encodeURIComponent(tag)}`,
    {
      method: "DELETE",
    },
  );
}

export type ImageStorageStats = {
  disk_total_mb: number;
  disk_used_mb: number;
  disk_free_mb: number;
  image_count: number;
  image_size_mb: number;
  image_size_bytes: number;
};

export async function fetchImageStorage() {
  return httpRequest<ImageStorageStats>("/api/images/storage");
}

export async function compressAllImages() {
  return httpRequest<{
    compressed: number;
    saved_bytes: number;
    saved_mb: number;
  }>("/api/images/storage/compress", { method: "POST" });
}

export async function deleteToTarget(targetFreeMb: number) {
  return httpRequest<{ removed: number; freed_mb: number; done: boolean }>(
    `/api/images/storage/cleanup-to-target?target_free_mb=${targetFreeMb}&dry_run=false`,
    { method: "POST" },
  );
}

export async function fetchSystemLogs(filters: {
  type?: string;
  start_date?: string;
  end_date?: string;
}) {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  return httpRequest<{ items: SystemLog[] }>(
    `/api/logs${params.toString() ? `?${params.toString()}` : ""}`,
  );
}

export async function deleteSystemLogs(ids: string[]) {
  return httpRequest<{ removed: number }>("/api/logs/delete", {
    method: "POST",
    body: { ids },
  });
}

export async function fetchUserAccounts() {
  return httpRequest<{ items: UserAccount[] }>("/api/auth/users");
}

export async function fetchInspirationLibrary() {
  return httpRequest<{ items: InspirationLibraryItem[] }>("/api/inspirations");
}

export async function fetchInspirationCandidates(page = 1, pageSize = 9) {
  const params = new URLSearchParams({
    page: String(Math.max(1, Math.floor(page))),
    page_size: String(Math.max(1, Math.min(Math.floor(pageSize), 100))),
  });
  return httpRequest<InspirationCandidatePage>(
    `/api/admin/inspiration-candidates?${params.toString()}`,
  );
}

export async function curateInspirationFromTask(
  candidate: Pick<InspirationCandidate, "owner_id" | "task_id" | "image_index">,
) {
  return httpRequest<{ item: InspirationLibraryItem; created: boolean }>(
    "/api/admin/inspirations/from-task",
    {
      method: "POST",
      body: candidate,
    },
  );
}

export async function createUserAccount(input: {
  username: string;
  password: string;
  name: string;
  image_quota: number;
  group?: string;
}) {
  return httpRequest<{ item: UserAccount; items: UserAccount[] }>(
    "/api/auth/users",
    {
      method: "POST",
      body: input,
    },
  );
}

export async function updateUserAccount(
  userId: string,
  updates: {
    enabled?: boolean;
    name?: string;
    username?: string;
    password?: string;
    image_quota?: number;
    group?: string;
  },
) {
  return httpRequest<{ item: UserAccount; items: UserAccount[] }>(
    `/api/auth/users/${userId}`,
    {
      method: "POST",
      body: updates,
    },
  );
}

export async function deleteUserAccount(userId: string) {
  return httpRequest<{ items: UserAccount[] }>(`/api/auth/users/${userId}`, {
    method: "DELETE",
  });
}

// ── CPA (CLIProxyAPI) ──────────────────────────────────────────────

export type CPAPool = {
  id: string;
  name: string;
  base_url: string;
  import_job?: CPAImportJob | null;
};

export type CPARemoteFile = {
  name: string;
  email: string;
};

export type CPAImportJob = {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  total: number;
  completed: number;
  added: number;
  skipped: number;
  refreshed: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
};

export async function fetchCPAPools() {
  return httpRequest<{ pools: CPAPool[] }>("/api/cpa/pools");
}

export async function createCPAPool(pool: {
  name: string;
  base_url: string;
  secret_key: string;
}) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>("/api/cpa/pools", {
    method: "POST",
    body: pool,
  });
}

export async function updateCPAPool(
  poolId: string,
  updates: { name?: string; base_url?: string; secret_key?: string },
) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>(
    `/api/cpa/pools/${poolId}`,
    {
      method: "POST",
      body: updates,
    },
  );
}

export async function deleteCPAPool(poolId: string) {
  return httpRequest<{ pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "DELETE",
  });
}

export async function fetchCPAPoolFiles(poolId: string) {
  return httpRequest<{ pool_id: string; files: CPARemoteFile[] }>(
    `/api/cpa/pools/${poolId}/files`,
  );
}

export async function startCPAImport(poolId: string, names: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(
    `/api/cpa/pools/${poolId}/import`,
    {
      method: "POST",
      body: { names },
    },
  );
}

export async function fetchCPAPoolImportJob(poolId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(
    `/api/cpa/pools/${poolId}/import`,
  );
}

// ── Sub2API ────────────────────────────────────────────────────────

export type Sub2APIServer = {
  id: string;
  name: string;
  base_url: string;
  email: string;
  has_api_key: boolean;
  group_id: string;
  import_job?: CPAImportJob | null;
};

export type Sub2APIRemoteAccount = {
  id: string;
  name: string;
  email: string;
  plan_type: string;
  status: string;
  expires_at: string;
  has_refresh_token: boolean;
};

export type Sub2APIRemoteGroup = {
  id: string;
  name: string;
  description: string;
  platform: string;
  status: string;
  account_count: number;
  active_account_count: number;
};

export async function fetchSub2APIServers() {
  return httpRequest<{ servers: Sub2APIServer[] }>("/api/sub2api/servers");
}

export async function createSub2APIServer(server: {
  name: string;
  base_url: string;
  email: string;
  password: string;
  api_key: string;
  group_id: string;
}) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>(
    "/api/sub2api/servers",
    {
      method: "POST",
      body: server,
    },
  );
}

export async function updateSub2APIServer(
  serverId: string,
  updates: {
    name?: string;
    base_url?: string;
    email?: string;
    password?: string;
    api_key?: string;
    group_id?: string;
  },
) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>(
    `/api/sub2api/servers/${serverId}`,
    {
      method: "POST",
      body: updates,
    },
  );
}

export async function fetchSub2APIServerGroups(serverId: string) {
  return httpRequest<{ server_id: string; groups: Sub2APIRemoteGroup[] }>(
    `/api/sub2api/servers/${serverId}/groups`,
  );
}

export async function deleteSub2APIServer(serverId: string) {
  return httpRequest<{ servers: Sub2APIServer[] }>(
    `/api/sub2api/servers/${serverId}`,
    {
      method: "DELETE",
    },
  );
}

export async function fetchSub2APIServerAccounts(serverId: string) {
  return httpRequest<{ server_id: string; accounts: Sub2APIRemoteAccount[] }>(
    `/api/sub2api/servers/${serverId}/accounts`,
  );
}

export async function startSub2APIImport(
  serverId: string,
  accountIds: string[],
) {
  return httpRequest<{ import_job: CPAImportJob | null }>(
    `/api/sub2api/servers/${serverId}/import`,
    {
      method: "POST",
      body: { account_ids: accountIds },
    },
  );
}

export async function fetchSub2APIImportJob(serverId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(
    `/api/sub2api/servers/${serverId}/import`,
  );
}

// ── Upstream proxy ────────────────────────────────────────────────

export type ProxySettings = {
  enabled: boolean;
  url: string;
};

export type ProxyTestResult = {
  ok: boolean;
  status: number;
  latency_ms: number;
  error: string | null;
  proxy_source?: string;
  has_proxy?: boolean;
};

export type ClearanceTestResult = {
  ok: boolean;
  status: string;
  latency_ms: number;
  has_cookies: boolean;
  user_agent: string;
  error: string | null;
  runtime: ProxyRuntimeStatus;
};

export async function fetchProxy() {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy");
}

export async function updateProxy(updates: {
  enabled?: boolean;
  url?: string;
}) {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy", {
    method: "POST",
    body: updates,
  });
}

export async function testProxy(url?: string) {
  return httpRequest<{ result: ProxyTestResult }>("/api/proxy/test", {
    method: "POST",
    body: { url: url ?? "" },
  });
}

export async function fetchProxyRuntime() {
  return httpRequest<ProxyRuntimeResponse>("/api/proxy/runtime");
}

export async function updateProxyRuntime(runtime: ProxyRuntimeSettings) {
  return httpRequest<ProxyRuntimeResponse>("/api/proxy/runtime", {
    method: "POST",
    body: runtime,
  });
}

export async function testProxyClearance(targetUrl?: string) {
  return httpRequest<{ result: ClearanceTestResult }>(
    "/api/proxy/clearance/test",
    {
      method: "POST",
      body: { target_url: targetUrl ?? "https://chatgpt.com" },
    },
  );
}

export async function createGenerationBatch(input: {
  prompt?: string;
  prompts?: string[];
  count?: number;
  name?: string;
  model?: ImageModel;
  size?: string;
  quality?: string;
  project_id?: string;
  recipe_id?: string;
  profile_id?: string;
  priority?: number;
}) {
  return httpRequest<CreativeBatch>("/api/workspace/batches/generations", {
    method: "POST",
    body: input,
  });
}

export async function createRestorationBatch(input: {
  files: File[];
  name?: string;
  mode: string;
  strength: string;
  model?: ImageModel;
  size?: string;
  quality?: string;
  project_id?: string;
}) {
  const formData = new FormData();
  input.files.forEach((file) => formData.append("image", file));
  formData.append("name", input.name || "");
  formData.append("mode", input.mode);
  formData.append("strength", input.strength);
  formData.append("model", input.model || "gpt-image-2");
  formData.append("size", input.size || "");
  formData.append("quality", input.quality || "auto");
  formData.append("project_id", input.project_id || "");
  return httpRequest<CreativeBatch>("/api/workspace/batches/restorations", {
    method: "POST",
    body: formData,
  });
}

export async function fetchCreativeBatches(limit = 30) {
  return httpRequest<{ items: CreativeBatch[] }>(
    `/api/workspace/batches?limit=${limit}`,
  );
}

export async function fetchCreativeBatch(batchId: string) {
  return httpRequest<CreativeBatch>(
    `/api/workspace/batches/${encodeURIComponent(batchId)}?_t=${Date.now()}`,
  );
}

export async function downloadCreativeBatch(
  batchId: string,
  name = "xg-batch",
) {
  const response = await request.get(
    `/api/workspace/batches/${encodeURIComponent(batchId)}/download`,
    {
      responseType: "blob",
    },
  );
  const url = URL.createObjectURL(response.data as Blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.replace(/[\\/:*?"<>|]+/g, "-") || "xg-batch"}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export async function retryCreativeBatchItem(batchId: string, itemId: string) {
  return httpRequest<CreativeBatch>(
    `/api/workspace/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/retry`,
    { method: "POST", body: {} },
  );
}

export async function fetchCreativeProjects(
  filters: { query?: string; tag?: string; favorite?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (filters.query) params.set("query", filters.query);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.favorite !== undefined)
    params.set("favorite", String(filters.favorite));
  return httpRequest<{ items: CreativeProject[] }>(
    `/api/workspace/projects${params.size ? `?${params}` : ""}`,
  );
}

export async function createCreativeProject(input: {
  name: string;
  description?: string;
  tags?: string[];
}) {
  return httpRequest<CreativeProject>("/api/workspace/projects", {
    method: "POST",
    body: input,
  });
}

export async function updateCreativeProject(
  projectId: string,
  updates: Partial<
    Pick<CreativeProject, "name" | "description" | "favorite" | "tags">
  >,
) {
  return httpRequest<CreativeProject>(
    `/api/workspace/projects/${encodeURIComponent(projectId)}`,
    {
      method: "PATCH",
      body: updates,
    },
  );
}

export async function deleteCreativeProject(projectId: string) {
  return httpRequest<{ ok: boolean }>(
    `/api/workspace/projects/${encodeURIComponent(projectId)}`,
    { method: "DELETE" },
  );
}

export async function fetchCreativeAssets(
  filters: {
    project_id?: string;
    asset_type?: string;
    query?: string;
    tag?: string;
    favorite?: boolean;
    limit?: number;
    offset?: number;
  } = {},
) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined) params.set(key, String(value));
  });
  return httpRequest<{
    items: CreativeAsset[];
    total: number;
    has_more: boolean;
    next_offset: number | null;
  }>(`/api/workspace/assets${params.size ? `?${params}` : ""}`);
}

export async function fetchImageIntegrity(force = false, includeAll = false) {
  return httpRequest<ImageIntegrityReport>(
    `/api/workspace/assets/integrity?force=${force ? "true" : "false"}&include_all=${includeAll ? "true" : "false"}&_t=${Date.now()}`,
  );
}

export async function repairImageIntegrity(includeAll = false) {
  return httpRequest<
    ImageIntegrityReport & {
      restored: string[];
      backed_up: string[];
      failed: Array<{ path: string; error: string }>;
      before: ImageIntegrityReport["summary"];
      after: ImageIntegrityReport["summary"];
    }
  >(
    `/api/workspace/assets/integrity/repair?include_all=${includeAll ? "true" : "false"}`,
    {
      method: "POST",
      body: {},
    },
  );
}

export async function bulkArchiveCreativeAssets(
  assetIds: string[],
  projectId: string | null,
) {
  return httpRequest<{
    updated: number;
    asset_ids: string[];
    project_id: string | null;
  }>("/api/workspace/assets/bulk-archive", {
    method: "POST",
    body: { asset_ids: assetIds, project_id: projectId },
  });
}

export async function detectDuplicateCreativeAssets(threshold = 8) {
  return httpRequest<{
    summary: {
      scanned: number;
      duplicates: number;
      exact_duplicates: number;
      failures: number;
      threshold: number;
    };
    pairs: Array<{
      asset_id: string;
      asset_name: string;
      duplicate_of: string;
      duplicate_name: string;
      distance: number;
      similarity: number;
      exact: boolean;
    }>;
    failures: Array<{ asset_id: string; error: string }>;
    scanned_at: string;
  }>("/api/workspace/assets/detect-duplicates", {
    method: "POST",
    body: { threshold },
  });
}

export async function fetchCreativeAsset(assetId: string) {
  return httpRequest<CreativeAsset>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}?_t=${Date.now()}`,
  );
}

export async function archiveCreativeAsset(input: {
  name: string;
  asset_type?: string;
  project_id?: string;
  image_path?: string;
  image_url?: string;
  prompt?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}) {
  return httpRequest<CreativeAsset>("/api/workspace/assets", {
    method: "POST",
    body: input,
  });
}

export async function updateCreativeAsset(
  assetId: string,
  updates: {
    name?: string;
    project_id?: string | null;
    favorite?: boolean;
    tags?: string[];
  },
) {
  return httpRequest<CreativeAsset>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}`,
    {
      method: "PATCH",
      body: updates,
    },
  );
}

export async function activateCreativeVersion(
  assetId: string,
  versionId: string,
) {
  return httpRequest<CreativeAsset>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}/activate`,
    { method: "POST", body: {} },
  );
}

export async function deleteCreativeAsset(assetId: string) {
  return httpRequest<{ ok: boolean }>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}`,
    { method: "DELETE" },
  );
}

export async function fetchAssetConversations(assetId: string) {
  return httpRequest<{ items: CreativeConversation[] }>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/conversations`,
  );
}

export async function createAssetConversation(assetId: string, title = "") {
  return httpRequest<CreativeConversation>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/conversations`,
    { method: "POST", body: { title } },
  );
}

export async function fetchCreativeConversation(conversationId: string) {
  return httpRequest<CreativeConversation>(
    `/api/workspace/conversations/${encodeURIComponent(conversationId)}?_t=${Date.now()}`,
  );
}

export async function submitCreativeConversationMessage(
  conversationId: string,
  input: {
    instruction: string;
    model?: ImageModel;
    size?: string;
    quality?: string;
  },
) {
  return httpRequest<{ task: ImageTask; conversation: CreativeConversation }>(
    `/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", body: input },
  );
}

export type LocalImageToolResult = {
  ok: boolean;
  url: string;
  path: string;
  content_type: string;
  width: number;
  height: number;
  original_bytes: number;
  output_bytes: number;
  asset_id: string;
  version_id: string;
};

export async function runAiImageTool(input: {
  file: File;
  operation: string;
  instruction?: string;
  model?: ImageModel;
  size?: string;
  quality?: string;
  project_id?: string;
}) {
  const form = new FormData();
  form.append("image", input.file);
  form.append("operation", input.operation);
  form.append("instruction", input.instruction || "");
  form.append("model", input.model || USER_DEFAULT_IMAGE_MODEL);
  form.append("size", input.size || "1024x1024");
  form.append("quality", input.quality || "auto");
  form.append("project_id", input.project_id || "");
  return httpRequest<ImageTask>("/api/workspace/tools/ai", {
    method: "POST",
    body: form,
  });
}

export async function reverseImagePrompt(input: {
  file?: File;
  asset_id?: string;
  version_id?: string;
  detail?: "concise" | "standard" | "professional";
  purpose?: string;
}) {
  const form = new FormData();
  if (input.file) form.append("image", input.file);
  if (input.asset_id) form.append("asset_id", input.asset_id);
  if (input.version_id) form.append("version_id", input.version_id);
  form.append("detail", input.detail || "standard");
  form.append("purpose", input.purpose || "");
  return httpRequest<ReversePromptResult>(
    "/api/workspace/tools/reverse-prompt",
    { method: "POST", body: form },
  );
}

export async function runLocalImageTool(input: {
  file: File;
  operation: "resize" | "compress" | "convert";
  width?: number;
  height?: number;
  quality?: number;
  output_format?: "png" | "jpg" | "webp";
  project_id?: string;
}) {
  const form = new FormData();
  form.append("image", input.file);
  form.append("operation", input.operation);
  form.append("width", String(input.width || 0));
  form.append("height", String(input.height || 0));
  form.append("quality", String(input.quality || 82));
  form.append("output_format", input.output_format || "png");
  form.append("project_id", input.project_id || "");
  return httpRequest<LocalImageToolResult>("/api/workspace/tools/local", {
    method: "POST",
    body: form,
  });
}

export async function fetchCreativePolicies() {
  return httpRequest<{ items: CreativePolicy[] }>(
    "/api/workspace/admin/policies",
  );
}

export async function updateCreativePolicy(
  subjectId: string,
  input: Omit<CreativePolicy, "subject_id" | "updated_at">,
) {
  return httpRequest<CreativePolicy>(
    `/api/workspace/admin/policies/${encodeURIComponent(subjectId)}`,
    {
      method: "PUT",
      body: input,
    },
  );
}

export async function updateUserQuotaBatch(input: {
  user_ids: string[];
  mode: "set" | "add";
  amount: number;
}) {
  return httpRequest<{
    updated: UserAccount[];
    missing_ids: string[];
    items: UserAccount[];
  }>("/api/workspace/admin/users/quota-batch", { method: "POST", body: input });
}

export async function fetchCreativeRecipes(category = "") {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  return httpRequest<{ items: CreativeRecipe[] }>(
    `/api/workspace/recipes${params.size ? `?${params}` : ""}`,
  );
}

export async function createCreativeRecipe(input: {
  name: string;
  category?: string;
  description?: string;
  settings: Record<string, unknown>;
  scope_type?: "private" | "group" | "global";
  scope_id?: string;
}) {
  return httpRequest<CreativeRecipe>("/api/workspace/recipes", {
    method: "POST",
    body: input,
  });
}

export async function deleteCreativeRecipe(recipeId: string) {
  return httpRequest<{ ok: boolean }>(
    `/api/workspace/recipes/${encodeURIComponent(recipeId)}`,
    { method: "DELETE" },
  );
}

export async function fetchConsistencyProfiles(profileType = "") {
  const params = new URLSearchParams();
  if (profileType) params.set("profile_type", profileType);
  return httpRequest<{ items: ConsistencyProfile[] }>(
    `/api/workspace/profiles${params.size ? `?${params}` : ""}`,
  );
}

export async function fetchStoredCreativeImageFile(
  path: string,
  name = "reference.png",
) {
  const normalized = path.replace(/^\/+/, "").replace(/^images\//, "");
  const response = await request.get(`/images/${normalized}`, {
    responseType: "blob",
  });
  const blob = response.data as Blob;
  if (!blob.size) throw new Error("一致性参考图为空");
  return new File([blob], name, { type: blob.type || "image/png" });
}

export async function createConsistencyProfile(input: {
  profile_type: ConsistencyProfile["profile_type"];
  name: string;
  instructions?: string;
  colors?: string;
  fonts?: string;
  default_strength?: ConsistencyStrength;
  logos?: File[];
  references?: File[];
}) {
  const form = new FormData();
  form.append("profile_type", input.profile_type);
  form.append("name", input.name);
  form.append("instructions", input.instructions || "");
  form.append("colors", input.colors || "");
  form.append("fonts", input.fonts || "");
  form.append("default_strength", input.default_strength || "balanced");
  input.logos?.forEach((file) => form.append("logos", file));
  input.references?.forEach((file) => form.append("references", file));
  return httpRequest<ConsistencyProfile>("/api/workspace/profiles", {
    method: "POST",
    body: form,
  });
}

export async function deleteConsistencyProfile(profileId: string) {
  return httpRequest<{ ok: boolean }>(
    `/api/workspace/profiles/${encodeURIComponent(profileId)}`,
    { method: "DELETE" },
  );
}

export async function saveCanvasVersion(input: {
  asset_id: string;
  image: File;
  prompt?: string;
  operation?: string;
  parent_version_id?: string;
  params?: Record<string, unknown>;
}) {
  const form = new FormData();
  form.append("image", input.image);
  form.append("prompt", input.prompt || "");
  form.append("operation", input.operation || "canvas");
  form.append("parent_version_id", input.parent_version_id || "");
  form.append("params", JSON.stringify(input.params || {}));
  return httpRequest<CreativeAsset>(
    `/api/workspace/assets/${encodeURIComponent(input.asset_id)}/versions/local`,
    { method: "POST", body: form },
  );
}

export async function deleteCreativeVersion(
  assetId: string,
  versionId: string,
) {
  return httpRequest<{ ok: boolean }>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}`,
    { method: "DELETE" },
  );
}

export async function searchCreativeAssets(
  filters: {
    query?: string;
    person?: string;
    color?: string;
    style?: string;
    date_from?: string;
    date_to?: string;
    similar_to?: string;
    limit?: number;
  } = {},
) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  return httpRequest<{ items: CreativeAsset[] }>(
    `/api/workspace/search/assets${params.size ? `?${params}` : ""}`,
  );
}

export async function analyzeCreativeAsset(assetId: string) {
  return httpRequest<{
    asset_id: string;
    metadata: Record<string, unknown>;
    tags: string[];
  }>(`/api/workspace/assets/${encodeURIComponent(assetId)}/analyze`, {
    method: "POST",
    body: {},
  });
}

export async function createAssetShare(
  assetId: string,
  versionId = "",
  expiresDays = 7,
) {
  return httpRequest<{
    token: string;
    asset_id: string;
    version_id: string;
    expires_at: string;
  }>(`/api/workspace/assets/${encodeURIComponent(assetId)}/shares`, {
    method: "POST",
    body: { version_id: versionId, expires_days: expiresDays },
  });
}

export async function fetchPublicCreativeShare(token: string) {
  return httpRequest<PublicCreativeShare>(
    `/api/shared/${encodeURIComponent(token)}`,
  );
}

export async function downloadPublicCreativeShare(token: string, name: string) {
  const response = await request.get(
    `/api/shared/${encodeURIComponent(token)}/download`,
    { responseType: "blob" },
  );
  const url = URL.createObjectURL(response.data as Blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.replace(/[\\/:*?"<>|]+/g, "-") || "xg-share"}.png`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export async function submitAssetReview(assetId: string, versionId: string) {
  return httpRequest<CreativeReview>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/reviews`,
    { method: "POST", body: { version_id: versionId } },
  );
}

export async function fetchCreativeReviews(status = "") {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  return httpRequest<{ items: CreativeReview[] }>(
    `/api/workspace/reviews${params.size ? `?${params}` : ""}`,
  );
}

export async function resolveCreativeReview(
  reviewId: string,
  status: "approved" | "rejected",
  comment = "",
) {
  return httpRequest<CreativeReview>(
    `/api/workspace/reviews/${encodeURIComponent(reviewId)}`,
    { method: "PATCH", body: { status, comment } },
  );
}

export async function fetchCreativeTrash() {
  return httpRequest<{ items: CreativeTrashItem[] }>("/api/workspace/trash");
}

export async function restoreCreativeTrash(trashId: string) {
  return httpRequest<{ ok: boolean }>(
    `/api/workspace/trash/${encodeURIComponent(trashId)}/restore`,
    { method: "POST", body: {} },
  );
}

export async function purgeCreativeTrash(trashId: string) {
  return httpRequest<{ ok: boolean }>(
    `/api/workspace/trash/${encodeURIComponent(trashId)}`,
    { method: "DELETE" },
  );
}

export async function fetchCreativeAudits(
  filters: {
    action?: string;
    actor_id?: string;
    limit?: number;
  } = {},
) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  return httpRequest<{ items: CreativeAudit[] }>(
    `/api/workspace/admin/audits${params.size ? `?${params}` : ""}`,
  );
}

export async function downloadAssetDelivery(
  assetId: string,
  mode: "original" | "current" | "all" | "delivery" = "delivery",
  name = "xg-delivery",
) {
  const response = await request.get(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/delivery?mode=${mode}`,
    { responseType: "blob" },
  );
  const url = URL.createObjectURL(response.data as Blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.replace(/[\\/:*?"<>|]+/g, "-") || "xg-delivery"}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export async function indexCreativeAssetVersion(
  assetId: string,
  versionId = "",
) {
  return httpRequest<{
    asset_id: string;
    version_id: string;
    status: string;
    dimension: number;
  }>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/intelligence/index`,
    { method: "POST", body: { version_id: versionId } },
  );
}

export async function indexCreativeHistory(limit = 500) {
  return httpRequest<{
    indexed: string[];
    failed: Array<{ version_id: string; error: string }>;
    total: number;
  }>(`/api/workspace/intelligence/index-history?limit=${limit}`, {
    method: "POST",
    body: {},
  });
}

export async function semanticSearchCreativeAssets(
  query: string,
  filters: {
    project_id?: string;
    asset_type?: string;
    minimum_score?: number;
    limit?: number;
  } = {},
) {
  const params = new URLSearchParams({ query });
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  return httpRequest<{ items: SemanticCreativeAsset[] }>(
    `/api/workspace/search/semantic?${params}`,
  );
}

export async function fetchCreativeQuality(assetId: string, versionId = "") {
  const params = versionId
    ? `?version_id=${encodeURIComponent(versionId)}`
    : "";
  return httpRequest<CreativeQualityReview>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/quality${params}`,
  );
}

export async function scoreCreativeQuality(assetId: string, versionId = "") {
  return httpRequest<CreativeQualityReview>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/quality`,
    { method: "POST", body: { version_id: versionId } },
  );
}

export async function rankCreativeAssets(assetIds: string[]) {
  return httpRequest<{
    items: Array<{
      asset_id: string;
      name: string;
      version_id: string;
      image_path: string;
      image_url: string;
      quality: CreativeQualityReview | null;
      overall: number;
    }>;
  }>("/api/workspace/assets/quality/rank", {
    method: "POST",
    body: { asset_ids: assetIds },
  });
}

export async function queueCreativeQualityRanking(assetIds: string[]) {
  return httpRequest<{
    queued: string[];
    skipped: string[];
    failed: Array<{ asset_id: string; error: string }>;
    total: number;
  }>("/api/workspace/assets/quality/queue", {
    method: "POST",
    body: { asset_ids: assetIds },
  });
}

export async function fetchCreativeDerivatives(assetId: string) {
  return httpRequest<{ items: CreativeDerivative[] }>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/derivatives`,
  );
}

export async function createCreativeDerivatives(
  assetId: string,
  input: {
    version_id?: string;
    presets: CreativeDerivative["preset"][];
    mode: CreativeDerivative["mode"];
  },
) {
  return httpRequest<{ items: CreativeDerivative[] }>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/derivatives`,
    { method: "POST", body: input },
  );
}

export async function fetchCreativeVersionTree(assetId: string) {
  return httpRequest<CreativeVersionTree>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/version-tree`,
  );
}

export async function createCreativeBranch(
  assetId: string,
  input: {
    name: string;
    root_version_id?: string;
    metadata?: Record<string, unknown>;
  },
) {
  return httpRequest<CreativeBranch>(
    `/api/workspace/assets/${encodeURIComponent(assetId)}/branches`,
    { method: "POST", body: input },
  );
}

export async function fetchCreativeBoards() {
  return httpRequest<{ items: CreativeBoard[] }>("/api/workspace/boards");
}

export async function fetchCreativeBoard(boardId: string) {
  return httpRequest<CreativeBoard>(
    `/api/workspace/boards/${encodeURIComponent(boardId)}`,
  );
}

export async function createCreativeBoard(input: {
  name: string;
  description?: string;
  project_id?: string;
}) {
  return httpRequest<CreativeBoard>("/api/workspace/boards", {
    method: "POST",
    body: input,
  });
}

export async function updateCreativeBoard(
  boardId: string,
  updates: { name?: string; description?: string; project_id?: string },
) {
  return httpRequest<CreativeBoard>(
    `/api/workspace/boards/${encodeURIComponent(boardId)}`,
    { method: "PATCH", body: updates },
  );
}

export async function deleteCreativeBoard(boardId: string) {
  return httpRequest<{ ok: boolean }>(
    `/api/workspace/boards/${encodeURIComponent(boardId)}`,
    { method: "DELETE" },
  );
}

export async function addCreativeBoardItem(
  boardId: string,
  input: Omit<
    CreativeBoardItem,
    "id" | "board_id" | "created_at" | "updated_at"
  >,
) {
  return httpRequest<CreativeBoardItem>(
    `/api/workspace/boards/${encodeURIComponent(boardId)}/items`,
    { method: "POST", body: input },
  );
}

export async function uploadCreativeBoardItem(
  boardId: string,
  file: File,
  position: { x?: number; y?: number } = {},
) {
  const form = new FormData();
  form.append("image", file);
  form.append("item_type", "reference");
  form.append("x", String(position.x ?? 40));
  form.append("y", String(position.y ?? 40));
  return httpRequest<CreativeBoardItem>(
    `/api/workspace/boards/${encodeURIComponent(boardId)}/items/upload`,
    { method: "POST", body: form },
  );
}

export async function updateCreativeBoardItem(
  boardId: string,
  itemId: string,
  updates: Partial<
    Pick<
      CreativeBoardItem,
      "content" | "x" | "y" | "width" | "height" | "z_index" | "metadata"
    >
  >,
) {
  return httpRequest<CreativeBoardItem>(
    `/api/workspace/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}`,
    { method: "PATCH", body: updates },
  );
}

export async function deleteCreativeBoardItem(boardId: string, itemId: string) {
  return httpRequest<{ ok: boolean }>(
    `/api/workspace/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}`,
    { method: "DELETE" },
  );
}

export async function fetchCreativeBoardDraft(boardId: string) {
  return httpRequest<{
    board_id: string;
    project_id?: string | null;
    prompt: string;
    references: Array<{ path: string; url: string }>;
  }>(`/api/workspace/boards/${encodeURIComponent(boardId)}/draft`);
}

export async function fetchCreativeNotifications(limit = 50) {
  return httpRequest<{ items: CreativeNotification[] }>(
    `/api/workspace/notifications?limit=${limit}`,
  );
}

export async function markCreativeNotificationsRead(notificationId = "") {
  const params = notificationId
    ? `?notification_id=${encodeURIComponent(notificationId)}`
    : "";
  return httpRequest<{ updated: number }>(
    `/api/workspace/notifications/read${params}`,
    { method: "POST", body: {} },
  );
}

export async function fetchCreativeNotificationSettings() {
  return httpRequest<CreativeNotificationSettings>(
    "/api/workspace/notifications/settings",
  );
}

export async function updateCreativeNotificationSettings(
  updates: Partial<CreativeNotificationSettings>,
) {
  return httpRequest<CreativeNotificationSettings>(
    "/api/workspace/notifications/settings",
    { method: "PATCH", body: updates },
  );
}

export async function testCreativeNotification() {
  return httpRequest<CreativeNotification>(
    "/api/workspace/notifications/test",
    {
      method: "POST",
      body: {},
    },
  );
}

export async function fetchCreativeProjectBudget(projectId: string) {
  return httpRequest<CreativeProjectBudget>(
    `/api/workspace/projects/${encodeURIComponent(projectId)}/budget`,
  );
}

export async function updateCreativeProjectBudget(
  projectId: string,
  input: {
    owner_id: string;
    credit_limit: number;
    budget_type: "project" | "department" | "client";
    label?: string;
    warning_percent?: number;
    unit_cost?: number;
    enabled?: boolean;
  },
) {
  return httpRequest<CreativeProjectBudget>(
    `/api/workspace/admin/projects/${encodeURIComponent(projectId)}/budget`,
    { method: "PUT", body: input },
  );
}

export async function fetchAdminCreativeProjectBudget(projectId: string) {
  return httpRequest<CreativeProjectBudget>(
    `/api/workspace/admin/projects/${encodeURIComponent(projectId)}/budget`,
  );
}

export async function fetchAllCreativeProjectBudgets() {
  return httpRequest<{ items: CreativeProjectBudget[] }>(
    "/api/workspace/admin/budgets",
  );
}

export async function fetchCreativeBudgetProjects() {
  return httpRequest<{
    items: Array<{
      id: string;
      owner_id: string;
      name: string;
      description: string;
      asset_count: number;
      updated_at: string;
    }>;
  }>("/api/workspace/admin/budget-projects");
}

export async function downloadProjectDelivery(
  projectId: string,
  name = "xg-project-delivery",
) {
  const response = await request.get(
    `/api/workspace/projects/${encodeURIComponent(projectId)}/delivery`,
    { responseType: "blob" },
  );
  const url = URL.createObjectURL(response.data as Blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.replace(/[\\/:*?"<>|]+/g, "-") || "xg-project-delivery"}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export type OperationsPagination = {
  limit: number;
  offset: number;
  total: number;
};

export type SchedulerAccount = {
  email: string;
  status: string;
  quota: number;
  inflight: number;
  concurrency_limit: number;
  circuit_state: string;
  average_duration_secs: number;
  success_rate: number | null;
  health_score: number;
  scheduler_score: number;
  scheduler_rank: number;
  selection_reason: string;
  scheduler_factors: Record<string, number>;
};

export type QuotaLedgerEvent = {
  id: string;
  task_id: string;
  action: "allocate" | "adjust" | "reserve" | "consume" | "refund";
  amount: number;
  balance_before: number;
  balance_after: number;
  used_before: number;
  used_after: number;
  reason: string;
  created_at: string;
  owner_id: string;
  owner_name: string;
  username?: string | null;
};

export type TaskTimeline = {
  task_id: string;
  status: string;
  current_stage: string;
  total_duration_ms: number;
  items: Array<{
    stage: string;
    status: string;
    created_at: string;
    created_ts: number;
    duration_ms?: number;
    detail?: string;
  }>;
};

export type ModelRouteResult = {
  model: string;
  mode: string;
  confidence: number;
  reasons: string[];
  available_models: string[];
  policy: string;
};

export type PromptTemplate = {
  id: string;
  name: string;
  template: string;
  variables: Record<string, unknown>;
  preview_total?: number;
  created_at: string;
  updated_at: string;
};

export type ScheduledGeneration = {
  id: string;
  owner_id: string;
  prompts: string[];
  model: string;
  size: string;
  quality: string;
  project_id: string;
  run_at: string;
  low_peak_only: boolean;
  window_start: number;
  window_end: number;
  status: string;
  attempts: number;
  result_task_ids: string[];
  error: string;
  created_at: string;
  updated_at: string;
};

export type LocalEditSuggestion = {
  model: string;
  elapsed_ms: number;
  global_suggestion: string;
  regions: Array<{
    id: string;
    type: "person" | "product" | "text" | "logo" | "background";
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
    confidence: number;
    issue: string;
    suggestion: string;
  }>;
};

export type UsabilityMetrics = {
  reviewed: number;
  usable: number;
  usable_rate: number;
  consumed_credits: number;
  credits_per_usable: number | null;
  asset_count: number;
  top_issues: Array<{ label: string; count: number }>;
};

export type AssetProvenance = {
  version_id: string;
  asset_id: string;
  task_id: string;
  model: string;
  prompt: string;
  prompt_sha256: string;
  reference_files: Array<{ name: string; sha256: string }>;
  operation: string;
  created_by: string;
  created_at: string;
  metadata: Record<string, unknown>;
};

type DataEnvelope<T> = { data: T; pagination?: OperationsPagination };

export async function fetchSchedulerOverview() {
  return httpRequest<
    DataEnvelope<{
      accounts: SchedulerAccount[];
      total_slots: number;
      used_slots: number;
      cooling_accounts: number;
      strategy: string;
    }>
  >("/api/operations/accounts/scheduler");
}

export async function fetchQuotaLedger(
  params: {
    owner_id?: string;
    action?: string;
    task_id?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return httpRequest<DataEnvelope<QuotaLedgerEvent[]>>(
    `/api/operations/quota-ledger${query.size ? `?${query}` : ""}`,
  );
}

export async function fetchTaskTimeline(taskId: string) {
  return httpRequest<DataEnvelope<TaskTimeline>>(
    `/api/operations/tasks/${encodeURIComponent(taskId)}/timeline`,
  );
}

export async function routeImageModel(input: {
  mode: string;
  prompt: string;
  reference_count?: number;
  has_mask?: boolean;
  quality?: string;
  available_models?: string[];
}) {
  return httpRequest<DataEnvelope<ModelRouteResult>>(
    "/api/operations/model-route",
    { method: "POST", body: input },
  );
}

export async function renderPromptTemplate(input: {
  template: string;
  variables: Record<string, unknown>;
}) {
  return httpRequest<
    DataEnvelope<{ variables: string[]; items: string[]; total: number }>
  >("/api/operations/prompt-templates/render", {
    method: "POST",
    body: input,
  });
}

export async function fetchPromptTemplates() {
  return httpRequest<DataEnvelope<PromptTemplate[]>>(
    "/api/operations/prompt-templates",
  );
}

export async function savePromptTemplate(input: {
  name: string;
  template: string;
  variables: Record<string, unknown>;
}) {
  return httpRequest<DataEnvelope<PromptTemplate>>(
    "/api/operations/prompt-templates",
    { method: "POST", body: input },
  );
}

export async function deletePromptTemplate(templateId: string) {
  return httpRequest<DataEnvelope<{ ok: boolean }>>(
    `/api/operations/prompt-templates/${encodeURIComponent(templateId)}`,
    { method: "DELETE" },
  );
}

export async function fetchGenerationSchedules(limit = 50, offset = 0) {
  return httpRequest<DataEnvelope<ScheduledGeneration[]>>(
    `/api/operations/schedules?limit=${limit}&offset=${offset}`,
  );
}

export async function createGenerationSchedule(input: {
  prompts?: string[];
  template?: string;
  variables?: Record<string, unknown>;
  model?: string;
  size?: string;
  quality?: string;
  project_id?: string;
  run_at: string;
  low_peak_only?: boolean;
  window_start?: number;
  window_end?: number;
}) {
  return httpRequest<DataEnvelope<ScheduledGeneration>>(
    "/api/operations/schedules",
    { method: "POST", body: input },
  );
}

export async function cancelGenerationSchedule(scheduleId: string) {
  return httpRequest<DataEnvelope<{ ok: boolean }>>(
    `/api/operations/schedules/${encodeURIComponent(scheduleId)}`,
    { method: "DELETE" },
  );
}

export async function analyzeLocalEditSuggestions(
  image: File,
  instruction = "",
) {
  const form = new FormData();
  form.append("image", image);
  form.append("instruction", instruction);
  return httpRequest<DataEnvelope<LocalEditSuggestion>>(
    "/api/operations/local-edit/suggestions",
    { method: "POST", body: form },
  );
}

export async function fetchUsabilityMetrics(ownerId = "") {
  const query = ownerId ? `?owner_id=${encodeURIComponent(ownerId)}` : "";
  return httpRequest<DataEnvelope<UsabilityMetrics>>(
    `/api/operations/analytics/usability${query}`,
  );
}

export async function fetchReviewComments(reviewId: string) {
  return httpRequest<DataEnvelope<Array<Record<string, unknown>>>>(
    `/api/operations/reviews/${encodeURIComponent(reviewId)}/comments`,
  );
}

export async function addReviewComment(reviewId: string, body: string) {
  return httpRequest<DataEnvelope<Record<string, unknown>>>(
    `/api/operations/reviews/${encodeURIComponent(reviewId)}/comments`,
    { method: "POST", body: { body } },
  );
}

export async function addReviewAnnotation(
  reviewId: string,
  input: {
    label?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    body?: string;
  },
) {
  return httpRequest<DataEnvelope<Record<string, unknown>>>(
    `/api/operations/reviews/${encodeURIComponent(reviewId)}/annotations`,
    { method: "POST", body: input },
  );
}

export async function confirmReviewDelivery(
  reviewId: string,
  decision: "approved" | "changes_requested",
  comment = "",
) {
  return httpRequest<DataEnvelope<Record<string, unknown>>>(
    `/api/operations/reviews/${encodeURIComponent(reviewId)}/confirm`,
    { method: "POST", body: { decision, comment } },
  );
}

export async function fetchAssetProvenance(assetId: string, ownerId = "") {
  const query = ownerId ? `?owner_id=${encodeURIComponent(ownerId)}` : "";
  return httpRequest<DataEnvelope<AssetProvenance[]>>(
    `/api/operations/provenance/${encodeURIComponent(assetId)}${query}`,
  );
}

export async function verifyDisasterBackup(key: string) {
  return httpRequest<
    DataEnvelope<{
      id: string;
      restore_token: string;
      token_expires_at: string;
      confirmation_required: string;
      detail: Record<string, unknown>;
    }>
  >("/api/operations/disaster/verify", {
    method: "POST",
    body: { key },
  });
}

export async function restoreDisasterBackup(input: {
  run_id: string;
  restore_token: string;
  confirmation: string;
}) {
  return httpRequest<
    DataEnvelope<{
      ok: boolean;
      restored_files: number;
      rollback_path: string;
      requires_restart: boolean;
    }>
  >("/api/operations/disaster/restore", {
    method: "POST",
    body: input,
  });
}
