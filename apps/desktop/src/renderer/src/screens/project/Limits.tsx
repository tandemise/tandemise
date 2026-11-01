import { useEffect, useState } from 'react';
import type { Limit } from '@tandemise/domain';
import type { LimitStatusView } from '@tandemise/api-contract';
import { ErrorState, SectionHead, Stat } from '../../components/primitives.js';
import { LimitFields, limitDraft, limitsFromDraft, type LimitDraft } from '../../components/LimitFields.js';
import { useDaemonMutation, useWorkspaceUsage } from '../../lib/queries.js';
import { metric, money } from '../../lib/format.js';
import { Button, Card } from '@tandemise/design/react';

/**
 * The project's limits (P8): this month's usage against the monthly limit, and
 * the limit every mission gets unless it sets its own. At the warning level
 * the person is told; at 100% work stops and they are asked.
 */
export function Limits({ workspaceId, monthly, perMission }: {
  workspaceId: string;
  monthly: readonly Limit[];
  perMission: readonly Limit[];
}): JSX.Element {
  const usage = useWorkspaceUsage();
  const u = usage.data;
  return (
    <section className="section" aria-label="Limits">
      <SectionHead title="Limits" meta={u ? `This month (${monthName(u.month)}) so far` : 'Spend and time ceilings'} />
      <Card>
        <div className="grid grid--3">
          <Stat label="Agent minutes this month" value={metric(u?.usage.agentMinutes ?? null)} />
          <Stat label="Tokens this month" value={metric(u?.usage.tokens ?? null)} muted={(u?.usage.tokens ?? null) === null} />
          <Stat
            label="Cost this month"
            value={money(u?.usage.costUsd ?? null)}
            muted={(u?.usage.costUsd ?? null) === null}
            // Eval trials count against the month like any run; saying how much keeps the total from surprising anyone.
            note={(u?.evalCostUsd ?? 0) > 0 ? `of which evals ${money(u?.evalCostUsd ?? null)}` : undefined}
          />
        </div>
        {(u?.limits ?? []).length > 0 ? (
          <div className="stack" style={{ marginTop: 'var(--s3)' }}>
            {(u?.limits ?? []).map((status) => <MonthBar key={status.metric} status={status} />)}
          </div>
        ) : null}
      </Card>
      <LimitForm
        key={`month-${JSON.stringify(monthly)}`}
        workspaceId={workspaceId}
        field="monthlyLimits"
        title="Per month, for the whole project"
        hint="Counts every mission's runs in the local calendar month. Over the warning level only urgent and high missions are pulled from the backlog; at 100% all work stops until you raise it."
        suffix="per month"
        limits={monthly}
      />
      <LimitForm
        key={`mission-${JSON.stringify(perMission)}`}
        workspaceId={workspaceId}
        field="defaultMissionLimits"
        title="Per mission, unless a mission sets its own"
        hint="Each mission stops at this limit and asks you whether to raise it."
        suffix="per mission"
        limits={perMission}
      />
    </section>
  );
}

function LimitForm({ workspaceId, field, title, hint, suffix, limits }: {
  workspaceId: string;
  field: 'monthlyLimits' | 'defaultMissionLimits';
  title: string;
  hint: string;
  suffix: string;
  limits: readonly Limit[];
}): JSX.Element {
  const [draft, setDraft] = useState<LimitDraft>(() => limitDraft(limits));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useDaemonMutation(
    (daemon, next: ReturnType<typeof limitsFromDraft>['limits']) => daemon.updateWorkspace(workspaceId, { [field]: next }),
    ['workspaces', 'missions'],
  );
  useEffect(() => setSaved(false), [draft]);
  const submit = (): void => {
    const parsed = limitsFromDraft(draft);
    setProblem(parsed.error);
    if (parsed.error !== null) return;
    save.mutate(parsed.limits, { onSuccess: () => setSaved(true) });
  };
  return (
    <Card style={{ marginTop: 'var(--s3)' }} aria-label={title}>
      <div className="field__label">{title}</div>
      <p className="field__hint" style={{ marginBottom: 'var(--s3)' }}>{hint}</p>
      <LimitFields draft={draft} onChange={setDraft} suffix={suffix} />
      {problem ? <p className="field__error">{problem}</p> : null}
      {save.isError ? <ErrorState error={save.error} /> : null}
      <div className="row" style={{ gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
        <Button disabled={save.isPending} onClick={submit}>
          {field === 'monthlyLimits' ? 'Save monthly limit' : 'Save mission limit'}
        </Button>
        {saved ? <span className="muted">Saved.</span> : null}
      </div>
    </Card>
  );
}

function MonthBar({ status }: { status: LimitStatusView }): JSX.Element {
  const width = status.percent === null ? 0 : Math.min(100, status.percent);
  const fill = status.level === 'hard' ? 'var(--status-failed)' : status.level === 'soft' ? 'var(--status-blocked)' : 'var(--status-running)';
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="stat__label">{status.label} this month</span>
        <span className="mono">{status.bar}</span>
      </div>
      <div className="meter" style={{ marginTop: 'var(--s1)' }} aria-hidden="true">
        <div className="meter__fill" style={{ width: `${width}%`, background: fill }} />
      </div>
      {status.note ? <p className="muted" style={{ marginTop: 'var(--s1)', fontSize: 'var(--fs-sm)' }}>{status.note}</p> : null}
    </div>
  );
}

function monthName(month: string): string {
  const [year, m] = month.split('-').map(Number);
  if (!year || !m) return month;
  return new Date(year, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
