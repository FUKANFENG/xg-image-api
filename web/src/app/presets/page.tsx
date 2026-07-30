"use client";

import { ChangeEvent, useCallback, useEffect, useState } from "react";
import {
  BadgeCheck,
  BookOpen,
  Box,
  Building2,
  Camera,
  ImagePlus,
  LoaderCircle,
  Palette,
  Plus,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  createConsistencyProfile,
  createCreativeRecipe,
  deleteConsistencyProfile,
  deleteCreativeRecipe,
  fetchConsistencyProfiles,
  fetchCreativeRecipes,
  type ConsistencyProfile,
  type ConsistencyStrength,
  type CreativeRecipe,
} from "@/lib/api";
import { USER_DEFAULT_IMAGE_MODEL } from "@/lib/image-model-policy";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const recipeCategory: Record<string, string> = {
  ecommerce: "电商",
  portrait: "写真",
  poster: "海报",
  id_photo: "证件照",
  custom: "自定义",
};

const profileMeta = {
  brand: { label: "品牌", icon: Building2 },
  person: { label: "人物", icon: UserRound },
  product: { label: "产品", icon: Box },
  style: { label: "画风", icon: Palette },
} as const;

export default function PresetsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["user", "admin"]);
  const [recipes, setRecipes] = useState<CreativeRecipe[]>([]);
  const [profiles, setProfiles] = useState<ConsistencyProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"recipes" | "profiles">("recipes");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const [recipe, setRecipe] = useState({
    name: "",
    category: "custom",
    description: "",
    prompt: "",
    model: USER_DEFAULT_IMAGE_MODEL,
    size: "1024x1024",
    quality: "auto",
    restore_mode: "general",
    restore_strength: "standard",
    scope_type: "private" as "private" | "group" | "global",
    scope_id: "",
  });
  const [profile, setProfile] = useState({
    profile_type: "brand" as ConsistencyProfile["profile_type"],
    name: "",
    instructions: "",
    colors: "",
    fonts: "",
    default_strength: "balanced" as ConsistencyStrength,
  });
  const [logos, setLogos] = useState<File[]>([]);
  const [references, setReferences] = useState<File[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [recipeResult, profileResult] = await Promise.all([
        fetchCreativeRecipes(),
        fetchConsistencyProfiles(),
      ]);
      setRecipes(recipeResult.items);
      setProfiles(profileResult.items);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "配置库加载失败",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, session]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") !== "profiles")
      return;
    const timer = window.setTimeout(() => setTab("profiles"), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const createRecipe = async () => {
    if (!recipe.name.trim() || !recipe.prompt.trim()) {
      setError("请填写配方名称和提示词要求");
      return;
    }
    setSaving(true);
    try {
      await createCreativeRecipe({
        name: recipe.name.trim(),
        category: recipe.category,
        description: recipe.description.trim(),
        settings: {
          prompt: recipe.prompt.trim(),
          model: recipe.model,
          size: recipe.size,
          quality: recipe.quality,
          restore_mode: recipe.restore_mode,
          restore_strength: recipe.restore_strength,
        },
        scope_type: session?.role === "admin" ? recipe.scope_type : "private",
        scope_id: recipe.scope_type === "group" ? recipe.scope_id.trim() : "",
      });
      setRecipe((current) => ({
        ...current,
        name: "",
        description: "",
        prompt: "",
      }));
      setShowCreate(false);
      await load();
      toast.success("创作配方已保存");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "配方保存失败");
    } finally {
      setSaving(false);
    }
  };

  const createProfile = async () => {
    if (!profile.name.trim()) {
      setError("请填写一致性档案名称");
      return;
    }
    setSaving(true);
    try {
      await createConsistencyProfile({
        ...profile,
        name: profile.name.trim(),
        instructions: profile.instructions.trim(),
        logos,
        references,
      });
      setProfile((current) => ({
        ...current,
        name: "",
        instructions: "",
        colors: "",
        fonts: "",
      }));
      setLogos([]);
      setReferences([]);
      setShowCreate(false);
      await load();
      toast.success("一致性档案已保存");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "档案保存失败");
    } finally {
      setSaving(false);
    }
  };

  const selectFiles = (
    event: ChangeEvent<HTMLInputElement>,
    setter: (files: File[]) => void,
    limit: number,
  ) => {
    setter(
      Array.from(event.target.files || [])
        .filter((file) => file.type.startsWith("image/"))
        .slice(0, limit),
    );
  };

  if (isCheckingAuth || !session) {
    return (
      <main className="grid min-h-[70vh] place-items-center">
        <LoaderCircle className="size-7 animate-spin text-violet-700" />
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-stone-50 px-4 py-6 sm:px-6 lg:px-8 dark:bg-stone-950">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-5 rounded-3xl border border-stone-200 bg-white p-6 shadow-sm sm:flex-row sm:items-end sm:justify-between dark:border-white/10 dark:bg-stone-900">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-violet-50 px-3 py-1.5 text-sm font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
              <BookOpen className="size-4" /> 创作规范库
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-stone-950 sm:text-3xl dark:text-white">
              配方与一致性档案
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600 sm:text-base dark:text-stone-300">
              保存整套创作参数，固定品牌、人物、产品或画风；批量任务和二创可直接套用。
            </p>
          </div>
          <Button
            onClick={() => setShowCreate((value) => !value)}
            className="min-h-11 rounded-xl bg-violet-700 text-white hover:bg-violet-800"
          >
            <Plus className="size-4" />{" "}
            {showCreate
              ? "收起创建区"
              : tab === "recipes"
                ? "新建配方"
                : "新建档案"}
          </Button>
        </header>

        <div
          className="grid grid-cols-2 rounded-2xl bg-stone-200/70 p-1 dark:bg-white/10"
          role="tablist"
        >
          <button
            role="tab"
            aria-selected={tab === "recipes"}
            onClick={() => {
              setTab("recipes");
              setShowCreate(false);
            }}
            className={cn(
              "min-h-11 rounded-xl text-sm font-semibold transition",
              tab === "recipes"
                ? "bg-white text-violet-700 shadow-sm dark:bg-stone-900 dark:text-violet-200"
                : "text-stone-500 dark:text-stone-300",
            )}
          >
            创作配方 · {recipes.length}
          </button>
          <button
            role="tab"
            aria-selected={tab === "profiles"}
            onClick={() => {
              setTab("profiles");
              setShowCreate(false);
            }}
            className={cn(
              "min-h-11 rounded-xl text-sm font-semibold transition",
              tab === "profiles"
                ? "bg-white text-violet-700 shadow-sm dark:bg-stone-900 dark:text-violet-200"
                : "text-stone-500 dark:text-stone-300",
            )}
          >
            一致性档案 · {profiles.length}
          </button>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"
          >
            {error}
          </div>
        ) : null}

        {showCreate && tab === "recipes" ? (
          <section className="rounded-3xl border border-violet-200 bg-violet-50/60 p-5 dark:border-violet-400/20 dark:bg-violet-400/10">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <label className="text-sm font-medium">
                配方名称
                <input
                  value={recipe.name}
                  onChange={(event) =>
                    setRecipe({ ...recipe, name: event.target.value })
                  }
                  className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base dark:border-white/10 dark:bg-stone-950"
                  placeholder="新品主图"
                />
              </label>
              <label className="text-sm font-medium">
                分类
                <select
                  value={recipe.category}
                  onChange={(event) =>
                    setRecipe({ ...recipe, category: event.target.value })
                  }
                  className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 dark:border-white/10 dark:bg-stone-950"
                >
                  <option value="custom">自定义</option>
                  <option value="ecommerce">电商</option>
                  <option value="portrait">人物写真</option>
                  <option value="poster">海报</option>
                  <option value="id_photo">证件照</option>
                </select>
              </label>
              <label className="text-sm font-medium">
                模型
                <select
                  value={recipe.model}
                  onChange={(event) =>
                    setRecipe({ ...recipe, model: event.target.value })
                  }
                  className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 dark:border-white/10 dark:bg-stone-950"
                >
                  <option value="gpt-image-2">GPT Image 2</option>
                  <option value="codex-gpt-image-2">Codex Image 2</option>
                </select>
              </label>
              <label className="text-sm font-medium">
                尺寸
                <select
                  value={recipe.size}
                  onChange={(event) =>
                    setRecipe({ ...recipe, size: event.target.value })
                  }
                  className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 dark:border-white/10 dark:bg-stone-950"
                >
                  <option value="1024x1024">1:1 方图</option>
                  <option value="1536x1024">3:2 横图</option>
                  <option value="1024x1536">2:3 竖图</option>
                </select>
              </label>
              <label className="text-sm font-medium md:col-span-2 xl:col-span-3">
                提示词要求
                <textarea
                  value={recipe.prompt}
                  onChange={(event) =>
                    setRecipe({ ...recipe, prompt: event.target.value })
                  }
                  className="mt-2 min-h-24 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-base leading-6 dark:border-white/10 dark:bg-stone-950"
                  placeholder="主体、构图、光线、风格和必须保持的细节"
                />
              </label>
              <div className="grid gap-3">
                <label className="text-sm font-medium">
                  质量
                  <select
                    value={recipe.quality}
                    onChange={(event) =>
                      setRecipe({ ...recipe, quality: event.target.value })
                    }
                    className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 dark:border-white/10 dark:bg-stone-950"
                  >
                    <option value="auto">自动</option>
                    <option value="high">高质量</option>
                    <option value="medium">均衡</option>
                  </select>
                </label>
                {session.role === "admin" ? (
                  <label className="text-sm font-medium">
                    开放范围
                    <select
                      value={recipe.scope_type}
                      onChange={(event) =>
                        setRecipe({
                          ...recipe,
                          scope_type: event.target
                            .value as typeof recipe.scope_type,
                        })
                      }
                      className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 dark:border-white/10 dark:bg-stone-950"
                    >
                      <option value="private">仅自己</option>
                      <option value="group">指定用户组</option>
                      <option value="global">所有用户</option>
                    </select>
                  </label>
                ) : null}
              </div>
              <label className="text-sm font-medium md:col-span-2">
                说明
                <input
                  value={recipe.description}
                  onChange={(event) =>
                    setRecipe({ ...recipe, description: event.target.value })
                  }
                  className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base dark:border-white/10 dark:bg-stone-950"
                  placeholder="适用场景和使用提示"
                />
              </label>
              {session.role === "admin" && recipe.scope_type === "group" ? (
                <label className="text-sm font-medium">
                  用户组
                  <input
                    value={recipe.scope_id}
                    onChange={(event) =>
                      setRecipe({ ...recipe, scope_id: event.target.value })
                    }
                    className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base dark:border-white/10 dark:bg-stone-950"
                    placeholder="例如 design"
                  />
                </label>
              ) : null}
              <Button
                disabled={saving}
                onClick={() => void createRecipe()}
                className="min-h-11 self-end rounded-xl bg-violet-700 text-white"
              >
                <SaveIcon saving={saving} />
                保存配方
              </Button>
            </div>
          </section>
        ) : null}

        {showCreate && tab === "profiles" ? (
          <section className="rounded-3xl border border-violet-200 bg-violet-50/60 p-5 dark:border-violet-400/20 dark:bg-violet-400/10">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <label className="text-sm font-medium">
                档案类型
                <select
                  value={profile.profile_type}
                  onChange={(event) =>
                    setProfile({
                      ...profile,
                      profile_type: event.target
                        .value as ConsistencyProfile["profile_type"],
                    })
                  }
                  className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 dark:border-white/10 dark:bg-stone-950"
                >
                  <option value="brand">品牌</option>
                  <option value="person">人物</option>
                  <option value="product">产品</option>
                  <option value="style">画风</option>
                </select>
              </label>
              <label className="text-sm font-medium">
                档案名称
                <input
                  value={profile.name}
                  onChange={(event) =>
                    setProfile({ ...profile, name: event.target.value })
                  }
                  className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base dark:border-white/10 dark:bg-stone-950"
                  placeholder="XG 品牌规范"
                />
              </label>
              <label className="text-sm font-medium">
                品牌色板
                <input
                  value={profile.colors}
                  onChange={(event) =>
                    setProfile({ ...profile, colors: event.target.value })
                  }
                  className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base dark:border-white/10 dark:bg-stone-950"
                  placeholder="#7c3aed, #18181b"
                />
              </label>
              <label className="text-sm font-medium">
                字体规范
                <input
                  value={profile.fonts}
                  onChange={(event) =>
                    setProfile({ ...profile, fonts: event.target.value })
                  }
                  className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-base dark:border-white/10 dark:bg-stone-950"
                  placeholder="思源黑体, Inter"
                />
              </label>
              <label className="text-sm font-medium">
                默认一致性强度
                <select
                  value={profile.default_strength}
                  onChange={(event) =>
                    setProfile({
                      ...profile,
                      default_strength: event.target
                        .value as ConsistencyStrength,
                    })
                  }
                  className="mt-2 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 dark:border-white/10 dark:bg-stone-950"
                >
                  <option value="strict">严格 · 最大限度保持</option>
                  <option value="balanced">均衡 · 稳定创作</option>
                  <option value="creative">创意 · 允许变化</option>
                </select>
              </label>
              <label className="text-sm font-medium md:col-span-2 xl:col-span-4">
                一致性要求
                <textarea
                  value={profile.instructions}
                  onChange={(event) =>
                    setProfile({ ...profile, instructions: event.target.value })
                  }
                  className="mt-2 min-h-24 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-base leading-6 dark:border-white/10 dark:bg-stone-950"
                  placeholder="描述人物脸型、服装、产品结构、品牌视觉和绝对不能改变的内容"
                />
              </label>
              <UploadBox
                label="Logo / 标识"
                count={logos.length}
                help="最多 4 张"
                multiple
                onChange={(event) => selectFiles(event, setLogos, 4)}
              />
              <UploadBox
                label="一致性参考图"
                count={references.length}
                help="最多 8 张"
                multiple
                onChange={(event) => selectFiles(event, setReferences, 8)}
              />
              <Button
                disabled={saving}
                onClick={() => void createProfile()}
                className="min-h-11 self-end rounded-xl bg-violet-700 text-white md:col-span-2"
              >
                <SaveIcon saving={saving} />
                保存一致性档案
              </Button>
            </div>
          </section>
        ) : null}

        {loading ? (
          <div className="grid min-h-72 place-items-center rounded-3xl border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900">
            <LoaderCircle className="size-7 animate-spin text-violet-700" />
          </div>
        ) : tab === "recipes" ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {recipes.map((item) => (
              <article
                key={item.id}
                className="flex min-h-64 flex-col rounded-3xl border border-stone-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-stone-900"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="grid size-11 place-items-center rounded-2xl bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                    <Sparkles className="size-5" />
                  </span>
                  <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600 dark:bg-white/10 dark:text-stone-300">
                    {item.builtin
                      ? "系统"
                      : item.scope_type === "global"
                        ? "全员"
                        : item.scope_type === "group"
                          ? `组 · ${item.scope_id}`
                          : "私有"}
                  </span>
                </div>
                <h2 className="mt-4 text-lg font-bold">{item.name}</h2>
                <p className="mt-1 text-xs font-semibold text-violet-700">
                  {recipeCategory[item.category] || item.category}
                </p>
                <p className="mt-3 flex-1 text-sm leading-6 text-stone-500 dark:text-stone-300">
                  {item.description ||
                    String(item.settings.prompt || "完整创作参数已保存")}
                </p>
                <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-3 text-xs text-stone-500 dark:border-white/10">
                  <span>
                    {String(item.settings.size || "自动尺寸")} ·{" "}
                    {String(item.settings.quality || "auto")}
                  </span>
                  {!item.builtin ? (
                    <button
                      aria-label={`删除配方 ${item.name}`}
                      onClick={() =>
                        void deleteCreativeRecipe(item.id).then(load)
                      }
                      className="grid size-10 place-items-center rounded-xl text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-400/10"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  ) : (
                    <BadgeCheck className="size-4 text-emerald-600" />
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {profiles.map((item) => {
              const meta = profileMeta[item.profile_type];
              const Icon = meta.icon;
              return (
                <article
                  key={item.id}
                  className="flex min-h-64 flex-col rounded-3xl border border-stone-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-stone-900"
                >
                  <div className="flex items-start justify-between">
                    <span className="grid size-11 place-items-center rounded-2xl bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                      <Icon className="size-5" />
                    </span>
                    <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs dark:bg-white/10">
                      {meta.label}
                    </span>
                  </div>
                  <h2 className="mt-4 text-lg font-bold">{item.name}</h2>
                  <p className="mt-3 flex-1 text-sm leading-6 text-stone-500 dark:text-stone-300">
                    {item.instructions ||
                      "后续生成将自动携带参考图和固定规范。"}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {item.colors.map((color) => (
                      <span
                        key={color}
                        title={color}
                        className="size-6 rounded-full border border-black/10"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                    {item.reference_paths.length ? (
                      <span className="rounded-full bg-stone-100 px-2 py-1 text-xs dark:bg-white/10">
                        {item.reference_paths.length} 张参考图
                      </span>
                    ) : null}
                    <span className="rounded-full bg-violet-50 px-2 py-1 text-xs text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                      {item.default_strength === "strict"
                        ? "严格"
                        : item.default_strength === "creative"
                          ? "创意"
                          : "均衡"}
                    </span>
                  </div>
                  <div className="mt-4 flex justify-end border-t border-stone-100 pt-3 dark:border-white/10">
                    <button
                      aria-label={`删除档案 ${item.name}`}
                      onClick={() =>
                        void deleteConsistencyProfile(item.id).then(load)
                      }
                      className="grid size-10 place-items-center rounded-xl text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-400/10"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </article>
              );
            })}
            {!profiles.length ? (
              <div className="col-span-full rounded-3xl border border-dashed border-stone-200 bg-white py-16 text-center dark:border-white/10 dark:bg-stone-900">
                <Camera className="mx-auto size-10 text-stone-300" />
                <h2 className="mt-4 font-bold">还没有一致性档案</h2>
                <p className="mt-2 text-sm text-stone-500">
                  上传人物、产品或品牌参考图，后续创作会自动保持一致。
                </p>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}

function SaveIcon({ saving }: { saving: boolean }) {
  return saving ? (
    <LoaderCircle className="size-4 animate-spin" />
  ) : (
    <BadgeCheck className="size-4" />
  );
}

function UploadBox({
  label,
  help,
  count,
  multiple,
  onChange,
}: {
  label: string;
  help: string;
  count: number;
  multiple?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-violet-300 bg-white/80 text-center transition hover:border-violet-500 dark:bg-stone-950/70">
      <ImagePlus className="size-5 text-violet-700" />
      <span className="mt-2 text-sm font-semibold">{label}</span>
      <span className="mt-1 text-xs text-stone-500">
        {count ? `已选择 ${count} 张` : help}
      </span>
      <input
        type="file"
        accept="image/*"
        multiple={multiple}
        className="sr-only"
        onChange={onChange}
      />
    </label>
  );
}
