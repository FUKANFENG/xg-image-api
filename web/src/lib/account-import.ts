export type ParsedAccountImportPayload = {
  access_token: string;
  accessToken?: string;
  type?: string;
  export_type?: string;
  source_type?: string;
  [key: string]: unknown;
};

export type ParsedAccountImport = {
  tokens: string[];
  accounts: ParsedAccountImportPayload[];
  format: "json" | "text";
};

function compactKey(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function findStringField(raw: Record<string, unknown>, compactName: string) {
  const entry = Object.entries(raw).find(
    ([key, value]) => compactKey(key) === compactName && typeof value === "string",
  );
  return typeof entry?.[1] === "string" ? entry[1].trim() : "";
}

function normalizeToken(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/^Bearer\s+/i, "").trim();
}

function normalizeAccount(value: unknown): ParsedAccountImportPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const token = normalizeToken(findStringField(raw, "accesstoken"));
  if (!token) {
    return null;
  }

  const payload: ParsedAccountImportPayload = {
    ...raw,
    access_token: token,
  };

  for (const key of Object.keys(payload)) {
    if (key !== "access_token" && compactKey(key) === "accesstoken") {
      delete payload[key];
    }
  }

  const refreshToken = findStringField(raw, "refreshtoken");
  if (refreshToken) {
    payload.refresh_token = refreshToken;
  }
  const idToken = findStringField(raw, "idtoken");
  if (idToken) {
    payload.id_token = idToken;
  }
  const accountId = findStringField(raw, "accountid");
  if (accountId) {
    payload.account_id = accountId;
  }

  if (String(payload.type ?? "").trim().toLowerCase() === "codex") {
    payload.export_type = "codex";
    payload.source_type = "codex";
    delete payload.type;
  } else if (String(payload.export_type ?? "").trim().toLowerCase() === "codex") {
    payload.source_type = "codex";
  }

  return payload;
}

export function extractAccountImportPayloads(value: unknown) {
  const accounts: ParsedAccountImportPayload[] = [];
  const visited = new WeakSet<object>();

  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") {
      return;
    }
    if (visited.has(item)) {
      return;
    }
    visited.add(item);

    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }

    const account = normalizeAccount(item);
    if (account) {
      accounts.push(account);
    }

    Object.values(item as Record<string, unknown>).forEach((nested) => {
      if (nested && typeof nested === "object") {
        visit(nested);
      }
    });
  };

  visit(value);
  return mergeAccountImportPayloads(accounts);
}

export function mergeAccountImportPayloads(
  ...groups: ParsedAccountImportPayload[][]
) {
  const byToken = new Map<string, ParsedAccountImportPayload>();
  groups.flat().forEach((account) => {
    const token = normalizeToken(account.access_token);
    if (!token) {
      return;
    }
    byToken.set(token, {
      ...(byToken.get(token) ?? {}),
      ...account,
      access_token: token,
    });
  });
  return [...byToken.values()];
}

function isLikelyPlainToken(value: string) {
  return (
    value.length >= 20 &&
    !/\s/.test(value) &&
    /^[A-Za-z0-9._~+/=-]+$/.test(value)
  );
}

function tokenFromAssignment(line: string) {
  const match = line.match(
    /^[\s{,]*(?:"|')?access(?:[_-]?token|Token)(?:"|')?\s*[:=]\s*(?:"|')?([^"',\s}]+)(?:"|')?[,}]?\s*$/i,
  );
  return normalizeToken(match?.[1] ?? "");
}

function parseTextLines(value: string) {
  const tokens: string[] = [];
  const accounts: ParsedAccountImportPayload[] = [];

  value.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    try {
      const parsedLine = JSON.parse(line) as unknown;
      accounts.push(...extractAccountImportPayloads(parsedLine));
      return;
    } catch {
      // A line may be a token, an assignment, or one line from malformed JSON.
    }

    const assignedToken = tokenFromAssignment(line);
    if (assignedToken) {
      tokens.push(assignedToken);
      return;
    }

    const plainToken = normalizeToken(line);
    if (isLikelyPlainToken(plainToken)) {
      tokens.push(plainToken);
    }
  });

  return {
    accounts: mergeAccountImportPayloads(accounts),
    tokens,
  };
}

export function parseAccountImportText(value: string): ParsedAccountImport {
  const text = value.trim();
  if (!text) {
    return { tokens: [], accounts: [], format: "text" };
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const accounts = extractAccountImportPayloads(parsed);
    return {
      tokens: accounts.map((account) => account.access_token),
      accounts,
      format: "json",
    };
  } catch {
    const parsedLines = parseTextLines(text);
    const accounts = parsedLines.accounts;
    const tokens = [
      ...new Set([
        ...accounts.map((account) => account.access_token),
        ...parsedLines.tokens,
      ]),
    ];
    return { tokens, accounts, format: "text" };
  }
}
