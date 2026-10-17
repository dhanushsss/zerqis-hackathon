import type { Investigation } from '../../api';
import { DIAGNOSIS_INFO, DiagnosisBadge, FIX_INFO, FixBadge, Icon } from '../../components/ui';

/**
 * Diagnosis and fix outcomes of the bounded agent loop (ALIBI_LOOP=1), shown side by side so a
 * confirmed cause is never read as a validated fix. Renders nothing when the loop did not run.
 */
export function AgentOutcome({ agent }: { agent: Investigation['agent'] }) {
  if (!agent) return null;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <section className="stack-sm" aria-labelledby="agent-outcome-title">
      <h3 id="agent-outcome-title">Agent loop outcome</h3>
      <div className="facts">
        <div className="fact" aria-label="Diagnosis outcome">
          <span className="fact-label">
            <Icon name="target" /> Diagnosis · the cause
          </span>
          <div className="fact-body stack-xs">
            <span>
              <DiagnosisBadge outcome={agent.diagnosis} />
            </span>
            <span className="muted">{DIAGNOSIS_INFO[agent.diagnosis]?.help}</span>
          </div>
        </div>
        <div className="fact" aria-label="Fix outcome">
          <span className="fact-label">
            <Icon name="wrap" /> Fix · candidate patches
          </span>
          <div className="fact-body stack-xs">
            <span>
              <FixBadge outcome={agent.fix} />
            </span>
            <span className="muted">{FIX_INFO[agent.fix]?.help}</span>
          </div>
        </div>
      </div>
      <p className="xs muted">
        {plural(agent.iterations, 'iteration', 'iterations')} · {plural(agent.executed, 'experiment', 'experiments')} executed · {plural(agent.rejected, 'proposal', 'proposals')} rejected by policy ·{' '}
        {plural(agent.patchRetries, 'patch retry', 'patch retries')}. Stopped: {agent.stopDetail}
      </p>
    </section>
  );
}
