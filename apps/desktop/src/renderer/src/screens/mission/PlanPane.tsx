import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MissionDetail, TaskView } from '@tandemise/api-contract';
import type { Approval } from '@tandemise/domain';
import { TaskPeople } from '../../components/ActorChip.js';
import { useActors, type Actors } from '../../lib/team.js';
import { Icon } from '../../components/Icon.js';
import { Empty, IdChip } from '../../components/primitives.js';
import { TaskDetail } from './TaskDetail.js';
import { WhyTheseSteps } from './WhyTheseSteps.js';
import { usePlanDecision } from '../../lib/queries.js';
import { NowLine } from '../../components/TerminalPanel.js';
import { duration, pluralize, taskBadge, taskTone } from '../../lib/format.js';
import { Banner, Card, Tooltip, Truncate } from '@tandemise/design/react';

interface Edge {
  readonly id: string;
  readonly path: string;
  readonly active: boolean;
}

/**
 * The plan, laid out as columns by `TaskView.level`.
 *
 * The daemon already ran `planLevels`, so the UI does no graph work beyond
 * drawing the edges - and it draws them from measured DOM positions rather than
 * a layout library, which keeps the card markup plain and the dependency lines
 * honest about where the cards actually ended up.
 */
export function PlanPane({ detail }: { detail: MissionDetail }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [showPlanId, setShowPlanId] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [edges, setEdges] = useState<readonly Edge[]>([]);
  const actors = useActors();
  // Only a mission the factory planned has one (#53 §10).
  const decision = usePlanDecision(detail.mission.workflowPreset === 'auto' ? detail.mission.id : '').data ?? null;
  const approvalsById = useMemo(() => new Map(detail.approvals.map((a) => [a.id as string, a])), [detail.approvals]);
  // A plan wider than the window is normal; without an edge fade the only hint
  // is a scrollbar pinned to the bottom of the pane, which nobody looks at.
  const [overflow, setOverflow] = useState({ start: false, end: false });

  const syncOverflow = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const remaining = element.scrollWidth - element.clientWidth - element.scrollLeft;
    setOverflow({ start: element.scrollLeft > 1, end: remaining > 1 });
  }, []);

  const columns = useMemo(() => groupByLevel(detail.tasks), [detail.tasks]);
  const idByKey = useMemo(() => new Map(detail.tasks.map((task) => [task.key, task.id as string])), [detail.tasks]);

  const measure = useCallback(() => {
    const root = canvas.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const next: Edge[] = [];

    for (const task of detail.tasks) {
      const target = cards.current.get(task.id);
      if (!target) continue;
      const targetBox = target.getBoundingClientRect();
      for (const dependency of task.dependsOn) {
        const sourceId = idByKey.get(dependency);
        const source = sourceId ? cards.current.get(sourceId) : undefined;
        if (!source) continue;
        const sourceBox = source.getBoundingClientRect();

        const x1 = sourceBox.right - origin.left;
        const y1 = sourceBox.top + sourceBox.height / 2 - origin.top;
        const x2 = targetBox.left - origin.left;
        const y2 = targetBox.top + targetBox.height / 2 - origin.top;
        const bend = Math.max(24, (x2 - x1) / 2);

        next.push({
          id: `${dependency}->${task.key}`,
          path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
          active: task.status === 'RUNNING' || task.status === 'READY',
        });
      }
    }
    setEdges(next);
  }, [detail.tasks, idByKey]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const root = canvas.current;
    const element = scroller.current;
    if (!root || !element) return;
    const observer = new ResizeObserver(() => {
      measure();
      syncOverflow();
    });
    observer.observe(root);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, syncOverflow]);

  if (detail.tasks.length === 0) {
    return (
      <div className="page">
        <div className="page__inner">
          <Card>
            {detail.planIssues.length > 0 ? (
              <>
                <Empty
                  icon="alert"
                  title="The proposed plan did not validate"
                  body="A plan that fails validation is never partially executed. Re-plan once the issues below are addressed."
                />
                <div className="list" style={{ marginTop: 'var(--s4)' }}>
                  {detail.planIssues.map((issue, index) => (
                    <div key={index} className="list__row">
                      <span className={`dot dot--${issue.severity === 'error' ? 'failed' : 'blocked'}`} />
                      <div className="list__main">
                        <div className="list__title">{issue.message}</div>
                        {issue.taskKey ? <div className="list__subtitle">{issue.taskKey}</div> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : detail.mission.status === 'PLANNING' ? (
              <Empty
                icon="sparkle"
                title="Planning…"
                body="The planner is reading the repositories and shaping a task graph for this goal. It usually takes a minute or two, longer if a runtime is busy; the timeline shows what it is doing. Nothing runs until you have approved the plan."
              />
            ) : (
              <Empty
                icon="sparkle"
                title="No plan yet"
                body="Press Plan in the header and the planning role will propose a task graph. Nothing runs until you have seen it."
              />
            )}
          </Card>
        </div>
      </div>
    );
  }

  const selectedTask = detail.tasks.find((task) => task.id === selected) ?? null;
  // The plan is itself an artifact; its id names the exact version approved.
  const planArtifactId = [...detail.artifacts].reverse().find((a) => a.type === 'MissionPlan')?.id ?? null;

  return (
    <>
      {decision ? (
        <div style={{ padding: 'var(--s4) var(--s7) 0' }}>
          <WhyTheseSteps missionId={detail.mission.id} decision={decision} />
        </div>
      ) : null}
      {detail.plan?.summary ? (
        <div style={{ padding: 'var(--s4) var(--s7) 0' }}>
          <Banner
            icon={<Icon name="sparkle" size={15} className="dim" />}
            action={
              // The approved version's id is for bug reports: behind Details, as in the reader and the task drawer.
              planArtifactId ? (
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 'var(--s2)', alignItems: 'center' }}>
                  <button type="button" className="reader__details-toggle" aria-expanded={showPlanId} onClick={() => setShowPlanId((open) => !open)}>
                    Details
                    <Icon name={showPlanId ? 'chevronUp' : 'chevronDown'} size={11} />
                  </button>
                  {showPlanId ? <IdChip id={planArtifactId} prefix="plan" /> : null}
                </span>
              ) : null
            }
          >
            <span className="muted">{detail.plan.summary}</span>
          </Banner>
        </div>
      ) : null}

      <div className="dag" data-overflow-start={overflow.start} data-overflow-end={overflow.end}>
        {/* A diagram may scroll both ways (1.4.10). Its edges are drawn only; each card says in words what it waits for,
            and the stages are named groups, so the plan reads in order without the picture (1.1.1, 1.3.1). */}
        <div className="dag__scroll" ref={scroller} onScroll={syncOverflow} data-scroll-2d>
          <div className="dag__canvas" ref={canvas}>
            <svg className="dag__edges" aria-hidden="true">
              {edges.map((edge) => (
                <path key={edge.id} d={edge.path} className={`dag__edge${edge.active ? ' dag__edge--active' : ''}`} />
              ))}
            </svg>

            {columns.map(([level, tasks]) => (
              <div key={level} className="dag__col" role="group" aria-label={`Stage ${level + 1}, ${pluralize(tasks.length, 'task')}`}>
                <div className="dag__colhead" aria-hidden="true">
                  <span>Stage {level + 1}</span>
                  <span style={{ opacity: 0.7 }}>{pluralize(tasks.length, 'task')}</span>
                </div>
                {tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    actors={actors}
                    after={task.dependsOn.map((key) => detail.tasks.find((t) => t.key === key)?.title ?? key)}
                    pendingApproval={task.pendingApprovalId ? approvalsById.get(task.pendingApprovalId) : undefined}
                    selected={task.id === selected}
                    onSelect={() => setSelected(task.id)}
                    register={(element) => {
                      if (element) cards.current.set(task.id, element);
                      else cards.current.delete(task.id);
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {selectedTask ? <TaskDetail task={selectedTask} detail={detail} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

function TaskCard({
  task,
  actors,
  after,
  pendingApproval,
  selected,
  onSelect,
  register,
}: {
  task: TaskView;
  actors: Actors;
  /** The titles of the steps this one waits for: the diagram's edges, in words. */
  after: readonly string[];
  pendingApproval: Approval | undefined;
  selected: boolean;
  onSelect: () => void;
  register: (element: HTMLElement | null) => void;
}): JSX.Element {
  if (task.coveredBy) {
    // A stage your upload already covers (spec A2): it never runs, so no status dot, no people, no meta; only what covers it.
    return (
      <button type="button" ref={register} className="taskcard taskcard--covered" data-status={task.status} data-selected={selected} onClick={onSelect}>
        <div className="taskcard__title">{task.title} · covered by your upload</div>
        <div className="taskcard__covered-by">
          <Icon name="file" size={11} />
          <Truncate>{task.coveredBy.filename}</Truncate>
        </div>
      </button>
    );
  }
  const tone = taskTone(task.status);
  const elapsed =
    task.startedAt && task.finishedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : null;

  const card = (
    <button type="button" ref={register} className="taskcard" data-status={task.status} data-selected={selected} onClick={onSelect}>
      <div className="taskcard__head">
        <span className={`dot dot--${tone}${task.status === 'RUNNING' ? ' dot--pulse' : ''}`} />
        <span className="taskcard__role">{task.roleName}</span>
        <div className="spacer" />
        <span className={`badge badge--${tone}`} style={{ height: 18 }}>
          {task.status === 'AWAITING_HUMAN' ? humanBadge(task, actors) : taskBadge(task.status)}
        </span>
      </div>

      <div className="taskcard__title">{task.title}</div>
      {after.length > 0 ? <span className="visually-hidden">After {after.join(', ')}.</span> : null}
      {/* The key is the plan's name for the task; its raw id is behind Details in the task drawer this card opens. */}
      <div className="taskcard__ids">
        <span className="dim">{task.key}</span>
      </div>

      <TaskPeople task={task} actors={actors} />

      {/* What a live agent is doing right now, in plain words. */}
      <NowLine now={task.now} />

      <div className="taskcard__meta">
        {/* Only set when the task works somewhere other than the mission's own
            repository, so a single-repository mission shows nothing. */}
        {task.repositoryName ? (
          <span className="taskcard__repo">
            <Icon name="folder" size={11} /> {task.repositoryName}
          </span>
        ) : null}
        {task.runtimeName ? (
          <span>
            <Icon name="runtimes" size={11} /> {task.runtimeName}
          </span>
        ) : null}
        {task.targetName ? (
          <span>
            <Icon name="branch" size={11} /> {task.targetName}
          </span>
        ) : null}
        {task.attempts > 1 ? <span>attempt {task.attempts}</span> : null}
        {elapsed !== null ? <span>{duration(elapsed)}</span> : null}
      </div>

      {task.checks.length > 0 ? (
        <div className="taskcard__checks">
          {task.checks.map((check) => (
            <span key={check.id} className={`checkpill checkpill--${check.outcome}`}>
              {check.outcome === 'PASS' ? <Icon name="check" size={10} /> : check.outcome === 'FAIL' ? <Icon name="x" size={10} /> : null}
              {check.name.replace(/^checks\./, '')}
            </span>
          ))}
        </div>
      ) : null}

      {task.status === 'READY' && task.statusReason?.startsWith('Queued') ? (
        <div className="taskcard__gate">
          <Icon name="clock" size={11} />
          <span>{task.statusReason}</span>
        </div>
      ) : null}

      {task.gate ? (
        <div className={`taskcard__gate${task.gate.passed ? '' : ' taskcard__gate--failed'}`}>
          <Icon name={task.gate.passed ? 'shield' : 'alert'} size={11} />
          <span>{task.gate.detail}</span>
        </div>
      ) : null}

      {/* A check is a look after the fact: the task is done and nothing waits on it. */}
      {task.pendingApprovalId && pendingApproval?.kind === 'check' ? (
        <div className="taskcard__note">
          <Icon name="eye" size={11} />
          <span>Check pending</span>
        </div>
      ) : task.pendingApprovalId ? (
        <div className="taskcard__gate taskcard__gate--failed">
          <Icon name="approvals" size={11} />
          <span>{waitingFor(pendingApproval, actors)}</span>
        </div>
      ) : null}

      {task.attention?.kind === 'stale_input' ? (
        // Kept on an older version: worth knowing, not a failure, so it reads like a pending check rather than in red.
        <div className="taskcard__note">
          <Icon name="info" size={11} />
          <span>Built on an older version of {task.attention.upstream ?? 'its input'}</span>
        </div>
      ) : task.needsAttention ? (
        <div className="taskcard__gate taskcard__gate--failed">
          <Icon name="alert" size={11} />
          <span>Changes requested after the fact</span>
        </div>
      ) : null}

      {task.outputArtifacts.length > 0 ? (
        <div className="taskcard__meta">
          <Icon name="file" size={11} />
          {pluralize(task.outputArtifacts.length, 'artifact')}
        </div>
      ) : null}
    </button>
  );
  // Which version it was built on is not on the card: it shows on the card's own hover and focus.
  return task.attention?.kind === 'stale_input' ? <Tooltip content={task.attention.note}>{card}</Tooltip> : card;
}

/** "Yours" only when it is: a task parked for Ana is Ana's, and an open pool task is anyone's. */
function humanBadge(task: TaskView, actors: Actors): string {
  const me = actors.meId;
  if (task.assignee) return task.assignee.id === me ? 'Yours' : task.assignee.name;
  if (me !== null && task.claimable.some((c) => c.id === me)) return 'Yours';
  return task.claimable.length > 0 ? 'Open' : 'Yours';
}

function waitingFor(approval: Approval | undefined, actors: Actors): string {
  const addressees = approval?.addressees ?? [];
  if (addressees.length === 0 || (actors.meId !== null && addressees.includes(actors.meId))) return 'Waiting for your approval';
  return `Waiting for ${actors.name(addressees[addressees.length - 1])}`;
}

function groupByLevel(tasks: readonly TaskView[]): readonly (readonly [number, readonly TaskView[]])[] {
  const byLevel = new Map<number, TaskView[]>();
  for (const task of tasks) {
    const bucket = byLevel.get(task.level);
    if (bucket) bucket.push(task);
    else byLevel.set(task.level, [task]);
  }
  return [...byLevel.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, group]) => [level, [...group].sort((a, b) => a.orderHint - b.orderHint)] as const);
}
