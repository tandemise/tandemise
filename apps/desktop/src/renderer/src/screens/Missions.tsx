import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { MissionStatus } from '@tandemise/domain';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { Empty, ErrorState, IdChip, SkeletonList, StatusBadge, StatusDot } from '../components/primitives.js';
import { useMissions, useRoutines } from '../lib/queries.js';
import { useListNavigation } from '../lib/keyboard.js';
import { missionTone, pluralize, relativeTime } from '../lib/format.js';
import { Backlog } from './missions/Backlog.js';
import { Routines } from './missions/Routines.js';
import { Badge, Banner, Button, Card, Chip, Tab, Tabs, Truncate } from '@tandemise/design/react';

type Filter = 'backlog' | 'routines' | 'active' | 'blocked' | 'finished' | 'all' | 'progress';

/**
 * In progress as the desk counts it (P7's rule): not a draft, not paused, not
 * finished. Wider than the Active tab, which leaves blocked missions to "Needs
 * attention"; Home's "Working on" and "Criteria verified" cards open this view.
 */
const IN_PROGRESS = (status: MissionStatus): boolean => status !== 'DRAFT' && status !== 'PAUSED' && !FINISHED.includes(status);

// Drafts live in the Backlog tab: they are waiting to be planned, not being worked on.
const ACTIVE: readonly MissionStatus[] = ['PLANNING', 'EXECUTING', 'REVIEWING', 'QA', 'READY_TO_SHIP', 'OBSERVING'];
const BLOCKED: readonly MissionStatus[] = ['BLOCKED', 'AWAITING_PLAN_APPROVAL', 'PAUSED'];
const FINISHED: readonly MissionStatus[] = ['COMPLETE', 'RELEASED', 'FAILED', 'CANCELLED'];

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'routines', label: 'Routines' },
  { value: 'active', label: 'Active' },
  { value: 'blocked', label: 'Needs attention' },
  { value: 'finished', label: 'Finished' },
  { value: 'all', label: 'All' },
];

