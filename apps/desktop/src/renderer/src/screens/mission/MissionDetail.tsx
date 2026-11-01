import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { MissionDetail as MissionDetailView } from '@tandemise/api-contract';
import type { MissionStatus } from '@tandemise/domain';
import { isLimitCard, isTerminalMissionStatus } from '../../lib/domain.js';
import { ApprovalCard } from '../approvals/ApprovalCard.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { ConfirmDialog } from '../../components/Modal.js';
import { Empty, ErrorState, IdChip, Skeleton, SkeletonList, StatusBadge } from '../../components/primitives.js';
import { FeedPane } from './FeedPane.js';
import { PlanPane } from './PlanPane.js';
import { TimelinePane } from './TimelinePane.js';
import { ArtifactsPane } from './ArtifactsPane.js';
import { ChecksPane } from './ChecksPane.js';
import { MetricsPane } from './MetricsPane.js';
import { ClaimBanner, ClaimRefusal, claimHeld } from '../../components/ClaimBanner.js';
import { isApprovalForMember, isApprovalWaitingOnMember, isHumanTaskForMember, isPlanUnstarted, planStanding } from '@tandemise/api-contract/for-me';
import { useApprovals, useDaemonMutation, useMission, useMissionRefinement, useMyMemberId, useIssues, useRoutines, useShip } from '../../lib/queries.js';
import { missionTone, pluralize } from '../../lib/format.js';
import { describeError } from '../../lib/daemon.js';
import { clearMissionNotice, useMissionNotice } from '../../lib/notices.js';
import { useOpenTerminal } from '../../lib/terminal.js';
import { TerminalPanel } from '../../components/TerminalPanel.js';
import { Banner, Button, Card, Tab, Tabs, Tooltip } from '@tandemise/design/react';
import { parseTrackerGoal } from '@tandemise/domain/tracker-goal';

// Feed first: it is where a mission opens, and the order of the tabs says so.
export const MISSION_TABS = ['feed', 'plan', 'timeline', 'artifacts', 'checks', 'metrics'] as const;
export type MissionTab = (typeof MISSION_TABS)[number];

