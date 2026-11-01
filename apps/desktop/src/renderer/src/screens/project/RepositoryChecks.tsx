import { useEffect, useState } from 'react';
import type { Repository } from '@tandemise/domain';
import { ErrorState, Field } from '../../components/primitives.js';
import { useDaemonMutation } from '../../lib/queries.js';
import { Button } from '@tandemise/design/react';

/**
 * A repository's checks (#111): the command each gate fact runs and its time
 * budget. Before this they could be changed only through the API, and a test
 * suite slower than the fixed 10 minutes failed every gate on the repository.
 */
const ROWS: readonly { name: 'install' | 'typecheck' | 'lint' | 'tests' | 'build'; field: 'install' | 'typecheck' | 'lint' | 'test' | 'build'; label: string; reads: string }[] = [
  { name: 'tests', field: 'test', label: 'Tests', reads: 'checks.tests' },
  { name: 'typecheck', field: 'typecheck', label: 'Type check', reads: 'checks.typecheck' },
  { name: 'lint', field: 'lint', label: 'Lint', reads: 'checks.lint' },
  { name: 'build', field: 'build', label: 'Build', reads: 'checks.build' },
  { name: 'install', field: 'install', label: 'Install', reads: 'run first, only when another check runs' },
];

/** Mirrors the daemon's defaults; the daemon is what enforces them. */
const DEFAULT_BUDGET_MINUTES = 10;
const MAX_BUDGET_MINUTES = 240;

interface Draft {
  readonly commands: Record<string, string>;
  readonly budgets: Record<string, string>;
}

function draftOf(repository: Repository): Draft {
  const commands: Record<string, string> = {};
  const budgets: Record<string, string> = {};
  for (const row of ROWS) {
    commands[row.field] = repository.checks[row.field] ?? '';
    const minutes = repository.checks.budgets?.[row.name];
    budgets[row.name] = minutes === undefined ? '' : String(minutes);
  }
  return { commands, budgets };
}

export function RepositoryChecks({ repository }: { repository: Repository }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(repository));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useDaemonMutation(
    (daemon, checks: Parameters<typeof daemon.updateRepository>[1]['checks']) => daemon.updateRepository(repository.id, { checks }),
    ['workspaces'],
  );
  useEffect(() => setSaved(false), [draft]);

  const submit = (): void => {
    const budgets: Record<string, number> = {};
    for (const row of ROWS) {
      const raw = (draft.budgets[row.name] ?? '').trim();
      if (raw === '') continue;
      const minutes = Number(raw);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_BUDGET_MINUTES) {
        setProblem(`${row.label}: the time budget is a whole number of minutes from 1 to ${MAX_BUDGET_MINUTES}.`);
        return;
      }
      budgets[row.name] = minutes;
    }
    setProblem(null);
    const command = (field: string): string | null => {
      const value = (draft.commands[field] ?? '').trim();
      return value === '' ? null : value;
    };
    save.mutate({
      install: command('install'), typecheck: command('typecheck'), lint: command('lint'), test: command('test'), build: command('build'),
      budgets,
    }, { onSuccess: () => setSaved(true) });
  };

  const configured = ROWS.filter((r) => repository.checks[r.field] !== null).length;
  return (
    <div className="stack">
      <Button
        variant="ghost"
        aria-expanded={open}
        aria-controls={`repo-checks-${repository.id}`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide checks' : `Checks (${configured} set)`}
      </Button>
      {open ? (
        <div id={`repo-checks-${repository.id}`} className="stack" role="group" aria-label={`Checks for ${repository.name}`}>
          <p className="field__hint">
            Tandemise runs a check only when a step&apos;s gate reads it, once per change, in the step&apos;s worktree.
            A check that runs past its time budget is run once more with twice the time, then you are asked; it never
            counts against the agent. Leave a budget empty for the project&apos;s default ({DEFAULT_BUDGET_MINUTES} min
            unless planner.yaml says otherwise).
          </p>
          {ROWS.map((row) => (
            <div key={row.field} className="grid grid--2">
              <Field label={`${row.label} command`} hint={`Gates read it as ${row.reads}. Empty means none.`}>
                {(control) => (
                  <input
                    {...control}
                    className="input mono"
                    value={draft.commands[row.field] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, commands: { ...d.commands, [row.field]: e.target.value } }))}
                  />
                )}
              </Field>
              <Field label={`${row.label} time budget (minutes)`} hint="Empty uses the project's default.">
                {(control) => (
                  <input
                    {...control}
                    className="input"
                    inputMode="numeric"
                    placeholder={String(DEFAULT_BUDGET_MINUTES)}
                    value={draft.budgets[row.name] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, budgets: { ...d.budgets, [row.name]: e.target.value } }))}
                  />
                )}
              </Field>
            </div>
          ))}
          {problem ? <p className="field__error" role="alert">{problem}</p> : null}
          {save.isError ? <ErrorState error={save.error} /> : null}
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <Button disabled={save.isPending} onClick={submit}>Save checks</Button>
            {saved ? <span className="muted" role="status">Saved.</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