export function Missions({ initial = 'active' }: { initial?: Filter } = {}): JSX.Element {
  const [filter, setFilter] = useState<Filter>(initial);
  // The filtered routes (/missions/backlog, /missions/routines, …) render this same
  // screen, so React keeps it mounted between them: follow the route, not the first one.
  useEffect(() => setFilter(initial), [initial]);
  const [query, setQuery] = useState('');
  const [, navigate] = useLocation();
  const missions = useMissions();
  const routines = useRoutines();

  const counts = useMemo(() => {
    const all = missions.data ?? [];
    return {
      backlog: all.filter((m) => m.mission.status === 'DRAFT').length,
      active: all.filter((m) => ACTIVE.includes(m.mission.status)).length,
      blocked: all.filter((m) => BLOCKED.includes(m.mission.status)).length,
      finished: all.filter((m) => FINISHED.includes(m.mission.status)).length,
      all: all.length,
      progress: all.filter((m) => IN_PROGRESS(m.mission.status)).length,
      routines: routines.data?.length ?? 0,
    };
  }, [missions.data, routines.data]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (missions.data ?? [])
      .filter((summary) => {
        if (filter === 'backlog' || filter === 'routines') return false;
        if (filter === 'active') return ACTIVE.includes(summary.mission.status);
        if (filter === 'blocked') return BLOCKED.includes(summary.mission.status);
        if (filter === 'finished') return FINISHED.includes(summary.mission.status);
        if (filter === 'progress') return IN_PROGRESS(summary.mission.status);
        return true;
      })
      .filter(
        (summary) =>
          needle.length === 0 ||
          summary.mission.title.toLowerCase().includes(needle) ||
          summary.mission.goal.toLowerCase().includes(needle),
      );
  }, [missions.data, filter, query]);

  // The Backlog tab has its own keys (it moves rows as well as selecting them).
  const focused = useListNavigation(filter === 'backlog' || filter === 'routines' ? 0 : visible.length, (index) => {
    const target = visible[index];
    if (target) navigate(`/missions/${target.mission.id}`);
  });

  return (
    <>
      <PageHeader
        title="Missions"
        subtitle="Every outcome the workforce is pursuing, past and present."
        actions={
          <>
            <div className="search" style={{ width: 220 }}>
              <Icon name="search" size={14} className="search__icon" />
              <input
                className="input"
                type="search"
                aria-label="Filter missions"
                placeholder="Filter missions…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Link href="/missions/new" className="btn btn--primary">
              <Icon name="plus" size={14} />
              New mission
            </Link>
          </>
        }
      />

      <Tabs label="Which missions">
        {FILTERS.map((option) => (
          <Tab key={option.value} selected={filter === option.value} onClick={() => setFilter(option.value)} count={counts[option.value]}>
            {option.label}
          </Tab>
        ))}
      </Tabs>

      <div className="page">
        <div className="page__inner">
          {missions.isError ? <ErrorState error={missions.error} onRetry={() => void missions.refetch()} /> : null}
          {filter === 'progress' ? (
            <Banner
              style={{ marginBottom: 'var(--s4)' }}
              icon={<Icon name="activity" size={15} className="dim" />}
              action={
                <Button onClick={() => setFilter('all')}>
                  Show all missions
                </Button>
              }
            >
              Showing the {pluralize(counts.progress, 'mission')} in progress, blocked ones included: the work Home counts.
            </Banner>
          ) : null}

          {filter === 'backlog' ? (
            <Backlog />
          ) : filter === 'routines' ? (
            <Routines />
          ) : missions.isPending ? (
            <SkeletonList rows={5} />
          ) : visible.length === 0 ? (
            <Card>
              {query.length > 0 ? (
                <Empty icon="search" title={`Nothing matches “${query}”`} body="Try a shorter phrase, or clear the filter to see every mission." />
              ) : (
                <Empty
                  icon="flag"
                  title={filter === 'active' ? 'No active missions' : 'Nothing here yet'}
                  body="A mission starts with one sentence describing the outcome you want. Tandemise plans the work, picks the runtimes, and brings you only the decisions that need a human."
                  action={
                    <Link href="/missions/new" className="btn btn--primary btn--lg">
                      <Icon name="plus" size={14} />
                      New mission
                    </Link>
                  }
                />
              )}
            </Card>
          ) : (
            <>
              <div className="list">
                {visible.map((summary, index) => {
                  const tone = missionTone(summary.mission.status);
                  const { progress } = summary;
                  const percent = progress.totalTasks === 0 ? 0 : Math.round((progress.completed / progress.totalTasks) * 100);
                  return (
                    <Link
                      key={summary.mission.id}
                      href={`/missions/${summary.mission.id}`}
                      className="list__row"
                      data-active={index === focused}
                    >
                      <StatusDot tone={tone} live={tone === 'running'} />
                      <div className="list__main">
                        <div className="list__title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <Truncate>{summary.mission.title}</Truncate>
                          {/* Inside the row's link, so not a second control: copied from the mission's own page. */}
                          <IdChip id={summary.mission.id} interactive={false} />
                        </div>
                        <Truncate as="div" className="list__subtitle">
                          {summary.currentActivity ?? summary.mission.goal}
                        </Truncate>
                      </div>
                      <div className="list__aside">
                        {/* The Done-when ledger at a glance (P5), what the desk's "Criteria verified" adds up (P10). */}
                        {summary.criteria ? (
                          <Chip muted={summary.criteria.verified !== summary.criteria.counted}>
                            {summary.criteria.verified} of {summary.criteria.counted} criteria verified
                          </Chip>
                        ) : null}
                        {progress.pendingApprovals > 0 ? (
                          <Badge tone="blocked">
                            <Icon name="approvals" size={11} />
                            {progress.pendingApprovals}
                          </Badge>
                        ) : null}
                        {summary.repositoryName ? <Chip muted>{summary.repositoryName}</Chip> : null}
                        {progress.totalTasks > 0 ? (
                          <div style={{ width: 84 }}>
                            <div className="meter" aria-hidden="true">
                              <div className="meter__fill" style={{ width: `${percent}%`, background: `var(--status-${tone})` }} />
                            </div>
                            <div className="dim" style={{ fontSize: 'var(--fs-micro)', marginTop: 3, textAlign: 'right' }}>
                              {progress.completed}/{progress.totalTasks}
                            </div>
                          </div>
                        ) : null}
                        <StatusBadge status={summary.mission.status} tone={tone} />
                        <span className="dim" style={{ fontSize: 'var(--fs-xs)', width: 64, textAlign: 'right' }}>
                          {relativeTime(summary.lastEventAt ?? summary.mission.updatedAt)}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
              <p className="dim" style={{ marginTop: 'var(--s3)', fontSize: 'var(--fs-xs)' }}>
                {pluralize(visible.length, 'mission')} · <kbd>j</kbd> <kbd>k</kbd> to move, <kbd>↵</kbd> to open
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
