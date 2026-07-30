"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import {
  getDefaultRouteForRole,
  type AuthRole,
  type StoredAuthSession,
} from "@/store/auth";

type UseAuthGuardResult = {
  isCheckingAuth: boolean;
  session: StoredAuthSession | null;
};

export const DIRECT_ADMIN_SESSION: StoredAuthSession = {
  role: "admin",
  subjectId: "admin",
  name: "本机直连",
};

export function useAuthGuard(allowedRoles?: AuthRole[]): UseAuthGuardResult {
  const router = useRouter();
  const allowedRolesKey = (allowedRoles || []).join(",");
  const roleList = allowedRolesKey
    ? (allowedRolesKey.split(",") as AuthRole[])
    : [];
  const canOpen = roleList.length === 0 || roleList.includes("admin");

  useEffect(() => {
    if (!canOpen) {
      router.replace(getDefaultRouteForRole("admin"));
    }
  }, [canOpen, router]);

  return canOpen
    ? { isCheckingAuth: false, session: DIRECT_ADMIN_SESSION }
    : { isCheckingAuth: true, session: null };
}

export function useRedirectIfAuthenticated() {
  const router = useRouter();

  useEffect(() => {
    router.replace(getDefaultRouteForRole("admin"));
  }, [router]);

  return { isCheckingAuth: true };
}
