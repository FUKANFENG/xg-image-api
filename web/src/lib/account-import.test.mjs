import assert from "node:assert/strict";
import test from "node:test";

import {
  extractAccountImportPayloads,
  parseAccountImportText,
} from "./account-import.ts";

test("extracts access_token records from a mixed JSON array", () => {
  const fixture = [
    {
      id_token: "header.id-one.signature",
      access_token: "header.access-one.signature",
      refresh_token: "refresh-one",
      account_id: "account-one",
      type: "codex",
    },
    {
      auth_mode: "apikey",
      OPENAI_API_KEY: "project-api-key-that-is-not-an-access-token",
    },
    {
      idToken: "header.id-two.signature",
      accessToken: "header.access-two.signature",
      refreshToken: "refresh-two",
      accountId: "account-two",
      type: "codex",
    },
  ];

  const result = parseAccountImportText(JSON.stringify(fixture));

  assert.equal(result.format, "json");
  assert.deepEqual(result.tokens, [
    "header.access-one.signature",
    "header.access-two.signature",
  ]);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts[0].source_type, "codex");
  assert.equal(result.accounts[0].refresh_token, "refresh-one");
  assert.equal(result.accounts[1].id_token, "header.id-two.signature");
  assert.equal(result.accounts[1].account_id, "account-two");
  assert.equal(result.tokens.includes(fixture[1].OPENAI_API_KEY), false);
});

test("recursively extracts nested account containers and deduplicates tokens", () => {
  const result = extractAccountImportPayloads({
    data: {
      accounts: [
        { access_token: "header.same.signature", refresh_token: "first" },
        { accessToken: "header.same.signature", idToken: "second" },
      ],
    },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].access_token, "header.same.signature");
  assert.equal(result[0].refresh_token, "first");
  assert.equal(result[0].id_token, "second");
});

test("supports plain token lists, bearer prefixes, assignments, and duplicates", () => {
  const result = parseAccountImportText(`
header.plain-one.signature
Bearer header.plain-two.signature
access_token = "header.plain-three.signature"
header.plain-one.signature
`);

  assert.equal(result.format, "text");
  assert.deepEqual(result.tokens, [
    "header.plain-one.signature",
    "header.plain-two.signature",
    "header.plain-three.signature",
  ]);
});

test("does not treat unrelated API keys in JSON as account access tokens", () => {
  const result = parseAccountImportText(
    JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "project-api-key-that-is-not-an-access-token",
    }),
  );

  assert.deepEqual(result.tokens, []);
  assert.deepEqual(result.accounts, []);
});
