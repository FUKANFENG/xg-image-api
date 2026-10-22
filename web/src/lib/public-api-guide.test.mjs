import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { XG_PUBLIC_BASE_URL, XG_PUBLIC_DOC_PATH, XG_PUBLIC_SCHEMA_PATH, XG_PUBLIC_CLIENT_PATH, XG_AGENT_INSTRUCTIONS, XG_POWERSHELL_EXAMPLE } from "./public-api-guide.ts";

const asset = (path) => readFileSync(new URL(`../../public${path}`, import.meta.url), "utf8");

test("public guide assets, copied URLs and OpenAPI use the same HTTPS deployment", () => {
  const guide = asset(XG_PUBLIC_DOC_PATH);
  const schema = JSON.parse(asset(XG_PUBLIC_SCHEMA_PATH));
  assert.equal(new URL(XG_PUBLIC_BASE_URL).protocol, "https:");
  assert.equal(schema.servers[0].url, XG_PUBLIC_BASE_URL);
  for (const path of [XG_PUBLIC_DOC_PATH, XG_PUBLIC_SCHEMA_PATH, XG_PUBLIC_CLIENT_PATH]) {
    assert.ok(guide.includes(XG_PUBLIC_BASE_URL + path));
    assert.ok(asset(path).length > 100);
  }
  assert.ok(XG_AGENT_INSTRUCTIONS.includes(XG_PUBLIC_BASE_URL + XG_PUBLIC_DOC_PATH));
  assert.ok(!XG_POWERSHELL_EXAMPLE.includes("127.0.0.1"));
});

test("OpenAPI uses existing task protocol and authenticated image downloads", () => {
  const schema = JSON.parse(asset(XG_PUBLIC_SCHEMA_PATH));
  assert.equal(schema.paths["/api/image-tasks/{task_id}"], undefined);
  assert.equal(schema.paths["/api/image-tasks"].get.parameters[0].name, "ids");
  assert.equal(schema.components.securitySchemes.XGApiKey.scheme, "bearer");
  assert.deepEqual(schema.security, [{ XGApiKey: [] }]);
  assert.ok(schema.paths["/images/{image_path}"].get);
  assert.deepEqual(schema.components.schemas.ImageTask.properties.status.enum, ["queued", "running", "paused", "success", "error"]);
  const generation = schema.paths["/api/image-tasks/generations"].post;
  assert.ok(generation.responses["200"]);
  assert.equal(generation.responses["202"], undefined);
  assert.equal(schema.components.schemas.GenerationRequest.properties.model.default, "gpt-image-2");
});

test("copied PowerShell uses native continuation and UTF-8 body, never embedded credentials", () => {
  assert.ok(XG_POWERSHELL_EXAMPLE.includes(" `\n"));
  assert.ok(!XG_POWERSHELL_EXAMPLE.includes(" \\\n"));
  assert.ok(XG_POWERSHELL_EXAMPLE.includes("$env:XG_API_KEY"));
  assert.ok(XG_POWERSHELL_EXAMPLE.includes("[Text.Encoding]::UTF8.GetBytes($body)"));
  assert.ok(XG_AGENT_INSTRUCTIONS.includes("同一 ID"));
  assert.ok(XG_AGENT_INSTRUCTIONS.includes("其他域名"));
});
