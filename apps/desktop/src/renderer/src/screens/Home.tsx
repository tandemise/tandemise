import { Link, useLocation } from 'wouter';
import type { HomeMetricsView, HomeView, MissionSummary } from '@tandemise/api-contract';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { WhoIsWorking } from '../components/WhoIsWorking.js';
import { Empty, ErrorState, SectionHead, SkeletonCards, SkeletonList, Stat, StatusBadge, StatusDot } from '../components/primitives.js';
import { ApprovalPreviewCard } from './approvals/ApprovalCard.js';
import { useDaemonMutation, useHome, useRoles } from '../lib/queries.js';
import { useWorkspaceId } from '../lib/workspace.js';
import { showFlash } from '../lib/notices.js';
import { missionOfItem, useInbox, type InboxItem } from '../lib/inbox.js';
import { QuietRow, StalledRow } from './inbox/LivenessRows.js';
import { ParkedRow } from './inbox/ParkedRow.js';
import { buildTimeline } from '../lib/events.js';
import { useActors } from '../lib/team.js';
import { healthTone, missionTone, pluralize, relativeTime } from '../lib/format.js';
import { Badge, Banner, Button, Card, Chip, Tooltip, Truncate } from '@tandemise/design/react';

export function Home(): JSX.Element {
  const home = useHome();
  const roles = useRoles();
  // The same inbox read as the nav badge. The badge counts everything for me;
  // Home leaves out checks, which nothing waits on.
  const needsMe = useInbox().needsMe;
  const [, navigate] = useLocation();
  const workspaceId = useWorkspaceId();
  // Rendered by the daemon from stored facts; it opens in the reader as the project's next version.
  const report = useDaemonMutation((daemon, workspace: string) => daemon.writeStatusReport(workspace), ['artifacts']);
  const writeReport = (): void => {
    if (!workspaceId) return;
    report.mutate(workspaceId, {
      onSuccess: (written) => {
        showFlash(`Status report v${written.version} written from stored facts.`);
        navigate(`/artifacts/${written.artifactId}`);
      },
    });
  };

  const roleNames = new Map((roles.data ?? []).map((role) => [role.id, role.name]));
  const actors = useActors();
  const raw = home.data;
  // A blocked mission already in "Needs you now" (its card, its step, its Stalled row) is not shown twice (P9).
  const listed = new Set(needsMe.map(missionOfItem));
  const data = raw === undefined ? undefined : { ...raw, blockedMissions: raw.blockedMissions.filter((s) => !listed.has(s.mission.id)) };
  // The desk's month banner says the project's warning with the rule it triggers first (P10): not twice.
  const monthSaid = (data?.banners ?? []).some((b) => b.kind === 'month_warn');
  const alerts = (data?.limitAlerts ?? []).filter((a) => !(monthSaid && a.scope === 'project' && a.level === 'soft'));

  return (
    <>
      <PageHeader
        title={headline(data, needsMe.length)}
        subtitle={data?.workspace ? `${data.workspace.name} workspace` : 'Your agent workforce at a glance'}
        actions={
          <>
            <Tooltip content="A report of every mission, written from stored facts; no model writes it">
              <Button disabled={report.isPending || !workspaceId} onClick={writeReport}>
                <Icon name="artifacts" size={14} />
                {report.isPending ? 'Writing…' : 'Status report'}
              </Button>
            </Tooltip>
            <Button variant="primary" onClick={() => navigate('/missions/new')}>
              <Icon name="plus" size={14} />
              New mission
            </Button>
          </>
        }
      />

      <div className="page">
        <div className="page__inner">
          {home.isError ? <ErrorState error={home.error} onRetry={() => void home.refetch()} /> : null}
          {report.isError ? <ErrorState error={report.error} onRetry={writeReport} /> : null}

          {/* The desk (P10): five numbers, each opening the view behind it. */}
          {data?.metrics ? <Desk metrics={data.metrics} needsYou={needsMe.filter((i) => i.kind !== 'stalled').length} /> : null}

          {(data?.banners ?? []).length > 0 ? (
            <section className="section" aria-label="What this means">
              <div className="stack">
                {(data?.banners ?? []).map((banner) => (
                  <Banner
                    as={Link}
                    key={banner.kind}
                    href={banner.href}
                    tone="warn"
                    style={{ textDecoration: 'none', color: 'inherit' }}
                    icon={<Icon name="alert" size={15} />}
                    action={<span className="btn">{banner.kind === 'wip_full' ? 'See backlog' : 'See limit'}</span>}
                  >
                    {banner.text}
                  </Banner>
                ))}
              </div>
            </section>
          ) : null}

          {/* At or over a limit's warning level (P8): said with its numbers, above everything else. */}
          {alerts.length > 0 ? (
            <section className="section" aria-label="Limits">
              <div className="stack">
                {alerts.map((alert) => (
                  <Banner
                    as={Link}
                    key={`${alert.scope}-${alert.missionId ?? 'project'}`}
                    href={alert.missionId === null ? (alert.level === 'hard' ? '/inbox' : '/project') : `/missions/${alert.missionId}/metrics`}
                    tone="warn"
                    style={{ textDecoration: 'none', color: 'inherit' }}
                    icon={<Icon name="alert" size={15} />}
                    action={<span className="btn">{alert.level === 'hard' ? 'Decide' : 'See limit'}</span>}
                  >
                    <strong>{alert.missionTitle ?? 'This project'}:</strong> {alert.text}
                  </Banner>
                ))}
              </div>
            </section>
          ) : null}

          <section className="section">
            <SectionHead
              title="Needs you now"
              meta={data ? describeAttention(needsMe.length, data.blockedMissions.length) : undefined}
            />
            {home.isPending ? (
              <SkeletonCards count={2} />
            ) : needsMe.length === 0 && (data?.blockedMissions.length ?? 0) === 0 ? (
              <Card>
                <Empty
                  icon="check"
                  title="Nothing is waiting on you"
                  body="Every mission is either running on its own or finished. New approvals will land here the moment an agent needs a decision."
                />
              </Card>
            ) : (
              <div className="stack">
                {needsMe.slice(0, 2).map((item) =>
                  item.kind === 'approval' ? (
                    <ApprovalPreviewCard key={item.id} view={item.view} />
                  ) : item.kind === 'task' ? (
                    <HumanTaskRow key={item.id} item={item} />
                  ) : item.kind === 'stalled' ? (
                    <StalledRow key={item.id} stalled={item.stalled} bordered />
                  ) : item.kind === 'quiet' ? (
                    <QuietRow key={item.id} run={item.run} bordered />
                  ) : item.kind === 'parked' ? (
                    <ParkedRow key={item.id} parked={item.parked} bordered />
                  ) : (
                    <RefinementRow key={item.id} item={item} />
                  ),
                )}
                {needsMe.length > 2 ? (
                  <Link href="/inbox" className="btn btn--ghost" style={{ alignSelf: 'flex-start' }}>
                    {pluralize(needsMe.length - 2, 'more request')} in your inbox
                    <Icon name="chevronRight" size={13} />
                  </Link>
                ) : null}
                {(data?.blockedMissions ?? []).map((summary) => (
                  <MissionRow key={summary.mission.id} summary={summary} />
                ))}
              </div>
            )}
          </section>

          <section className="section" aria-label="Who's working on what">
            <SectionHead title="Who's working on what" />
            <WhoIsWorking />
          </section>

          <div className="split">
            <section className="section">
              <SectionHead
                title="Active missions"
                meta={data ? pluralize(data.activeMissions.length, 'mission') : undefined}
                action={
                  <Link href="/missions" className="btn btn--ghost">
                    All missions
                    <Icon name="chevronRight" size={13} />
                  </Link>
                }
              />
              {home.isPending ? (
                <SkeletonList rows={3} />
              ) : (data?.activeMissions.length ?? 0) === 0 ? (
                <Card>
                  <Empty
                    icon="flag"
                    title="No missions running"
                    body="Describe an outcome in one sentence and Tandemise will plan the work, route it to your runtimes, and bring you the decisions."
                    action={
                      <Button variant="primary" onClick={() => navigate('/missions/new')}>
                        <Icon name="plus" size={14} />
                        Start a mission
                      </Button>
                    }
                  />
                </Card>
              ) : (
                <div className="list">
                  {(data?.activeMissions ?? []).map((summary) => (
                    <MissionListRow key={summary.mission.id} summary={summary} />
                  ))}
                </div>
              )}
            </section>

            <section className="section">
              <SectionHead title="Runtime health" action={<Link href="/runtimes" className="btn btn--ghost">Manage</Link>} />
              {home.isPending ? (
                <SkeletonList rows={2} />
              ) : (data?.runtimes.length ?? 0) === 0 ? (
                <Card>
                  <Empty
                    icon="runtimes"
                    title="No runtimes configured"
                    body="Tandemise needs at least one agent runtime to do any work. Discovery finds the CLIs already installed on this machine."
                    action={
                      <Link href="/runtimes" className="btn">
                        Discover runtimes
                      </Link>
                    }
                  />
                </Card>
              ) : (
                <div className="list">
                  {(data?.runtimes ?? []).map((runtime) => (
                    <div key={runtime.profile.id} className="list__row">
                      <StatusDot tone={healthTone(runtime.health.state)} />
                      <div className="list__main">
                        <div className="list__title">{runtime.profile.name}</div>
                        <Truncate as="div" className="list__subtitle">
                          {runtime.health.version ? `v${runtime.health.version}` : 'version unknown'}
                          <span className="sep">·</span>
                          {runtime.health.detail}
                        </Truncate>
                      </div>
                      <div className="list__aside">
                        {runtime.activeRuns > 0 ? (
                          <Badge tone="running">
                            {runtime.activeRuns}/{runtime.profile.maxConcurrent} active
                          </Badge>
                        ) : (
                          <Chip muted>idle</Chip>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 'var(--s6)' }}>
                <SectionHead title="Recent activity" />
                {home.isPending ? (
                  <SkeletonList rows={3} />
                ) : (data?.recentEvents.length ?? 0) === 0 ? (
                  <Card>
                    <Empty icon="pulse" title="Quiet so far" body="Semantic events from every mission appear here as work happens." />
                  </Card>
                ) : (
                  <Card>
                    <div className="timeline">
                      {buildTimeline(data?.recentEvents ?? [], roleNames, actors.name)
                        .slice(-7)
                        .reverse()
                        .map((item) => (
                          <div key={item.key} className="tlitem" data-tone={item.tone}>
                            <span className="tlitem__node">
                              <Icon name={item.icon} size={12} />
                            </span>
                            <div className="tlitem__body">
                              <div className="tlitem__title">{item.title}</div>
                              <div className="tlitem__meta">{relativeTime(item.at)}</div>
                            </div>
                          </div>
                        ))}
                    </div>
                  </Card>
                )}
              </div>
            </section>
          </div>

          {(data?.recentMissions.length ?? 0) > 0 ? (
            <section className="section">
              <SectionHead title="Recently finished" />
              <div className="list">
                {(data?.recentMissions ?? []).map((summary) => (
                  <MissionListRow key={summary.mission.id} summary={summary} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}

/**
 * The five numbers a person opening the app wants first. "Needs you" and
 * "Stalled" never count the same thing: a stalled mission is counted once,
 * as stalled, though it also sits in "Needs you now" below.
 */
function Desk({ metrics, needsYou }: { metrics: HomeMetricsView; needsYou: number }): JSX.Element {
  const month = [...metrics.monthUsage].sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1))[0];
  const minutes = Math.round(metrics.usage.agentMinutes * 10) / 10;
  return (
    <section className="section" aria-label="Desk">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <DeskCard
          label="Needs you"
          value={String(needsYou)}
          note={needsYou === 0 ? 'Nothing waits on you' : 'Decisions and steps in your inbox'}
          href="/inbox"
        />
        <DeskCard
          label="Working on"
          value={metrics.wipLimit === null ? String(metrics.active) : `${metrics.active} of ${metrics.wipLimit}`}
          note={`${metrics.queued} queued${metrics.wipLimit === null ? ' · no limit' : ''}`}
          href="/missions/in-progress"
        />
        <DeskCard
          label="Criteria verified"
          value={metrics.criteriaTotal === 0 ? 'None yet' : `${metrics.criteriaVerified} of ${metrics.criteriaTotal}`}
          muted={metrics.criteriaTotal === 0}
          note={metrics.criteriaTotal === 0 ? 'No mission in progress has criteria' : `Across ${pluralize(metrics.criteriaMissions, 'mission')} in progress`}
          href="/missions/in-progress"
        />
        <DeskCard
          label="This month"
          value={month === undefined ? `${minutes} agent min` : month.percent === null ? 'Not reported' : `${Math.floor(month.percent)}%`}
          muted={month === undefined}
          note={month === undefined ? 'No monthly limit set' : `${month.bar} this month`}
          href="/project"
        />
        <DeskCard
          label="Stalled"
          value={String(metrics.stalled)}
          note={metrics.stalled === 0 ? 'Everything can move' : 'Nothing moves them'}
          href="/inbox/stalled"
        />
      </div>
    </section>
  );
}

function DeskCard({ label, value, note, href, muted = false }: { label: string; value: string; note: string; href: string; muted?: boolean }): JSX.Element {
  return (
    <Link href={href} data-desk={label} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
      <Stat label={label} value={value} note={note} muted={muted} />
    </Link>
  );
}

function MissionListRow({ summary }: { summary: MissionSummary }): JSX.Element {
  const tone = missionTone(summary.mission.status);
  const { progress } = summary;
  const percent = progress.totalTasks === 0 ? 0 : Math.round((progress.completed / progress.totalTasks) * 100);

  return (
    <Link href={`/missions/${summary.mission.id}`} className="list__row">
      <StatusDot tone={tone} live={tone === 'running'} />
      <div className="list__main">
        <div className="list__title">{summary.mission.title}</div>
        <Truncate as="div" className="list__subtitle">
          {summary.currentActivity ?? summary.mission.goal}
          {summary.repositoryName ? (
            <>
              <span className="sep">·</span>
              <span className="dim">{summary.repositoryName}</span>
            </>
          ) : null}
        </Truncate>
      </div>
      <div className="list__aside">
        {progress.totalTasks > 0 ? (
          <div style={{ width: 76 }}>
            <div className="meter" aria-hidden="true">
              <div className={`meter__fill`} style={{ width: `${percent}%`, background: `var(--status-${tone})` }} />
            </div>
            <div className="dim" style={{ fontSize: 'var(--fs-micro)', marginTop: 3, textAlign: 'right' }}>
              {progress.completed}/{progress.totalTasks} tasks
            </div>
          </div>
        ) : null}
        <StatusBadge status={summary.mission.status} tone={tone} />
        <span className="dim" style={{ fontSize: 'var(--fs-xs)', width: 62, textAlign: 'right' }}>
          {relativeTime(summary.lastEventAt ?? summary.mission.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

/** A blocked mission gets a full card, not a row: it is asking for something. */
function MissionRow({ summary }: { summary: MissionSummary }): JSX.Element {
  return (
    <Link href={`/missions/${summary.mission.id}`} className="card" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
      <div className="row">
        <Badge tone="blocked">
          <Icon name="alert" size={12} />
          Blocked
        </Badge>
        <span style={{ fontWeight: 560 }}>{summary.mission.title}</span>
        <div className="spacer" />
        <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>{relativeTime(summary.lastEventAt)}</span>
      </div>
      <p className="muted" style={{ marginTop: 'var(--s2)', fontSize: 'var(--fs-sm)', lineHeight: 1.55 }}>
        {summary.mission.statusReason ?? summary.currentActivity ?? 'This mission stopped and needs a human to move it forward.'}
      </p>
    </Link>
  );
}

/** A task parked for me, on the one line the Inbox gives it; opening it goes to its mission. */
function HumanTaskRow({ item }: { item: Extract<InboxItem, { kind: 'task' }> }): JSX.Element {
  return (
    <Link href={`/missions/${item.task.missionId}`} className="list__row list__row--bordered" style={{ textDecoration: 'none', color: 'inherit' }}>
      <StatusDot tone="blocked" />
      <div className="list__main">
        <div className="list__title">{item.task.title}</div>
        <div className="list__subtitle truncate">Yours to do · {item.task.missionTitle}</div>
      </div>
      <Icon name="chevronRight" size={13} className="dim" />
    </Link>
  );
}

function RefinementRow({ item }: { item: Extract<InboxItem, { kind: 'refinement' }> }): JSX.Element {
  return (
    <Link href={`/missions/${item.refinement.missionId}`} className="list__row list__row--bordered" style={{ textDecoration: 'none', color: 'inherit' }}>
      <StatusDot tone="blocked" />
      <div className="list__main">
        <div className="list__title">Refinement: {item.refinement.toDecide} to decide</div>
        <div className="list__subtitle truncate">Get it ready to plan · {item.refinement.missionTitle}</div>
      </div>
      <Icon name="chevronRight" size={13} className="dim" />
    </Link>
  );
}

function describeAttention(waiting: number, blocked: number): string {
  const parts: string[] = [];
  if (waiting > 0) parts.push(pluralize(waiting, 'request'));
  if (blocked > 0) parts.push(`${pluralize(blocked, 'mission')} blocked`);
  return parts.length > 0 ? parts.join(' · ') : 'all clear';
}

/**
 * The title states what the workforce needs, in priority order. A time-of-day
 * greeting looked friendly but told the user nothing they could act on - and
 * "Still up" at 2am read as a judgement rather than a status.
 */
function headline(data: HomeView | undefined, waiting: number): string {
  if (!data) return 'Home';
  const blocked = data.blockedMissions.length;
  const running = data.activeMissions.length;
  if (waiting > 0) return `${pluralize(waiting, 'request')} waiting on you`;
  if (blocked > 0) return `${pluralize(blocked, 'mission')} blocked`;
  if (running > 0) return `${pluralize(running, 'mission')} running`;
  return 'Nothing needs you';
}