export function MissionDetail({ id, tab }: { id: string; tab: MissionTab }): JSX.Element {
  const mission = useMission(id);
  const meId = useMyMemberId();
  const staffingNotice = useMissionNotice(id);
  const [, navigate] = useLocation();
  const [confirming, setConfirming] = useState<'cancel' | 'delete' | null>(null);
  // Set by the "waiting on you" banner and cleared by the feed once it has scrolled,
  // so revisiting the tab later does not jump to "Needs you" again.
  const [focusNeeds, setFocusNeeds] = useState(false);
  const terminalTaskId = useOpenTerminal();

  const act = useDaemonMutation(
    (daemon, args: { action: 'plan' | 'replan' | 'start' | 'pause' | 'resume' | 'cancel'; lane?: 'quick' | 'careful' }) =>
      daemon.missionAction(id, args.action, args.lane === undefined ? undefined : { lane: args.lane }),
    ['missions', 'tasks'],
    id,
  );
  const remove = useDaemonMutation((daemon) => daemon.deleteMission(id), ['missions']);
  // A DRAFT is planned only once the readiness gate passes (P6): the button
  // says what is left, from the same counts the daemon refuses a plan on.
  const readiness = useMissionRefinement(id, mission.data?.mission.status === 'DRAFT').data?.readiness;

  if (mission.isPending) return <MissionSkeleton />;
  if (mission.isError) {
    return (
      <>
        <PageHeader title="Mission" crumbs={[{ label: 'Missions', href: '/missions' }]} />
        <div className="page">
          <div className="page__inner">
            <ErrorState error={mission.error} onRetry={() => void mission.refetch()} />
          </div>
        </div>
      </>
    );
  }

  const detail = mission.data;
  const status = detail.mission.status;
  // `auto`: the factory plans it, so you can ask for a lane (#53 §10).
  const factory = detail.mission.workflowPreset === 'auto';
  const tone = missionTone(status);
  // Only what is addressed to me (or to nobody in particular) is "waiting on you";
  // the rule is the shared one the feed and Inbox use.
  // A limit card is shown in its own panel on every tab, not in the feed (P8).
  const pendingApprovals = detail.approvals.filter(
    (approval) => approval.status === 'PENDING' && !isLimitCard(approval)
      && isApprovalWaitingOnMember({ kind: approval.kind, addresseeIds: approval.addressees ?? [] }, meId),
  );

  return (
    <>
      <PageHeader
        title={detail.mission.title}
        crumbs={[{ label: 'Missions', href: '/missions' }, { label: factory ? 'Chosen by the factory' : detail.mission.workflowPreset }]}
        meta={
          <>
            <IdChip id={detail.mission.id} />
            <FromRoutine routineId={detail.mission.routineId ?? null} />
            <FromIssue missionId={detail.mission.id} linkId={detail.mission.issueLinkId ?? null} />
            {factory ? <PullRequestChips missionId={detail.mission.id} /> : null}
          </>
        }
        subtitle={<MissionSubtitle goal={detail.mission.goal} />}
        actions={
          <>
            <StatusBadge status={status} tone={tone} />
            {actionsFor(status, isPlanUnstarted(detail.tasks), detail.approvals.some((a) => a.kind === 'plan' && a.status === 'PENDING'), factory).map((action) => {
              // The factory's quick and standard lanes need no Done-when line (#53 §4): the
              // daemon decides at Plan, and keeps careful work a draft until it is ready.
              const gated = action.id === 'plan' && status === 'DRAFT'
                && (!factory || (detail.mission.laneRequest === 'careful' && action.lane === undefined));
              const notReady = gated && readiness?.ready !== true;
              return (
                // Not ready: its label already says what is left ("Answer 1 question to plan"), so a disabled button needs no hidden reason.
                <Button
                  key={`${action.id}${action.lane ?? ''}`}
                  variant={action.primary ? 'primary' : 'secondary'}
                  disabled={act.isPending || notReady}
                  onClick={() => (action.id === 'cancel' ? setConfirming('cancel') : act.mutate(
                    { action: action.id, ...(action.lane === undefined ? {} : { lane: action.lane }) },
                    // Careful work with no Done-when line stays a draft: Get it ready, on the feed, is where it goes next.
                    { onSuccess: (next) => { if (action.id === 'plan' && next.mission.status === 'DRAFT' && tab !== 'feed') navigate(`/missions/${id}`); } },
                  ))}
                >
                  <Icon name={action.icon} size={13} />
                  {notReady && readiness !== undefined ? readiness.label : action.label}
                </Button>
              );
            })}
            <Tooltip content="Delete mission">
              <Button iconOnly variant="ghost" aria-label="Delete mission" onClick={() => setConfirming('delete')}>
                <Icon name="trash" size={14} />
              </Button>
            </Tooltip>
          </>
        }
      />

      {act.isError && claimHeld(act.error) === null ? (
        <div style={{ padding: 'var(--s3) var(--s7) 0' }}>
          <ErrorState error={act.error} />
        </div>
      ) : null}
      {act.isError && claimHeld(act.error) !== null ? (
        // Someone is working on this tracker item: the daemon's words, Take over where allowed, Not now.
        <ClaimRefusal error={act.error} onClose={() => act.reset()} onTakenOver={() => act.mutate({ action: 'start' })} />
      ) : null}

      {/* On the feed, "Needs you" already says this, at the top, with the decision in reach. */}
      {pendingApprovals.length > 0 && tab !== 'feed' ? (
        // The decision is answered on the mission's own feed, next to the work it is about, rather than in the Inbox.
        <Banner
          as={Link}
          href={`/missions/${id}`}
          onClick={() => setFocusNeeds(true)}
          tone="warn"
          style={{ margin: 'var(--s3) var(--s7) 0', textDecoration: 'none', color: 'inherit' }}
          icon={<Icon name="approvals" size={15} />}
          action={<span className="btn">Review</span>}
        >
          <strong>{pluralize(pendingApprovals.length, 'decision')} waiting on you.</strong>{' '}
          {pendingApprovals[0]?.title}
        </Banner>
      ) : null}

      {staffingNotice ? (
        <div style={{ padding: 'var(--s3) var(--s7) 0' }}>
          <Banner
            tone="warn"
            icon={<Icon name="alert" size={15} />}
            action={
              <Button variant="ghost" onClick={() => clearMissionNotice(id)}>
                Dismiss
              </Button>
            }
          >
            <strong>The mission was created, but its staffing was not saved.</strong> {describeError(staffingNotice).detail} Set it
            per task from the plan, or in Team for the whole project.
          </Banner>
        </div>
      ) : null}

      {(status === 'BLOCKED' || status === 'PAUSED') && detail.mission.statusReason ? (
        <Banner tone="warn" style={{ margin: 'var(--s3) var(--s7) 0' }} icon={<Icon name="alert" size={15} />}>
          {detail.mission.statusReason}
        </Banner>
      ) : null}

      {detail.claim && detail.claim.state !== 'held' ? (
        <div style={{ padding: 'var(--s3) var(--s7) 0' }}>
          <ClaimBanner missionId={id} claim={detail.claim} />
        </div>
      ) : null}

      <LimitCardPanel approvalId={detail.limits?.pendingApprovalId ?? null} />

      <Tabs label="Mission sections" style={{ marginTop: 'var(--s3)' }}>
        <TabLink id={id} tab="feed" current={tab} label="Feed" count={needsYouCount(detail, meId)} />
        <TabLink id={id} tab="plan" current={tab} label="Plan" count={detail.tasks.length} />
        <TabLink id={id} tab="timeline" current={tab} label="Timeline" />
        <TabLink id={id} tab="artifacts" current={tab} label="Artifacts" count={liveArtifactCount(detail)} />
        <TabLink id={id} tab="checks" current={tab} label="Checks & Gates" count={detail.checks.length} />
        <TabLink id={id} tab="metrics" current={tab} label="Metrics" />
      </Tabs>

      {renderPane(tab, detail, focusNeeds, () => setFocusNeeds(false))}

      {/* Over every tab: a held step's terminal stays open while you move around the mission. */}
      {(() => {
        const held = terminalTaskId === null ? undefined : detail.tasks.find((t) => t.id === terminalTaskId);
        return held ? <TerminalPanel key={held.id} task={held} detail={detail} /> : null;
      })()}

      {confirming === 'cancel' ? (
        <ConfirmDialog
          title="Cancel this mission?"
          confirmLabel="Cancel mission"
          destructive
          busy={act.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            act.mutate({ action: 'cancel' });
            setConfirming(null);
          }}
          body={
            <>
              <p>
                Running tasks stop as soon as they reach a safe point. Work already committed to task branches stays where it is — nothing is
                deleted.
              </p>
              <p style={{ marginTop: 'var(--s3)' }}>A cancelled mission cannot be resumed, but you can duplicate it into a new one.</p>
            </>
          }
        />
      ) : null}

      {confirming === 'delete' ? (
        <ConfirmDialog
          title="Delete this mission?"
          confirmLabel="Delete permanently"
          destructive
          busy={remove.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            remove.mutate(undefined, {
              onSuccess: () => {
                setConfirming(null);
                navigate('/missions');
              },
            })
          }
          body={
            <p>
              This removes the mission, its plan, its event log and its artifact manifests. Git branches and worktrees are left alone. This
              cannot be undone.
            </p>
          }
        />
      ) : null}
    </>
  );
}

