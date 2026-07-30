"use client";

import localforage from "localforage";

import type { AuthRole } from "@/lib/role-routes";

export { getDefaultRouteForRole, type AuthRole } from "@/lib/role-routes";

export type StoredAuthSession = {
  role: AuthRole;
  subjectId: string;
  name: string;
  imageQuota?: number | null;
  /** 仅为管理员现有 API/画布兼容保留；普通用户密码与会话令牌绝不写入浏览器存储。 */
  key?: string;
};

const LEGACY_AUTH_KEY_STORAGE_KEY = "chatgpt2api_auth_key";
export const AUTH_KEY_STORAGE_KEY = LEGACY_AUTH_KEY_STORAGE_KEY;
export const AUTH_SESSION_STORAGE_KEY = "chatgpt2api_auth_session";

const authStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "auth",
});

function normalizeSession(value: unknown, fallbackAdminKey = ""): StoredAuthSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<StoredAuthSession>;
  const role = candidate.role === "admin" || candidate.role === "user" ? candidate.role : null;
  if (!role) {
    return null;
  }

  const imageQuota = candidate.imageQuota === undefined || candidate.imageQuota === null ? Number.NaN : Number(candidate.imageQuota);
  const key = role === "admin" ? String(candidate.key || fallbackAdminKey || "").trim() : "";
  return {
    role,
    subjectId: String(candidate.subjectId || "").trim(),
    name: String(candidate.name || "").trim(),
    ...(Number.isFinite(imageQuota) && imageQuota >= 0 ? { imageQuota } : {}),
    ...(key ? { key } : {}),
  };
}

export async function getStoredAuthKey() {
  const session = await getStoredAuthSession();
  return session?.role === "admin" ? String(session.key || "").trim() : "";
}

export async function getStoredAuthSession() {
  if (typeof window === "undefined") {
    return null;
  }

  const [storedKey, storedSession] = await Promise.all([
    authStorage.getItem<string>(LEGACY_AUTH_KEY_STORAGE_KEY),
    authStorage.getItem<StoredAuthSession>(AUTH_SESSION_STORAGE_KEY),
  ]);
  const normalizedStoredKey = String(storedKey || "").trim();
  const normalizedSession = normalizeSession(storedSession, normalizedStoredKey);
  if (!normalizedSession) {
    if (storedSession || storedKey) {
      await clearStoredAuthSession();
    }
    return null;
  }

  if (normalizedSession.role !== "admin" || !normalizedSession.key) {
    if (normalizedStoredKey) {
      await authStorage.removeItem(LEGACY_AUTH_KEY_STORAGE_KEY);
    }
  } else if (normalizedSession.key !== normalizedStoredKey) {
    await authStorage.setItem(LEGACY_AUTH_KEY_STORAGE_KEY, normalizedSession.key);
  }
  return normalizedSession;
}

export async function setStoredAuthSession(session: StoredAuthSession) {
  const normalizedSession = normalizeSession(session);
  if (!normalizedSession) {
    await clearStoredAuthSession();
    return;
  }

  await authStorage.setItem(AUTH_SESSION_STORAGE_KEY, normalizedSession);
  if (normalizedSession.role === "admin" && normalizedSession.key) {
    await authStorage.setItem(LEGACY_AUTH_KEY_STORAGE_KEY, normalizedSession.key);
  } else {
    await authStorage.removeItem(LEGACY_AUTH_KEY_STORAGE_KEY);
  }
}

/** @deprecated 新网页登录不再写入密钥；仅保留给旧管理员工具调用。 */
export async function setStoredAuthKey(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  if (!normalizedAuthKey) {
    await clearStoredAuthSession();
    return;
  }
  await authStorage.setItem(LEGACY_AUTH_KEY_STORAGE_KEY, normalizedAuthKey);
}

export async function clearStoredAuthSession() {
  if (typeof window === "undefined") {
    return;
  }
  await Promise.all([
    authStorage.removeItem(LEGACY_AUTH_KEY_STORAGE_KEY),
    authStorage.removeItem(AUTH_SESSION_STORAGE_KEY),
  ]);
}

export async function clearStoredAuthKey() {
  await clearStoredAuthSession();
}
