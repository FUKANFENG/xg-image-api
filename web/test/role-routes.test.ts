import assert from "node:assert/strict";
import test from "node:test";

import {
  canOpenThirdPartyApps,
  getDefaultRouteForRole,
  isAuthEntryRoute,
  isRouteActive,
} from "../src/lib/role-routes.ts";

test("普通用户登录后进入独立创作台", () => {
  assert.equal(getDefaultRouteForRole("user"), "/studio");
});

test("管理员登录后继续进入账号管理页", () => {
  assert.equal(getDefaultRouteForRole("admin"), "/accounts");
});

test("普通用户不能使用会携带密钥的第三方跳转", () => {
  assert.equal(canOpenThirdPartyApps("user"), false);
  assert.equal(canOpenThirdPartyApps("admin"), true);
});

test("静态部署尾斜杠仍能高亮当前导航", () => {
  assert.equal(isRouteActive("/accounts/", "/accounts"), true);
  assert.equal(isRouteActive("/accounts/detail/", "/accounts"), true);
  assert.equal(isRouteActive("/accounting/", "/accounts"), false);
});

test("认证入口兼容静态部署尾斜杠且不误判子路径", () => {
  assert.equal(isAuthEntryRoute("/login"), true);
  assert.equal(isAuthEntryRoute("/login/"), true);
  assert.equal(isAuthEntryRoute("/register/"), true);
  assert.equal(isAuthEntryRoute("/admin/login/"), true);
  assert.equal(isAuthEntryRoute("/login/history"), false);
  assert.equal(isAuthEntryRoute("/studio/"), false);
});