function renderPane(tab: MissionTab, detail: MissionDetailView, focusNeeds: boolean, onFocused: () => void): JSX.Element {
  switch (tab) {
    case 'feed':
      return <FeedPane detail={detail} focusNeeds={focusNeeds} onFocused={onFocused} />;
    case 'plan':
      return <PlanPane detail={detail} />;
    case 'timeline':
      return <TimelinePane detail={detail} />;
    case 'artifacts':
      return <ArtifactsPane detail={detail} />;
    case 'checks':
      return <ChecksPane detail={detail} />;
    case 'metrics':
      return <MetricsPane detail={detail} />;
  }
}

function TabLink({
  id,
  tab,
  current,
  label,
  count,
}: {
  id: string;
  tab: MissionTab;
  current: MissionTab;
  label: string;
  count?: number;
}): JSX.Element {
  return (
    <Tab as={Link} href={tab === 'feed' ? `/missions/${id}` : `/missions/${id}/${tab}`} selected={current === tab} count={count !== undefined && count > 0 ? count : undefined}>
      {label}
    </Tab>
  );
}

/** A new plan for what is left, keeping what is done (replan spec). */
const REPLAN_REST: MissionAction = { id: 'replan', label: 'Plan the rest again', icon: 'sparkle' };

interface MissionAction {
  readonly id: 'plan' | 'replan' | 'start' | 'pause' | 'resume' | 'cancel';
  readonly label: string;
  readonly icon: IconName;
  readonly primary?: boolean;
  /** Plan quick / Plan careful, for a mission the factory plans. */
  readonly lane?: 'quick' | 'careful';
}

