/** Secret redaction applied to every log before storage, display, or model input. */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,255})\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, '[REDACTED NPM TOKEN]'],
  [/\btvly-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED TAVILY KEY]'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED AWS KEY ID]'],
  [/\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]'],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[REDACTED CREDENTIALS]@'],
  [/\b(Authorization:\s*(?:Bearer|token|Basic)\s+)[^\s'"]+/gi, '$1[REDACTED]'],
  [
    /\b((?:[A-Z0-9_]*_)?(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*)(?!\*\*\*|\[REDACTED)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s'"]{4,})/gi,
    '$1[REDACTED]',
  ],
];

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, (...args) => {
      count++;
      const groups = args.slice(1, -2) as string[];
      return replacement.replace(/\$(\d)/g, (_, i) => groups[Number(i) - 1] ?? '');
    });
  }
  return { text: out, count };
}
