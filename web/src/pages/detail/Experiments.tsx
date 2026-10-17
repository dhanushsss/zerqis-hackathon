import { Link } from 'react-router-dom';
import type { Bundle, Experiment } from '../../api';
import { AttemptStrip, Badge, duration, Empty, EXP_KIND, ExpStatus, Sha } from '../../components/ui';

function Row({ e, b }: { e: Experiment; b: Bundle }) {
  const inv = b.investigation;
  const commitLabel = e.commitSha === inv.parentSha ? 'parent' : e.commitSha === inv.commitSha ? (e.patchId ? 'failing + patch' : 'failing') : '';
  return (
    <li className="exp-item">
      <ExpStatus exp={e} />
      <div style={{ minWidth: 0 }}>
        <div className="row-wrap" style={{ gap: 8 }}>
          <Link to={`/investigations/${inv.id}/experiments/${e.id}`} className="title">
            {e.title}
          </Link>
          <Badge tone="tone-outline">{EXP_KIND[e.kind] ?? e.kind}</Badge>
          {e.commitSha && (
            <span className="row xs muted" style={{ gap: 5 }}>
              <Sha sha={e.commitSha} /> {commitLabel}
            </span>
          )}
          {e.backend === 'tavily' && <Badge tone="tone-web" icon="globe">Tavily</Badge>}
        </div>
        <p className="obs">{e.observation ?? e.reason}</p>
        {e.effect && e.status !== 'skipped' && e.status !== 'queued' && <p className="eff">{e.effect}</p>}
      </div>
      <div className="exp-side">
        {e.backend === 'docker' && e.plannedAttempts > 0 && <AttemptStrip exp={e} />}
        <span className="xs faint nowrap">
          {e.status === 'running' ? `run ${(e.result?.attempts.length ?? 0) + 1} of ${e.plannedAttempts}` : e.status === 'queued' ? 'queued' : e.status === 'skipped' ? 'skipped' : duration(e.durationMs)}
        </span>
      </div>
    </li>
  );
}

export function ExperimentList({ b, filter }: { b: Bundle; filter?: (e: Experiment) => boolean }) {
  const list = filter ? b.experiments.filter(filter) : b.experiments;
  if (!list.length) return <Empty title="No experiments planned yet" icon="flask" />;
  return (
    <ul className="exp-list">
      {list.map((e) => (
        <Row key={e.id} e={e} b={b} />
      ))}
    </ul>
  );
}
