import { useState } from 'react';
import type { LimitStatusView, MissionDetail } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { ErrorState, SectionHead, Stat } from '../../components/primitives.js';
import { LimitFields, limitDraft, limitsFromDraft } from '../../components/LimitFields.js';
import { useDaemonMutation } from '../../lib/queries.js';
import { isTerminalMissionStatus } from '../../lib/domain.js';
import { dateTime, duration, metric, money } from '../../lib/format.js';
import { Banner, Button, Card } from '@tandemise/design/react';

/**
 * MVP.md §22.2: a value the runtime did not report is *unknown*. Rendering it
 * as 0 would be a quiet lie about cost and usage, so nulls stay "not reported"
 * and are visually de-emphasised rather than dressed up as data.
 */
export function MetricsPane({ detail }: { detail: MissionDetail }): JSX.Element {
  const m = detail.metrics;

  return (
    // Focusable, so a keyboard can scroll it when nothing inside takes focus (2.1.1).
    <div className="page" tabIndex={0} role="region" aria-label="Metrics">
      <div className="page__inner">
        <LimitSection detail={detail} />

        <section className="section">
          <SectionHead title="Time" meta="Where the mission's clock went" />
          <div className="grid grid--4">
            <Stat label="Wall clock" value={duration(m.wallClockMs)} />
            <Stat label="Runtime active" value={duration(m.runtimeActiveMs)} note={sharePercent(m.runtimeActiveMs, m.wallClockMs)} />
            <Stat label="Waiting on a human" value={duration(m.humanWaitMs)} note={sharePercent(m.humanWaitMs, m.wallClockMs)} />
            <Stat label="Started" value={detail.mission.startedAt ? dateTime(detail.mission.startedAt) : 'Not started'} muted />
          </div>
        </section>

        <section className="section">
          <SectionHead title="Work produced" />
          <div className="grid grid--4">
            <Stat label="Files changed" value={metric(m.filesChanged)} />
            <Stat label="Commits" value={metric(m.commits)} />
            <Stat label="Review findings" value={metric(m.reviewFindings)} />
            <Stat label="QA defects" value={metric(m.qaDefects)} />
          </div>
        </section>

        <section className="section">
          <SectionHead title="Reliability" />
          <div className="grid grid--3">
            <Stat label="Retries" value={metric(m.retries)} />
            <Stat label="Failures" value={metric(m.failures)} />
            <Stat
              label="Runtime fallbacks"
              value={metric(m.runtimeFallbacks)}
              note={m.runtimeFallbacks > 0 ? 'A preferred runtime was unavailable or saturated' : undefined}
            />
          </div>
        </section>

        {(m.byModel ?? []).length > 0 ? (
          <section className="section" aria-label="Usage by model">
            <SectionHead title="Usage by model" meta="Which model each run was given" />
            <div className="list">
              {(m.byModel ?? []).map((usage) => (
                <div key={`${usage.model ?? ''}:${usage.label}`} className="list__row">
                  <div className="list__main">
                    <div className="list__title">{usage.label}</div>
                    <div className="list__subtitle">
                      {[
                        `${usage.runs} ${usage.runs === 1 ? 'run' : 'runs'}`,
                        duration(usage.agentMs),
                        usage.tokens === null ? 'tokens not reported' : `${metric(usage.tokens)} tokens`,
                        ...(usage.costUsd === null ? [] : [money(usage.costUsd)]),
                      ].join(' · ')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="section">
          <SectionHead title="Usage and cost" meta="As observed, not as invoiced" />
          <div className="grid grid--3">
            <Stat label="Input tokens" value={metric(m.inputTokens)} muted={m.inputTokens === null} />
            <Stat label="Output tokens" value={metric(m.outputTokens)} muted={m.outputTokens === null} />
            <Stat label="Cost" value={money(m.costUsd)} muted={m.costUsd === null} />
          </div>
          {m.costUsd === null ? (
            <Banner style={{ marginTop: 'var(--s3)' }} icon={<Icon name="info" size={14} className="dim" />}>
              <span className="muted">
                Subscription-based runtimes do not expose a trustworthy per-run cost, so Tandemise reports nothing rather than a guess.
              </span>
            </Banner>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/**
 * The mission's limits (P8): one bar per limit, "15 / 30 agent min", and the
 * editor. At a limit the bar says the work is paused and where to decide.
 */
function LimitSection({ detail }: { detail: MissionDetail }): JSX.Element {
  // A daemon older than this window has no limits to show (P8).
  const limits = detail.limits ?? NO_LIMITS;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => limitDraft(limits.source === 'mission' ? limits.limits : []));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useDaemonMutation(
    (daemon, next: ReturnType<typeof limitsFromDraft>['limits'] | null) => daemon.setMissionLimits(detail.mission.id, next),
    ['missions'],
    detail.mission.id,
  );
  const finished = isTerminalMissionStatus(detail.mission.status);
  const meta = limits.source === 'mission'
    ? 'Set on this mission'
    : limits.source === 'project'
      ? "The project's default for every mission"
      : 'No limit: nothing stops this mission for time or spend';

  const submit = (): void => {
    const parsed = limitsFromDraft(draft);
    setProblem(parsed.error);
    if (parsed.error !== null) return;
    save.mutate(parsed.limits, { onSuccess: () => setEditing(false) });
  };

  return (
    <section className="section" aria-label="Limit">
      <SectionHead
        title="Limit"
        meta={meta}
        action={finished || editing ? undefined : (
          <Button variant="ghost" onClick={() => { setDraft(limitDraft(limits.limits)); setEditing(true); }}>
            {limits.limits.length === 0 ? 'Set a limit' : 'Change limit'}
          </Button>
        )}
      />
      {limits.limits.length > 0 ? (
        <div className="grid grid--3">
          {limits.limits.map((status) => <LimitBar key={status.metric} status={status} />)}
        </div>
      ) : null}
      <div className="grid grid--3" style={{ marginTop: limits.limits.length > 0 ? 'var(--s3)' : 0 }}>
        <Stat label="Agent minutes used" value={metric(limits.usage.agentMinutes)} />
        <Stat label="Tokens used" value={metric(limits.usage.tokens)} muted={limits.usage.tokens === null} />
        <Stat label="Cost" value={money(limits.usage.costUsd)} muted={limits.usage.costUsd === null} />
      </div>
      {editing ? (
        <Card style={{ marginTop: 'var(--s3)' }}>
          <LimitFields draft={draft} onChange={setDraft} suffix="for this mission" />
          {problem ? <p className="field__error">{problem}</p> : null}
          {save.isError ? <ErrorState error={save.error} /> : null}
          <div className="row" style={{ gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
            <Button variant="primary" disabled={save.isPending} onClick={submit}>Save limit</Button>
            {limits.source === 'mission' ? (
              <Button disabled={save.isPending} onClick={() => save.mutate(null, { onSuccess: () => setEditing(false) })}>
                Use the project default
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </Card>
      ) : null}
    </section>
  );
}

const NO_LIMITS: MissionDetail['limits'] = { source: 'none', limits: [], usage: { agentMinutes: 0, tokens: null, costUsd: null, runs: 0 }, pendingApprovalId: null };

function LimitBar({ status }: { status: LimitStatusView }): JSX.Element {
  const width = status.percent === null ? 0 : Math.min(100, status.percent);
  const fill = status.level === 'hard' ? 'var(--status-failed)' : status.level === 'soft' ? 'var(--status-blocked)' : 'var(--status-running)';
  return (
    <Card>
      <div className="stat__label">{status.label}</div>
      <div className="stat__value">{status.bar}</div>
      <div className="meter" style={{ marginTop: 'var(--s2)' }} aria-hidden="true">
        <div className="meter__fill" style={{ width: `${width}%`, background: fill }} />
      </div>
      {status.note ? <p className={status.level === 'unmeasured' ? 'muted' : ''} style={{ marginTop: 'var(--s2)', fontSize: 'var(--fs-sm)' }}>{status.note}</p> : null}
    </Card>
  );
}

function sharePercent(part: number, whole: number): string | undefined {
  if (whole <= 0) return undefined;
  return `${Math.round((part / whole) * 100)}% of wall clock`;
}
