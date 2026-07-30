export type AuthRole = "admin" | "user";

const AUTH_ENTRY_ROUTES = new Set(["/login", "/admin/login", "/register"]);

export function normalizeRoutePathname(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

export function isAuthEntryRoute(pathname: string) {
  return AUTH_ENTRY_ROUTES.has(normalizeRoutePathname(pathname));
}

export function isAdminRole(role: AuthRole) {
  return role === "admin";
}

/** Third-party application links transfer the current key and are admin-only. */
export function canOpenThirdPartyApps(role: AuthRole) {
  return isAdminRole(role);
}

/**
 * Keeps role landing pages in one place so login and route guards cannot drift.
 */
export function getDefaultRouteForRole(role: AuthRole) {
  return isAdminRole(role) ? "/console" : "/studio";
}

/** Matches static-export trailing slashes and nested pages to their navigation item. */
export function isRouteActive(pathname: string, href: string) {
  const normalizedPathname = normalizeRoutePathname(pathname);
  const normalizedHref = normalizeRoutePathname(href);
  return (
    normalizedPathname === normalizedHref ||
    normalizedPathname.startsWith(`${normalizedHref}/`)
  );
}