/**
 * Which controls make sense is a function of the mission's state machine, not
 * of what the user might want - offering Start on a running mission is how a
 * UI teaches people that its buttons are unreliable.
 */
function actionsFor(status: MissionStatus, planUnstarted: boolean, planAsked: boolean, factory: boolean): readonly MissionAction[] {
  if (isTerminalMissionStatus(status)) return [];
  switch (status) {
    case 'DRAFT':
      return [
        { id: 'plan', label: 'Plan', icon: 'sparkle', primary: true },
        // The factory chooses the lane; these let you choose it instead.
        ...(factory
          ? [{ id: 'plan', lane: 'quick', label: 'Plan quick', icon: 'sparkle' } as const, { id: 'plan', lane: 'careful', label: 'Plan careful', icon: 'sparkle' } as const]
          : []),
      ];
    case 'PLANNING':
      return [{ id: 'cancel', label: 'Cancel', icon: 'x' }];
    case 'AWAITING_PLAN_APPROVAL':
      // Re-plan is how a user answers a plan that does not fit the goal - a
      // preset fallback, say - without cancelling and retyping the mission.
      // While the plan card asks, Approve on it is how the mission starts:
      // Start beside it only ever answered "The plan is waiting for your approval".
      return [
        ...(planAsked ? [] : [{ id: 'start', label: 'Start', icon: 'play', primary: true } as const]),
        { id: 'plan', label: 'Re-plan', icon: 'sparkle' },
        { id: 'cancel', label: 'Cancel', icon: 'x' },
      ];
    case 'PAUSED':
      // Paused partway through, a person may want a different rest rather than more of the same.
      return [
        { id: 'resume', label: 'Resume', icon: 'play', primary: true },
        ...(planUnstarted ? [] : [REPLAN_REST]),
        { id: 'cancel', label: 'Cancel', icon: 'x' },
      ];
    case 'BLOCKED':
      // Blocked before any of its plan ran: a rejected plan, or planning that
      // failed. Re-plan is the way forward, for anyone on the mission and not
      // only whoever was asked; Resume would run the plan nobody accepted.
      if (planUnstarted) {
        return [
          { id: 'plan', label: 'Re-plan', icon: 'sparkle', primary: true },
          { id: 'resume', label: 'Resume', icon: 'play' },
          { id: 'cancel', label: 'Cancel', icon: 'x' },
        ];
      }
      // Blocked partway through: Re-plan would have thrown away what is done, so
      // the way to change course is a new plan for the rest (replan spec).
      return [
        { id: 'resume', label: 'Resume', icon: 'play', primary: true },
        REPLAN_REST,
        { id: 'cancel', label: 'Cancel', icon: 'x' },
      ];
    default:
      return [
        { id: 'pause', label: 'Pause', icon: 'pause' },
        { id: 'cancel', label: 'Cancel', icon: 'x' },
      ];
  }
}

