import type { ZodType, ZodTypeDef } from 'zod';
import { config } from '../config.js';
import { resolveModels, type ModelRole, type ResolvedModels } from './models.js';

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'http' | 'timeout' | 'invalid_output' | 'budget',
    readonly status?: number,
    readonly attempts = 1,
  ) {
    super(message);
  }
}

export interface ChatJsonRequest<T> {
  role: ModelRole;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  validator: ZodType<T, ZodTypeDef, unknown>;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatJsonResult<T> {
  data: T;
  model: string;
  attempts: number;
  durationMs: number;
  inputChars: number;
  promptTokens: number | null;
  completionTokens: number | null;
  raw: string;
  responseFormat: 'json_schema' | 'json_object' | 'none';
}

type ResponseFormatMode = 'json_schema' | 'json_object' | 'none';

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Extracts the first JSON object from model text (handles fences and <think> blocks). */
export function extractJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // fall through to brace scanning
  }
  const start = t.indexOf('{');
  if (start < 0) throw new Error('No JSON object in model output');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error('Unterminated JSON object in model output');
}

/**
 * OpenAI-compatible client for Nebius Token Factory. Secrets never appear in
 * logs or errors; responses are validated before use.
 */
export class TokenFactoryClient {
  private modelsCache: { at: number; resolved: ResolvedModels } | null = null;
  /** Remembers whether the endpoint rejected json_schema for a model. */
  private formatSupport = new Map<string, ResponseFormatMode>();

  constructor(
    private readonly opts = config.nebius,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private async request(path: string, init: RequestInit): Promise<{ status: number; json: any; headers: Headers }> {
    if (!this.opts.apiKey) throw new ModelError('NEBIUS_API_KEY is not configured', 'config');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, { ...init, headers: this.headers(), signal: ctrl.signal });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text.slice(0, 500) };
      }
      return { status: res.status, json, headers: res.headers };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new ModelError(`Request timed out after ${this.opts.timeoutMs} ms`, 'timeout');
      throw new ModelError(`Network error: ${(err as Error).message}`, 'http');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Request with bounded exponential backoff for transient failures and 429s. */
  private async requestWithRetry(path: string, init: RequestInit): Promise<{ status: number; json: any; attempts: number }> {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const res = await this.request(path, init);
        if (res.status < 400) return { ...res, attempts: attempt };
        if (!RETRYABLE.has(res.status) || attempt > this.opts.maxRetries) {
          const msg = res.json?.error?.message ?? res.json?.detail ?? res.json?.message ?? JSON.stringify(res.json)?.slice(0, 300);
          throw new ModelError(`Token Factory HTTP ${res.status}: ${msg}`, 'http', res.status, attempt);
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20_000) : 1000 * 2 ** (attempt - 1) + Math.random() * 250;
        await sleep(delay);
      } catch (err) {
        if (err instanceof ModelError && (err.kind === 'http' && err.status !== undefined)) throw err;
        if (err instanceof ModelError && err.kind === 'config') throw err;
        if (attempt > this.opts.maxRetries) throw err instanceof ModelError ? new ModelError(err.message, err.kind, err.status, attempt) : err;
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }

  async listModels(force = false): Promise<ResolvedModels> {
    if (!force && this.modelsCache && Date.now() - this.modelsCache.at < 10 * 60_000) return this.modelsCache.resolved;
    const res = await this.requestWithRetry('/models', { method: 'GET' });
    const ids: string[] = (res.json?.data ?? []).map((m: { id: string }) => m.id).filter((x: unknown) => typeof x === 'string');
    const resolved = resolveModels(ids, this.opts.models);
    this.modelsCache = { at: Date.now(), resolved };
    return resolved;
  }

  private responseFormat(mode: ResponseFormatMode, name: string, schema: Record<string, unknown>) {
    if (mode === 'json_schema') return { type: 'json_schema', json_schema: { name, schema, strict: false } };
    if (mode === 'json_object') return { type: 'json_object' };
    return undefined;
  }

  /**
   * Requests JSON conforming to `jsonSchema`, validates it with `validator`,
   * and makes one repair attempt if validation fails.
   */
  async chatJson<T>(req: ChatJsonRequest<T>): Promise<ChatJsonResult<T>> {
    const started = Date.now();
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ];
    const inputChars = req.system.length + req.user.length;
    let mode: ResponseFormatMode = this.formatSupport.get(req.model) ?? 'json_schema';
    let attempts = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let lastRaw = '';
    let lastProblem = '';

    for (let repair = 0; repair < 2; repair++) {
      let res: { status: number; json: any; attempts: number } | null = null;
      while (!res) {
        const body = {
          model: req.model,
          messages,
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens ?? 4096,
          response_format: this.responseFormat(mode, req.schemaName, req.jsonSchema),
          // Nemotron 3/3.5 reason by default; on Token Factory the reasoning lands in
          // `content` and breaks JSON output, so Alibi asks for the answer only.
          ...(/nemotron/i.test(req.model) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        };
        try {
          res = await this.requestWithRetry('/chat/completions', { method: 'POST', body: JSON.stringify(body) });
        } catch (err) {
          // Some models reject structured-output modes: degrade json_schema -> json_object -> none.
          if (err instanceof ModelError && err.status === 400 && mode !== 'none' && /response_format|json_schema|guided|schema|json_object/i.test(err.message)) {
            mode = mode === 'json_schema' ? 'json_object' : 'none';
            this.formatSupport.set(req.model, mode);
            continue;
          }
          throw err;
        }
      }
      attempts += res.attempts;
      promptTokens += res.json?.usage?.prompt_tokens ?? 0;
      completionTokens += res.json?.usage?.completion_tokens ?? 0;
      const content: string = res.json?.choices?.[0]?.message?.content ?? '';
      lastRaw = content;
      try {
        const parsed = extractJson(content);
        const checked = req.validator.safeParse(parsed);
        if (checked.success) {
          return {
            data: checked.data,
            model: req.model,
            attempts,
            durationMs: Date.now() - started,
            inputChars,
            promptTokens: promptTokens || null,
            completionTokens: completionTokens || null,
            raw: content,
            responseFormat: mode,
          };
        }
        lastProblem = checked.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      } catch (err) {
        lastProblem = (err as Error).message;
      }
      messages.push({ role: 'assistant', content: content.slice(0, 12_000) });
      messages.push({
        role: 'user',
        content: `Your previous reply did not match the required JSON schema (${lastProblem}). Reply again with ONLY one JSON object that satisfies the schema.`,
      });
    }
    throw new ModelError(`Model output failed validation after repair: ${lastProblem}. Output began: ${lastRaw.slice(0, 160)}`, 'invalid_output', undefined, attempts);
  }
}
