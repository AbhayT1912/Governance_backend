const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "PRIVATE_KEY", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "AWS_ACCESS_KEY", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "GITHUB_TOKEN", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: "BEARER_TOKEN", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    name: "CREDENTIAL",
    pattern: /\b(api[_-]?key|access[_-]?token|password|passwd|secret)\b(\s*[:=]\s*["']?)[A-Za-z0-9_./+=-]{8,}/gi,
  },
];

const INJECTION_PATTERNS = [
  /\bignore (?:all )?(?:previous|prior) instructions\b/i,
  /\b(?:reveal|print|exfiltrate) (?:the )?(?:system prompt|secrets|credentials)\b/i,
  /\byou are now (?:an? )?(?:admin|system|developer)\b/i,
  /\bdisregard (?:the )?(?:rules|policy|system prompt)\b/i,
];

export interface RedactionResult {
  value: unknown;
  redactions: string[];
}

function redactString(input: string, redactions: Set<string>) {
  let value = input;
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      redactions.add(name);
      pattern.lastIndex = 0;
      value = value.replace(pattern, `[REDACTED:${name}]`);
    }
  }
  return value;
}

export function redactSecrets(input: unknown): RedactionResult {
  const redactions = new Set<string>();
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value, redactions);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, visit(item)]),
      );
    }
    return value;
  };
  return { value: visit(input), redactions: Array.from(redactions) };
}

export function stripInstructionLikeText(input: string) {
  const strippedLines: string[] = [];
  const safeText = input
    .split(/\r?\n/)
    .filter((line) => {
      const injected = INJECTION_PATTERNS.some((pattern) => pattern.test(line));
      if (injected) strippedLines.push(line);
      return !injected;
    })
    .join("\n");
  return { safeText, strippedLines };
}
