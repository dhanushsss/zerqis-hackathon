import { z } from 'zod';
import { CLASSIFICATIONS, VERDICTS } from '../domain/types.js';

export const EXPERIMENT_MENU = ['reproduce', 'repeat', 'compare_parent', 'external_search'] as const;
export const REMEDIATIONS = ['retry', 'quarantine', 'dependency_pin', 'code_patch', 'none'] as const;

const clamp01 = z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().min(0).max(1));
const lineNo = z.preprocess((v) => (v === null || v === '' ? undefined : typeof v === 'string' ? Number(v) : v), z.number().int().positive().optional());

/** Lenient enum: accepts case/spacing variants, maps unknown to a fallback. */
function looseEnum<T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) {
  return z.preprocess((v) => {
    if (typeof v !== 'string') return fallback;
    const k = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return (values as readonly string[]).includes(k) ? k : fallback;
  }, z.enum(values));
}

const evidenceItem = z.object({ quote: z.string().min(1).max(600), line: lineNo });

export const TriageSchema = z.object({
  summary: z.string().min(1).max(1200),
  failure_signature: z.string().min(1).max(400),
  failing_tests: z.array(z.object({ name: z.string().max(300), file: z.string().max(300).optional().nullable() })).max(20).default([]),
  environment_clues: z.array(z.string().max(300)).max(10).default([]),
  implicated_dependencies: z
    .array(z.object({ name: z.string().max(200), version: z.string().max(60).optional().nullable() }))
    .max(10)
    .default([]),
  hypotheses: z
    .array(
      z.object({
        id: z.string().max(10).optional(),
        cause: z.string().min(1).max(500),
        category: looseEnum(CLASSIFICATIONS, 'unknown'),
        supporting_evidence: z.array(evidenceItem).max(6).default([]),
        contradicting_evidence: z.array(evidenceItem).max(6).default([]),
        prior: looseEnum(['high', 'medium', 'low'] as const, 'medium'),
        heuristic_confidence: clamp01.optional(),
        experiments: z.array(looseEnum(EXPERIMENT_MENU, 'reproduce')).max(4).default([]),
        next_experiment: z.string().max(400).default(''),
      }),
    )
    .min(1)
    .max(4),
  search_queries: z.array(z.string().min(3).max(200)).max(3).default([]),
});
export type TriageOutput = z.infer<typeof TriageSchema>;

const EVIDENCE_JSON = {
  type: 'array',
  items: { type: 'object', properties: { quote: { type: 'string' }, line: { type: 'integer' } }, required: ['quote'] },
};

export const TRIAGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    failure_signature: { type: 'string' },
    failing_tests: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string' } }, required: ['name'] } },
    environment_clues: { type: 'array', items: { type: 'string' } },
    implicated_dependencies: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' } }, required: ['name'] } },
    hypotheses: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          cause: { type: 'string' },
          category: { type: 'string', enum: [...CLASSIFICATIONS] },
          supporting_evidence: EVIDENCE_JSON,
          contradicting_evidence: EVIDENCE_JSON,
          prior: { type: 'string', enum: ['high', 'medium', 'low'] },
          heuristic_confidence: { type: 'number' },
          experiments: { type: 'array', items: { type: 'string', enum: [...EXPERIMENT_MENU] } },
          next_experiment: { type: 'string' },
        },
        required: ['cause', 'category', 'supporting_evidence', 'contradicting_evidence', 'prior', 'experiments', 'next_experiment'],
      },
    },
    search_queries: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'failure_signature', 'hypotheses'],
};

export const VerdictSchema = z.object({
  classification: looseEnum(CLASSIFICATIONS, 'unknown'),
  verdict: looseEnum(VERDICTS, 'inconclusive'),
  summary: z.string().min(1).max(1500),
  primary_hypothesis: z.string().max(10),
  hypotheses: z
    .array(
      z.object({
        id: z.string().max(10),
        status: looseEnum(['supported', 'refuted', 'inconclusive'] as const, 'inconclusive'),
        assessment: z.string().max(800),
      }),
    )
    .max(6),
  recommended_action: z.string().min(1).max(800),
  remediation_type: looseEnum(REMEDIATIONS, 'none'),
  limitations: z.array(z.string().max(400)).max(8).default([]),
});
export type VerdictOutput = z.infer<typeof VerdictSchema>;

export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    classification: { type: 'string', enum: [...CLASSIFICATIONS] },
    verdict: { type: 'string', enum: [...VERDICTS] },
    summary: { type: 'string' },
    primary_hypothesis: { type: 'string' },
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, status: { type: 'string', enum: ['supported', 'refuted', 'inconclusive'] }, assessment: { type: 'string' } },
        required: ['id', 'status', 'assessment'],
      },
    },
    recommended_action: { type: 'string' },
    remediation_type: { type: 'string', enum: [...REMEDIATIONS] },
    limitations: { type: 'array', items: { type: 'string' } },
  },
  required: ['classification', 'verdict', 'summary', 'primary_hypothesis', 'hypotheses', 'recommended_action', 'remediation_type', 'limitations'],
};

export const PatchSchema = z.object({
  explanation: z.string().min(1).max(1200),
  files: z
    .array(z.object({ path: z.string().min(1).max(200), content: z.string().max(40_000) }))
    .min(1)
    .max(3),
});
export type PatchOutput = z.infer<typeof PatchSchema>;

export const PATCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string' },
    files: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  required: ['explanation', 'files'],
};

// ---------------------------------------------------------------------------
// Bounded agent loop (ALIBI_LOOP=1): one decision per iteration.
// `tool` and `args` are deliberately loose here; the deterministic policy in
// pipeline/agentLoop.ts decides what is allowed and records every rejection.

export const NextActionSchema = z.object({
  hypothesis_updates: z
    .array(
      z.object({
        id: z.string().max(10),
        status: looseEnum(['strengthened', 'weakened', 'refuted', 'unchanged'] as const, 'unchanged'),
        reason: z.string().max(400).default(''),
      }),
    )
    .max(6)
    .default([]),
  decision: looseEnum(['experiment', 'conclude'] as const, 'conclude'),
  action: z
    .object({
      tool: z.string().max(40),
      args: z.record(z.unknown()).default({}),
      prediction: z.string().max(400).default(''),
      rationale: z.string().max(400).default(''),
    })
    .nullable()
    .optional(),
  conclusion: z.string().max(600).optional(),
});
export type NextActionOutput = z.infer<typeof NextActionSchema>;

export const NEXT_ACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    hypothesis_updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, status: { type: 'string', enum: ['strengthened', 'weakened', 'refuted', 'unchanged'] }, reason: { type: 'string' } },
        required: ['id', 'status', 'reason'],
      },
    },
    decision: { type: 'string', enum: ['experiment', 'conclude'] },
    action: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: ['reproduce', 'repeat', 'run_test', 'search'] },
        args: { type: 'object' },
        prediction: { type: 'string' },
        rationale: { type: 'string' },
      },
      required: ['tool', 'args', 'prediction', 'rationale'],
    },
    conclusion: { type: 'string' },
  },
  required: ['hypothesis_updates', 'decision'],
};
