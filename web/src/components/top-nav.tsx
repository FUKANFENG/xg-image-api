"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, MoreHorizontal, Sparkles } from "lucide-react";
import { usePathname } from "next/navigation";

import { HeaderActions } from "@/components/header-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import webConfig from "@/constants/common-env";
import {
  fetchThirdPartyApps,
  type ThirdPartyAppsSettings,
} from "@/lib/api";
import {
  isAdminRole,
  isAuthEntryRoute,
  isRouteActive,
} from "@/lib/role-routes";
import { DIRECT_ADMIN_SESSION } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

type AdminNavItem = {
  href: string;
  label: string;
  activeHref?: string;
};

const primaryAdminNavItems: AdminNavItem[] = [
  { href: "/console", label: "API 总览" },
  { href: "/image", label: "生图测试" },
  { href: "/settings?tab=api-docs", activeHref: "/settings", label: "API 接入" },
  { href: "/accounts", label: "账号池" },
  { href: "/monitor", label: "运行状态" },
];

const advancedAdminNavGroups: Array<{
  label: string;
  items: AdminNavItem[];
}> = [
  {
    label: "运维管理",
    items: [
      { href: "/queue", label: "队列控制" },
      { href: "/users", label: "用户管理" },
      { href: "/image-manager", label: "图片管理" },
      { href: "/logs", label: "日志管理" },
      { href: "/settings", label: "系统设置" },
      { href: "/debug", label: "功能调试" },
    ],
  },
  {
    label: "高级功能",
    items: [
      { href: "/intelligence", label: "智能资产" },
      { href: "/operations", label: "运营中心" },
      { href: "/presets", label: "规范库" },
      { href: "/collaboration", label: "审核审计" },
    ],
  },
];

const advancedAdminNavItems = advancedAdminNavGroups.flatMap((group) => group.items);

function isAdminNavItemActive(pathname: string, item: AdminNavItem) {
  return isRouteActive(pathname, item.activeHref || item.href.split("?")[0]);
}

// Keep the third-party integration available in settings while removing its
// navigation entry from the administrator workspace during customization.
const SHOW_ADMIN_INFINITE_CANVAS = false;

function buildThirdPartyHref(appUrl: string, baseUrl: string, apiKey: string) {
  const url = appUrl.trim();
  try {
    const target = new URL(url);
    target.searchParams.set("apiKey", apiKey);
    target.searchParams.set("baseUrl", baseUrl);
    return target.toString();
  } catch {
    return `${url}${url.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(apiKey)}&baseUrl=${encodeURIComponent(baseUrl)}`;
  }
}

