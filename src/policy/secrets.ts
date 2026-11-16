/**
 * Secret scanning for everything the control plane posts (V2) and for added lines
 * in the diff. Matches are redacted in posted text and flagged as risks in the PR.
 * Patterns favour precision: a false alarm keeps a PR in draft, which is cheap.
 */

export interface SecretPattern {
  id: string;
  description: string;
  regex: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'private-key',
    description: 'Private key block',
    regex:
      /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255})\b/g,
  },
  {
    id: 'github-pat',
    description: 'GitHub fine-grained token',
    regex: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g,
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic API key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'openai-key',
    description: 'OpenAI API key',
    regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key ID',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  { id: 'slack-token', description: 'Slack token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    id: 'atlassian-token',
    description: 'Atlassian API token',
    regex: /\bATATT[A-Za-z0-9_\-=]{40,}\b/g,
  },
  { id: 'e2b-key', description: 'E2B API key', regex: /\be2b_[A-Za-z0-9]{30,}\b/g },
  { id: 'google-api-key', description: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-key', description: 'Stripe secret key', regex: /\b[rs]k_live_[0-9A-Za-z]{20,}\b/g },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: 'credential-url',
    description: 'URL with embedded credentials',
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@[^\s]+/gi,
  },
];

export interface SecretFinding {
  id: string;
  description: string;
}

export function findSecrets(value: string): SecretFinding[] {
  const found = new Map<string, SecretFinding>();
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(value)) {
      found.set(pattern.id, { id: pattern.id, description: pattern.description });
    }
    pattern.regex.lastIndex = 0;
  }
  return [...found.values()];
}

export function redactSecrets(value: string): { text: string; findings: SecretFinding[] } {
  const findings = findSecrets(value);
  if (findings.length === 0) return { text: value, findings };
  let text = value;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern.regex, `[redacted ${pattern.id}]`);
  }
  return { text, findings };
}

/**
 * Prepare agent-written text for posting: redact secrets, drop control characters and
 * cap the length so a hijacked agent cannot use comments as a bulk exfiltration channel.
 */
export function sanitizeAgentText(
  value: string,
  maxLength: number,
): { text: string; findings: SecretFinding[]; truncated: boolean } {
  const { text: redacted, findings } = redactSecrets(value);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters on purpose
  const cleaned = redacted.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (cleaned.length <= maxLength) return { text: cleaned, findings, truncated: false };
  return { text: `${cleaned.slice(0, maxLength - 1).trimEnd()}…`, findings, truncated: true };
}
