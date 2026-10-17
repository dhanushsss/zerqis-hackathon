/** Model roles in the investigation pipeline. */
export type ModelRole = 'triage' | 'reasoning' | 'deep';

export interface ResolvedModels {
  triage: string | null;
  reasoning: string | null;
  deep: string | null;
  available: string[];
  notes: string[];
}

const NOT_TEXT = /omni|vision|\bvl\b|-vl-|embed|reward|guard|safety|parse|rerank|retriever|nemoretriever|audio|asr|tts|clip/i;

const PREFERENCES: Record<ModelRole, RegExp[]> = {
  // Fast log reader: Lightning (3.5) > Nano > Super.
  triage: [/nemotron.*3[._-]?5.*lightning/i, /nemotron.*lightning/i, /nemotron.*nano/i, /nemotron.*super/i, /nemotron/i],
  // Evidence-weighing and report writing: Super > Ultra > anything Nemotron.
  reasoning: [/nemotron.*3[._-]?5.*super/i, /nemotron.*super/i, /nemotron.*ultra/i, /nemotron/i],
  // Hard cases and patch synthesis: Ultra > Super.
  deep: [/nemotron.*ultra/i, /nemotron.*3[._-]?5.*super/i, /nemotron.*super/i, /nemotron/i],
};

export function isNemotronTextModel(id: string): boolean {
  return /nemotron/i.test(id) && !NOT_TEXT.test(id);
}

/**
 * Picks a verified model ID for each role from the live catalog. Overrides are
 * honoured only if the catalog lists them; otherwise we fall back and say so.
 */
export function resolveModels(available: string[], overrides: Partial<Record<ModelRole, string>>): ResolvedModels {
  const notes: string[] = [];
  const candidates = available.filter(isNemotronTextModel);
  const pick = (role: ModelRole): string | null => {
    const override = overrides[role];
    if (override) {
      if (available.includes(override)) return override;
      notes.push(`${role}: configured model "${override}" is not in the account's catalog; using fallback.`);
    }
    for (const re of PREFERENCES[role]) {
      const hit = candidates
        .filter((id) => re.test(id))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
      if (hit) return hit;
    }
    return null;
  };
  const resolved = { triage: pick('triage'), reasoning: pick('reasoning'), deep: pick('deep') };
  if (!candidates.length) notes.push('No Nemotron text models were found in the catalog.');
  return { ...resolved, available, notes };
}