export function TopNav() {
  const pathname = usePathname();
  const isAuthRoute = isAuthEntryRoute(pathname);
  const session = DIRECT_ADMIN_SESSION;
  const [thirdPartyApps, setThirdPartyApps] =
    useState<ThirdPartyAppsSettings | null>(null);
  const [isCanvasDialogOpen, setIsCanvasDialogOpen] = useState(false);

  useEffect(() => {
    if (!session || !isAdminRole(session.role)) {
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const data = await fetchThirdPartyApps();
        if (active) {
          setThirdPartyApps(data.third_party_apps);
        }
      } catch {
        if (active) {
          setThirdPartyApps(null);
        }
      }
    };
    const reload = () => void load();

    void load();
    window.addEventListener("third-party-apps-updated", reload);
    return () => {
      active = false;
      window.removeEventListener("third-party-apps-updated", reload);
    };
  }, [session]);

  if (isAuthRoute) {
    return null;
  }

  const isAdmin = isAdminRole(session.role);
  const roleLabel = session.role === "admin" ? "管理员" : "普通用户";
  const displayName = session.name.trim() || roleLabel;
  const userDisplayName = session.name.trim() || "我的创作";
  const homeHref = isAdmin ? "/console" : "/studio";
  const baseUrl =
    webConfig.apiUrl.replace(/\/$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const canvas = thirdPartyApps?.infinite_canvas;
  const canvasHref =
    isAdmin && session.key && canvas?.enabled && canvas.url.trim()
      ? buildThirdPartyHref(canvas.url, baseUrl, session.key)
      : "";
  const canvasDisplayHref = canvasHref ? decodeURIComponent(canvasHref) : "";

  const handleCanvasOpen = () => {
    if (!canvasHref) {
      return;
    }
    setIsCanvasDialogOpen(true);
  };

  const confirmCanvasOpen = () => {
    if (canvasHref) {
      window.open(canvasHref, "_blank", "noopener,noreferrer");
    }
    setIsCanvasDialogOpen(false);
  };

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-stone-200/70 bg-white/90 shadow-[0_1px_0_rgba(28,25,23,0.02)] backdrop-blur-xl dark:border-white/10 dark:bg-stone-950/90">
        {isAdmin ? (
          <div className="flex min-h-12 flex-col gap-1 px-3 py-2 xl:h-12 xl:flex-row xl:items-center xl:justify-between xl:gap-3 xl:px-6 xl:py-0">
            <div className="flex items-center justify-between gap-2 xl:justify-start xl:gap-3">
              <Sheet>
                <SheetTrigger className="inline-flex size-8 items-center justify-center text-stone-700 transition hover:text-stone-950 xl:hidden dark:text-stone-200 dark:hover:text-white">
                  <Menu className="size-4" />
                  <span className="sr-only">打开导航</span>
                </SheetTrigger>
                <SheetContent side="left">
                  <SheetHeader>
                    <SheetTitle>XG生图</SheetTitle>
                    <span className="text-xs text-stone-500 dark:text-stone-400">
                      {roleLabel} · {displayName}
                    </span>
                  </SheetHeader>
                  <nav className="mt-8 flex flex-col gap-1">
                    {SHOW_ADMIN_INFINITE_CANVAS && canvasHref ? (
                      <SheetClose asChild>
                        <button
                          type="button"
                          className="flex items-center rounded-xl px-3 py-2.5 text-left text-sm font-medium text-stone-600 transition hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white"
                          onClick={handleCanvasOpen}
                        >
                          无限画布
                        </button>
                      </SheetClose>
                    ) : null}
                    <div className="px-3 pb-1 text-[11px] font-semibold tracking-[0.14em] text-stone-400 uppercase">
                      核心
                    </div>
                    {primaryAdminNavItems.map((item) => {
                      const active = isAdminNavItemActive(pathname, item);
                      const className = cn(
                        "flex items-center rounded-xl px-3 py-2.5 text-sm font-medium transition",
                        active
                          ? "bg-stone-950 text-white dark:bg-white dark:text-stone-950"
                          : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                      );
                      return (
                        <SheetClose asChild key={item.href}>
                          <Link
                            href={item.href}
                            className={className}
                            aria-current={active ? "page" : undefined}
                          >
                            {item.label}
                          </Link>
                        </SheetClose>
                      );
                    })}
                    {advancedAdminNavGroups.map((group) => (
                      <div key={group.label} className="mt-5">
                        <div className="px-3 pb-1 text-[11px] font-semibold tracking-[0.14em] text-stone-400 uppercase">
                          {group.label}
                        </div>
                        <div className="flex flex-col gap-1">
                          {group.items.map((item) => {
                            const active = isAdminNavItemActive(pathname, item);
                            return (
                              <SheetClose asChild key={item.href}>
                                <Link
                                  href={item.href}
                                  className={cn(
                                    "flex items-center rounded-xl px-3 py-2.5 text-sm font-medium transition",
                                    active
                                      ? "bg-stone-950 text-white dark:bg-white dark:text-stone-950"
                                      : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                                  )}
                                  aria-current={active ? "page" : undefined}
                                >
                                  {item.label}
                                </Link>
                              </SheetClose>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </nav>
                </SheetContent>
              </Sheet>
              <Link
                href={homeHref}
                className="inline-flex shrink-0 items-center gap-2 py-1 text-[15px] font-bold tracking-tight text-stone-950 transition hover:text-stone-700 dark:text-stone-50 dark:hover:text-white"
              >
                <span
                  aria-hidden="true"
                  className="grid size-6 place-items-center rounded-lg bg-violet-700 text-white shadow-sm"
                >
                  <Sparkles className="size-3.5" />
                </span>
                XG生图
              </Link>
              <HeaderActions
                className="ml-auto xl:hidden"
                showGithub={false}
                showVersion={false}
              />
            </div>
            <nav className="hide-scrollbar -mx-1 hidden min-w-0 flex-1 gap-1 overflow-x-auto px-1 xl:mx-0 xl:flex xl:justify-center xl:gap-6 xl:overflow-visible xl:px-0">
              {SHOW_ADMIN_INFINITE_CANVAS && canvasHref ? (
                <button
                  type="button"
                  onClick={handleCanvasOpen}
                  className="relative shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium text-stone-500 transition hover:text-stone-900 xl:rounded-none xl:px-0 xl:text-[15px] dark:text-stone-400 dark:hover:text-stone-100"
                >
                  无限画布
                </button>
              ) : null}
              {primaryAdminNavItems.map((item) => {
                const active = isAdminNavItemActive(pathname, item);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium transition xl:rounded-none xl:px-0 xl:text-[15px]",
                      active
                        ? "bg-violet-700 text-white xl:bg-violet-50 xl:px-3 xl:font-semibold xl:text-violet-800 dark:bg-violet-300 dark:text-stone-950 dark:xl:bg-violet-400/10 dark:xl:text-violet-200"
                        : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100",
                    )}
                  >
                    {item.label}
                    {active ? (
                      <span className="absolute inset-x-3 -bottom-[7px] hidden h-0.5 rounded-full bg-violet-600 dark:bg-violet-300 xl:block" />
                    ) : null}
                  </Link>
                );
              })}
              <Sheet>
                <SheetTrigger
                  className={cn(
                    "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium transition xl:rounded-none xl:px-0 xl:text-[15px]",
                    advancedAdminNavItems.some((item) => isAdminNavItemActive(pathname, item))
                      ? "text-violet-700 dark:text-violet-200"
                      : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100",
                  )}
                >
                  <MoreHorizontal className="size-4" />
                  更多
                </SheetTrigger>
                <SheetContent side="right">
                  <SheetHeader>
                    <SheetTitle>高级功能</SheetTitle>
                    <span className="text-xs leading-5 text-stone-500 dark:text-stone-400">
                      这些能力仍然保留，但不占用核心工作流导航。
                    </span>
                  </SheetHeader>
                  <nav className="mt-8 space-y-6">
                    {advancedAdminNavGroups.map((group) => (
                      <div key={group.label}>
                        <div className="px-3 pb-1 text-[11px] font-semibold tracking-[0.14em] text-stone-400 uppercase">
                          {group.label}
                        </div>
                        <div className="flex flex-col gap-1">
                          {group.items.map((item) => {
                            const active = isAdminNavItemActive(pathname, item);
                            return (
                              <SheetClose asChild key={item.href}>
                                <Link
                                  href={item.href}
                                  className={cn(
                                    "flex items-center rounded-xl px-3 py-2.5 text-sm font-medium transition",
                                    active
                                      ? "bg-stone-950 text-white dark:bg-white dark:text-stone-950"
                                      : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                                  )}
                                  aria-current={active ? "page" : undefined}
                                >
                                  {item.label}
                                </Link>
                              </SheetClose>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </nav>
                </SheetContent>
              </Sheet>
            </nav>
            <div className="hidden items-center justify-end gap-2 xl:flex xl:gap-3">
              <HeaderActions showGithub={false} showVersion={false} />
              <span className="hidden rounded-md bg-stone-100 px-2 py-1 text-[10px] font-medium text-stone-500 dark:bg-white/8 dark:text-stone-300 sm:inline-block sm:text-[11px]">
                {roleLabel} · {displayName}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex min-h-14 items-center justify-between gap-3 px-4 sm:min-h-16 sm:px-6">
            <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto sm:gap-2">
              <Link
                href={homeHref}
                className="inline-flex shrink-0 items-center gap-2 py-1 text-[15px] font-bold tracking-tight text-stone-950 transition hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:text-stone-50 dark:hover:text-white dark:focus-visible:ring-offset-stone-950"
              >
                <span
                  aria-hidden="true"
                  className="grid size-6 place-items-center rounded-lg bg-violet-700 text-white shadow-sm"
                >
                  <Sparkles className="size-3.5" />
                </span>
                XG生图
              </Link>
              <Link
                href="/batch"
                aria-current={pathname === "/batch" ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 sm:px-3 dark:focus-visible:ring-offset-stone-950",
                  pathname === "/batch"
                    ? "bg-violet-50 text-violet-800 dark:bg-violet-400/15 dark:text-violet-100"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                批量
              </Link>
              <Link
                href="/queue"
                aria-current={pathname === "/queue" ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 sm:px-3 dark:focus-visible:ring-offset-stone-950",
                  pathname === "/queue"
                    ? "bg-violet-50 text-violet-800 dark:bg-violet-400/15 dark:text-violet-100"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                队列
              </Link>
              <Link
                href="/presets"
                aria-current={pathname === "/presets" ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 sm:px-3 dark:focus-visible:ring-offset-stone-950",
                  pathname === "/presets"
                    ? "bg-violet-50 text-violet-800 dark:bg-violet-400/15 dark:text-violet-100"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                规范
              </Link>
              <Link
                href="/collaboration"
                aria-current={
                  pathname === "/collaboration" ? "page" : undefined
                }
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 sm:px-3 dark:focus-visible:ring-offset-stone-950",
                  pathname === "/collaboration"
                    ? "bg-violet-50 text-violet-800 dark:bg-violet-400/15 dark:text-violet-100"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                交付
              </Link>
              <Link
                href="/projects"
                aria-current={
                  isRouteActive(pathname, "/projects") ? "page" : undefined
                }
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 sm:px-3 dark:focus-visible:ring-offset-stone-950",
                  isRouteActive(pathname, "/projects")
                    ? "bg-violet-50 text-violet-800 dark:bg-violet-400/15 dark:text-violet-100"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                项目
              </Link>
              <Link
                href="/intelligence"
                aria-current={
                  isRouteActive(pathname, "/intelligence") ? "page" : undefined
                }
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 sm:px-3 dark:focus-visible:ring-offset-stone-950",
                  isRouteActive(pathname, "/intelligence")
                    ? "bg-violet-50 text-violet-800 dark:bg-violet-400/15 dark:text-violet-100"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                智能资产
              </Link>
              <Link
                href="/operations"
                aria-current={
                  isRouteActive(pathname, "/operations") ? "page" : undefined
                }
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 sm:px-3 dark:focus-visible:ring-offset-stone-950",
                  isRouteActive(pathname, "/operations")
                    ? "bg-violet-50 text-violet-800 dark:bg-violet-400/15 dark:text-violet-100"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                运营中心
              </Link>
              <Link
                href="/tools"
                aria-current={pathname === "/tools" ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-950",
                  pathname === "/tools"
                    ? "bg-violet-50 text-violet-800 dark:bg-violet-400/15 dark:text-violet-100"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                PPT/PSD
              </Link>
              <Link
                href="/toolbox"
                aria-current={pathname === "/toolbox" ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 sm:px-3 dark:focus-visible:ring-offset-stone-950",
                  pathname === "/toolbox"
                    ? "bg-violet-50 text-violet-800 dark:bg-violet-400/15 dark:text-violet-100"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                图片工具
              </Link>
              <Link
                href="/restore"
                aria-current={
                  isRouteActive(pathname, "/restore") ? "page" : undefined
                }
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 sm:px-3 dark:focus-visible:ring-offset-stone-950",
                  isRouteActive(pathname, "/restore")
                    ? "bg-violet-50 text-violet-800 dark:bg-violet-400/15 dark:text-violet-100"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                <span className="sm:hidden">修复</span>
                <span className="hidden sm:inline">高清修复</span>
              </Link>
              <Link
                href="/inspiration"
                aria-current={pathname === "/inspiration" ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-950",
                  pathname === "/inspiration"
                    ? "bg-violet-50 text-violet-800 dark:bg-violet-400/15 dark:text-violet-100"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                <span className="sm:hidden">灵感</span>
                <span className="hidden sm:inline">灵感库</span>
              </Link>
            </div>
            <div className="flex min-w-0 items-center justify-end gap-2 sm:gap-3">
              <span
                title={userDisplayName}
                className="hidden max-w-28 truncate text-sm font-medium text-stone-600 dark:text-stone-300 sm:inline sm:max-w-52"
              >
                {userDisplayName}
              </span>
              <span
                aria-hidden="true"
                className="h-5 w-px shrink-0 bg-stone-200 dark:bg-white/15"
              />
            </div>
          </div>
        )}
      </header>
      {isAdmin && SHOW_ADMIN_INFINITE_CANVAS ? (
        <Dialog open={isCanvasDialogOpen} onOpenChange={setIsCanvasDialogOpen}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
            <DialogHeader className="gap-2">
              <DialogTitle>跳转到三方应用</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                该入口仅供个人测试使用，建议自行本机部署后再长期使用。跳转地址会默认带上本项目地址和当前密钥，用于自动填充连接信息；如果不放心，可以取消后手动前往应用并自行输入。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <div className="text-xs font-medium text-stone-500">
                完整跳转地址
              </div>
              <div className="max-h-28 overflow-auto break-all rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-xs leading-5 text-stone-700">
                {canvasDisplayHref}
              </div>
            </div>
            <DialogFooter className="pt-2">
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-xl border-stone-200 bg-white text-stone-700"
                >
                  取消
                </Button>
              </DialogClose>
              <Button
                type="button"
                className="rounded-xl bg-stone-950 text-white hover:bg-stone-800"
                onClick={confirmCanvasOpen}
              >
                继续跳转
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
