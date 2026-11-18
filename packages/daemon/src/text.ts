const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/u;

const SECRET_PATTERNS: RegExp[] = [
  /secret:\/\/\S+/gi,
  /cursorAuth\/[A-Za-z0-9._/-]+/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

/** Split Han characters so FTS5 unicode61 can match two-character words. */
export function toSearchText(input: string): string {
  let out = "";
  for (const ch of input) {
    if (CJK.test(ch)) out += ` ${ch} `;
    else out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function toFtsQuery(query: string): string {
  const text = toSearchText(query);
  const tokens = text.split(" ").filter(Boolean).map((token) => token.replaceAll('"', ""));
  if (tokens.length === 0) return "";
  const hasCjk = tokens.some((token) => CJK.test(token));
  if (hasCjk) return `"${tokens.join(" ")}"`;
  return tokens.map((token) => `"${token}"`).join(" ");
}

export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

export function clip(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…`;
}