function MissionSkeleton(): JSX.Element {
  return (
    <>
      <div className="topbar">
        <div className="topbar__titles" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton height={11} width={160} />
          <Skeleton height={20} width={320} />
        </div>
      </div>
      <div className="page">
        <div className="page__inner">
          <SkeletonList rows={4} />
        </div>
      </div>
    </>
  );
}

export function MissionNotFound(): JSX.Element {
  return (
    <>
      <PageHeader title="Mission not found" crumbs={[{ label: 'Missions', href: '/missions' }]} />
      <div className="page">
        <div className="page__inner">
          <Card>
            <Empty
              icon="search"
              title="That mission no longer exists"
              body="It may have been deleted from another window."
              action={
                <Link href="/missions" className="btn">
                  Back to missions
                </Link>
              }
            />
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * Artifacts a newer version has not replaced, which is what the tab lists by
 * default. The detail carries every version, and counting them all would make
 * the tab promise rows the list does not show.
 */
function liveArtifactCount(detail: MissionDetailView): number {
  const replaced = new Set(detail.artifacts.flatMap((a) => (a.supersedes ? [a.supersedes as string] : [])));
  return detail.artifacts.filter((a) => !replaced.has(a.id)).length;
}

/**
 * How many feed cards need me, counted from the detail already on screen.
 *
 * The feed itself is fetched by its pane with its own "done" limit; a second
 * subscription here only for a number would double the request on every task
 * event. One card per task, as the feed has, using the rules the feed's "Needs
 * you" section uses: any open approval addressed to me, checks included; the
 * plan only while `planStanding` says it is open and on me, so a stale plan
 * request is not counted and a rejected plan waiting for my re-plan is.
 *
 * The Inbox and the nav badge deliberately leave that rejected plan out: they
 * list requests to answer, and a rejected plan is no longer a request, only
 * work waiting to be re-planned from the mission itself.
 */
function needsYouCount(detail: MissionDetailView, meId: string | null): number {
  const cards = new Set<string>();
  for (const approval of detail.approvals) {
    if (approval.status !== 'PENDING' || approval.kind === 'plan' || approval.taskId === null) continue;
    if (isApprovalForMember(approval.addressees ?? [], meId)) cards.add(approval.taskId);
  }
  for (const task of detail.tasks) {
    if (task.status !== 'AWAITING_HUMAN') continue;
    const people = { assigneeId: task.assignee?.id ?? null, claimableIds: task.claimable.map((c) => c.id), escalatedToIds: task.escalatedTo.map((a) => a.id) };
    if (isHumanTaskForMember(people, meId)) cards.add(task.id);
  }
  const replaced = new Set(detail.artifacts.flatMap((a) => (a.supersedes ? [a.supersedes as string] : [])));
  const plan = detail.artifacts.find((a) => a.type === 'MissionPlan' && !replaced.has(a.id));
  const standing = planStanding({
    missionStatus: detail.mission.status,
    planCreatedAt: plan?.createdAt ?? null,
    approvals: detail.approvals.map((a) => ({ id: a.id, kind: a.kind, status: a.status, createdAt: a.createdAt, addresseeIds: a.addressees ?? [] })),
    tasks: detail.tasks,
  }, meId);
  if (standing.forMe) cards.add('plan');
  return cards.size;
}

/** The open "raise or keep paused" card of a mission stopped at its limit, on every tab (P8). */
function LimitCardPanel({ approvalId }: { approvalId: string | null }): JSX.Element | null {
  const approvals = useApprovals();
  const view = approvalId === null ? undefined : approvals.data?.find((a) => a.approval.id === approvalId);
  if (view === undefined || view.approval.status !== 'PENDING') return null;
  return (
    <section style={{ margin: 'var(--s3) var(--s7) 0' }} aria-label="Limit reached">
      <ApprovalCard view={view} compact headingLevel={2} />
    </section>
  );
}

/**
 * Under the title: a mission from a tracker item reads "GitHub #97 · started by
 * Ana · Open issue" and a short summary, with the whole task behind a
 * disclosure (#105); any other mission shows its goal as written.
 */
function MissionSubtitle({ goal }: { goal: string }): JSX.Element {
  const parts = parseTrackerGoal(goal);
  if (parts === null) return <>{goal}</>;
  return (
    <div className="mission-subtitle">
      <p className="mission-subtitle__lead">
        <span>{parts.label} {parts.key}</span>
        <span aria-hidden="true"> · </span>
        <span>started by {parts.starter}</span>
        <span aria-hidden="true"> · </span>
        <Button variant="ghost" size="sm" className="mission-subtitle__open" onClick={() => void window.tandemise.openExternal(parts.url)}>
          <Icon name="externalLink" size={11} />
          Open the issue<span className="visually-hidden"> {parts.key} in {parts.label}</span>
        </Button>
      </p>
      {parts.summary !== '' ? <p className="mission-subtitle__summary">{parts.summary}</p> : null}
      <details className="mission-subtitle__details">
        <summary>The task as written</summary>
        <pre className="mission-subtitle__goal">{goal}</pre>
      </details>
    </div>
  );
}

/** "Pull request #110" once the ship step opened one (#113): the link a reviewer wants, on the mission itself. */
function PullRequestChips({ missionId }: { missionId: string }): JSX.Element | null {
  const ship = useShip(missionId);
  const prs = ship.data?.prs.filter((pr) => pr.state === 'opened') ?? [];
  if (prs.length === 0) return null;
  return (
    <>
      {prs.map((pr) => (
        <Tooltip key={pr.url} content={`Open ${pr.repo}#${pr.number} on GitHub`}>
          <button
            type="button"
            className="chip chip--muted"
            data-pr-link={pr.url}
            onClick={() => void window.tandemise.openExternal(pr.url)}
          >
            <Icon name="externalLink" size={11} />
            Pull request #{pr.number}
          </button>
        </Tooltip>
      ))}
    </>
  );
}

/** "From issue #12" on a mission a GitHub issue created (P14); opens the issue in the browser. */
function FromIssue({ missionId, linkId }: { missionId: string; linkId: string | null }): JSX.Element | null {
  const issues = useIssues();
  if (linkId === null) return null;
  const link = issues.data?.links.find((l) => l.id === linkId && l.missionId === missionId);
  if (link === undefined) return null;
  return (
    <Tooltip content={`Open ${link.githubRepo}#${link.number} on GitHub`}>
      <button
        type="button"
        className="chip chip--muted"
        aria-label={`From issue #${link.number}`}
        onClick={() => void window.tandemise.openExternal(link.url)}
      >
        <Icon name="externalLink" size={11} />
        From issue #{link.number}
      </button>
    </Tooltip>
  );
}

/** "From routine: <name>" on a mission a routine added (P11); nothing for one a person created. */
function FromRoutine({ routineId }: { routineId: string | null }): JSX.Element | null {
  const routines = useRoutines();
  if (routineId === null) return null;
  const name = routines.data?.find((view) => view.routine.id === routineId)?.routine.name;
  return (
    <Tooltip content="Open the routine that added this mission">
      <Link href="/missions/routines" className="chip chip--muted">
        <Icon name="clock" size={11} />
        From routine: {name ?? 'a routine'}
      </Link>
    </Tooltip>
  );
}
