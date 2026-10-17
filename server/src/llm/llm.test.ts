import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractJson, ModelError, TokenFactoryClient } from './client.js';
import { resolveModels } from './models.js';
import { TriageSchema, VerdictSchema } from './schemas.js';

const opts = { apiKey: 'test-key', baseUrl: 'https://tf.test/v1', projectId: undefined, timeoutMs: 2000, maxRetries: 2, models: {}, maxCallsPerInvestigation: 8, maxInputChars: 1000 };

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null, headers: init.headers });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const chat = (content: string) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const req = { role: 'triage' as const, model: 'nvidia/nemotron-x', system: 's', user: 'u', schemaName: 'x', jsonSchema: {}, validator: z.object({ ok: z.boolean() }) };

describe('structured output parsing', () => {
  it('extracts JSON from fences and reasoning blocks', () => {
    expect(extractJson('<think>hmm {"no":1}</think>\n```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(extractJson('Sure! {"a":{"b":"}"}} trailing')).toEqual({ a: { b: '}' } });
    expect(() => extractJson('no json here')).toThrow();
  });
  it('normalizes loose enums and rejects missing hypotheses', () => {
    const ok = TriageSchema.parse({ summary: 's', failure_signature: 'f', hypotheses: [{ cause: 'c', category: 'Flaky Test', prior: 'HIGH', experiments: ['Repeat', 'rm -rf /'], next_experiment: '' }] });
    expect(ok.hypotheses[0].category).toBe('flaky_test');
    expect(ok.hypotheses[0].experiments).toEqual(['repeat', 'reproduce']);
    expect(TriageSchema.safeParse({ summary: 's', failure_signature: 'f', hypotheses: [] }).success).toBe(false);
    expect(VerdictSchema.parse({ classification: 'weird', verdict: 'certain', summary: 's', primary_hypothesis: 'H1', hypotheses: [], recommended_action: 'a', remediation_type: 'x' })).toMatchObject({ classification: 'unknown', verdict: 'inconclusive', remediation_type: 'none' });
  });
});

describe('TokenFactoryClient', () => {
  it('retries on 429 and 503, then succeeds', async () => {
    const { impl, calls } = fakeFetch([
      { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '0' } },
      { status: 503, body: {} },
      { status: 200, body: chat('{"ok":true}') },
    ]);
    const c = new TokenFactoryClient(opts, impl);
    const res = await c.chatJson(req);
    expect(res.data).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe('https://tf.test/v1/chat/completions');
    expect(calls[0].body.response_format.type).toBe('json_schema');
  }, 20000);

  it('does not retry non-retryable errors and never leaks the key', async () => {
    const { impl, calls } = fakeFetch([{ status: 401, body: { error: { message: 'bad key' } } }]);
    const c = new TokenFactoryClient(opts, impl);
    const err = await c.chatJson(req).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.status).toBe(401);
    expect(String(err.message)).not.toContain('test-key');
    expect(calls).toHaveLength(1);
  });

  it('degrades response_format when the model rejects json_schema', async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: { error: { message: 'response_format json_schema not supported' } } },
      { status: 200, body: chat('{"ok":false}') },
    ]);
    const res = await new TokenFactoryClient(opts, impl).chatJson(req);
    expect(res.responseFormat).toBe('json_object');
    expect(calls[1].body.response_format).toEqual({ type: 'json_object' });
  });

  it('repairs invalid output once, then fails clearly', async () => {
    const good = fakeFetch([{ status: 200, body: chat('{"ok":"yes"}') }, { status: 200, body: chat('{"ok":true}') }]);
    const r = await new TokenFactoryClient(opts, good.impl).chatJson(req);
    expect(r.data.ok).toBe(true);
    expect(good.calls[1].body.messages.at(-1).content).toMatch(/did not match/);

    const bad = fakeFetch([{ status: 200, body: chat('nope') }, { status: 200, body: chat('still nope') }]);
    const err = await new TokenFactoryClient(opts, bad.impl).chatJson(req).catch((e) => e);
    expect(err.kind).toBe('invalid_output');
  });

  it('disables Nemotron reasoning so content stays JSON', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: chat('{"ok":true}') }, { status: 200, body: chat('{"ok":true}') }]);
    const c = new TokenFactoryClient(opts, impl);
    await c.chatJson(req);
    expect(calls[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
    await c.chatJson({ ...req, model: 'meta-llama/Llama-3.3-70B' });
    expect(calls[1].body.chat_template_kwargs).toBeUndefined();
  });

  it('refuses to call without a key', async () => {
    const err = await new TokenFactoryClient({ ...opts, apiKey: undefined }).chatJson(req).catch((e) => e);
    expect(err.kind).toBe('config');
  });
});

describe('model resolution', () => {
  const catalog = ['meta-llama/Llama-3.3-70B', 'nvidia/nemotron-3-super-120b-a12b', 'nvidia/Nemotron-3-Ultra-550b-a55b', 'nvidia/Nemotron-3_5-Lightning', 'nvidia/nemotron-3-nano-omni', 'nvidia/llama-nemotron-embed-1b'];
  it('picks the preferred Nemotron model for each role and ignores non-text models', () => {
    expect(resolveModels(catalog, {})).toMatchObject({ triage: 'nvidia/Nemotron-3_5-Lightning', reasoning: 'nvidia/nemotron-3-super-120b-a12b', deep: 'nvidia/Nemotron-3-Ultra-550b-a55b' });
  });
  it('falls back when only one Nemotron model exists and rejects unknown overrides', () => {
    const r = resolveModels(['nvidia/nemotron-3-super-120b-a12b'], { deep: 'nvidia/made-up' });
    expect(r).toMatchObject({ triage: 'nvidia/nemotron-3-super-120b-a12b', reasoning: 'nvidia/nemotron-3-super-120b-a12b', deep: 'nvidia/nemotron-3-super-120b-a12b' });
    expect(r.notes[0]).toMatch(/not in the account's catalog/);
  });
  it('returns nulls when no Nemotron model is available', () => {
    expect(resolveModels(['meta-llama/x'], {})).toMatchObject({ triage: null, reasoning: null, deep: null });
  });
});
