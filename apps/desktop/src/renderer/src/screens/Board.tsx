import { useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import type { BoardItemView, BoardView } from '@tandemise/api-contract';
import type { MissionStatus } from '@tandemise/domain';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { Empty, ErrorState, SkeletonList, StatusDot } from '../components/primitives.js';
import { useDaemon } from '../lib/connection.js';
import { keys, useBoard, useDaemonMutation, useIntakeConfig, useIntakeSignals } from '../lib/queries.js';
import { useWorkspaceId } from '../lib/workspace.js';
import { humanizeStatus, missionTone, relativeTime } from '../lib/format.js';
import { IntakeList } from './board/IntakeList.js';
import './Board.css';
import { Banner, Button, Card, Tab, Tabs, Tooltip } from '@tandemise/design/react';

export type BoardTab = 'board' | 'intake';
export const BOARD_TABS: readonly BoardTab[] = ['board', 'intake'];

/** The three groups, in the order work moves through them (intake spec §7). */
const GROUPS: readonly { readonly key: keyof BoardView['groups']; readonly label: string }[] = [
  { key: 'ready', label: 'Ready' },
  { key: 'inProgress', label: 'In progress' },
  { key: 'inReview', label: 'In review' },
];

/** The daemon's own sentence for a project with no tracker (intake plan Task 8). */
const NO_TRACKER = "Set this project's tracker first.";

/**
 * The Board (intake spec §7, plan Task 14): the project's tracker items,
 * grouped by mapped state, where a person chooses work and presses Start.
 * Tandemise never reorders or edits the board; it reads the tracker's own
 * query. The Intake tab beside it lists every signal recorded, so
 * "everything entered is recorded" is visible.
 */
export function Board({ tab }: { tab: BoardTab }): JSX.Element {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const board = useBoard();
  const config = useIntakeConfig();
  const signals = useIntakeSignals();
  const check = useDaemonMutation((d, _: void) => d.checkSources(workspaceId ?? ''), ['intake']);

  // "Refreshed on open" (spec §7): the tick reads the tracker every two
  // minutes, and the person opening the board should not see it that stale.
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    daemon.refreshBoard(workspaceId).then(
      (fresh) => { if (live) queryClient.setQueryData(keys.board(workspaceId), fresh); },
      () => { /* the cached board stays, and its problem line says why */ },
    );
    return () => { live = false; };
  }, [daemon, queryClient, workspaceId]);

  const noTracker = config.data?.tracker === null || board.data?.problem === NO_TRACKER;
  const label = board.data?.trackerLabel ?? '';
  const counts = {
    board: board.data ? GROUPS.reduce((n, g) => n + board.data.groups[g.key].length, 0) : 0,
    intake: signals.data?.length ?? 0,
  };

  return (
    <>
      <PageHeader title="Board" subtitle="The work in your tracker. Start an item to make it a mission." />

      <Tabs label="Board sections">
        <Tab as={Link} href="/board" selected={tab === 'board'} count={counts.board}>
          Board
        </Tab>
        <Tab as={Link} href="/board/intake" selected={tab === 'intake'} count={counts.intake}>
          Intake
        </Tab>
      </Tabs>

      <div className="page">
        <div className="page__inner">
          {noTracker ? (
            <Card>
              <Empty
                icon="flag"
                title={NO_TRACKER}
                body="Your board is your tracker's own list of work. Tandemise files what comes in there, once, and you start items from here."
                action={<Link href="/settings/intake" className="btn btn--primary">Open Settings → Intake</Link>}
              />
            </Card>
          ) : tab === 'intake' ? (
            <IntakeList signals={signals} />
          ) : (
            <section className="board" aria-label="Board" data-checking={check.isPending}>
              <div className="board__header">
                <span className="board__tracker">
                  <Icon name="flag" size={14} className="dim" />
                  {label || 'Your tracker'}
                </span>
                {board.data?.refreshedAt ? <span className="board__refreshed">Read {relativeTime(board.data.refreshedAt)}</span> : null}
                <Button className="board__check" disabled={check.isPending} onClick={() => check.mutate(undefined, { onSuccess: (fresh) => queryClient.setQueryData(keys.board(workspaceId), fresh) })}>
                  <Icon name="refresh" size={13} />
                  {check.isPending ? 'Checking…' : 'Check sources now'}
                </Button>
              </div>
              {board.data?.problem ? <Banner tone="warn" live="polite" className="board__problem">{board.data.problem}</Banner> : null}
              {check.isError ? <ErrorState error={check.error} /> : null}
              {board.isError ? <ErrorState error={board.error} onRetry={() => void board.refetch()} /> : null}
              {board.isPending ? (
                <SkeletonList rows={4} />
              ) : board.data && counts.board === 0 ? (
                <Card>
                  <Empty icon="flag" title={`Nothing on your board yet. Check sources, or add work in ${label || 'your tracker'}.`} body="Items in a ready, in progress or in review state show here." />
                </Card>
              ) : board.data ? (
                GROUPS.map((group) => <Group key={group.key} id={group.key} label={group.label} items={board.data.groups[group.key]} />)
              ) : null}
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function Group({ id, label, items }: { id: string; label: string; items: readonly BoardItemView[] }): JSX.Element {
  return (
    <section className="board__group" data-board-group={id} aria-label={label}>
      <h2 className="section__title board__group-title">
        {label} <span className="section__meta">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="muted board__none">Nothing here.</p>
      ) : (
        <Card flush>
          {items.map((item) => <Row key={item.id} item={item} />)}
        </Card>
      )}
    </section>
  );
}

function Row({ item }: { item: BoardItemView }): JSX.Element {
  const workspaceId = useWorkspaceId();
  const [, navigate] = useLocation();
  // Navigates from the mutation itself: Start moves the row to another group, so this row can unmount
  // before the answer arrives, and a per-call onSuccess would then never run.
  const start = useDaemonMutation(async (d, _: void) => {
    const summary = await d.startItem(workspaceId ?? '', item.key);
    navigate(`/missions/${summary.mission.id}`);
    return summary;
  }, ['intake', 'missions']);
  const blocked = !item.startable.ok ? item.startable.reason : null;
  return (
    <div className="list__row board__row" data-board-item={item.key} data-startable={item.startable.ok}>
      <div className="list__main">
        <div className="board__line">
          <Tooltip content={`Open ${item.key}`}>
            <button type="button" className="board__key mono" onClick={() => void window.tandemise.openExternal(item.url)}>
              {item.key}
            </button>
          </Tooltip>
          <span className="list__title board__title">{item.title}</span>
        </div>
        <div className="list__subtitle board__meta">
          {item.sources.map((s) => (
            <span key={`${s.label}·${s.detail}`} className="chip chip--muted board__chip">{`${s.label} · ${s.detail}`}</span>
          ))}
          {item.assignee ? <span className="board__assignee">{item.assignee}</span> : null}
          {item.mission ? (
            <Link href={`/missions/${item.mission.id}`} className="board__mission">
              <StatusDot tone={missionTone(item.mission.status as MissionStatus)} />
              Mission: {humanizeStatus(item.mission.status)}
            </Link>
          ) : null}
        </div>
        {start.isError ? <ErrorState error={start.error} /> : null}
      </div>
      <div className="list__aside">
        {/* A disabled button takes no focus, so why it cannot start is said beside it, not in a tooltip. */}
        {item.mission ? (
          // Already a mission (#108): open it, rather than a Start that can only be refused.
          <Link href={`/missions/${item.mission.id}`} className="btn board__open">
            Open mission<span className="visually-hidden"> for {item.key}</span>
          </Link>
        ) : (
          <>
            {blocked !== null ? <span className="dim board__blocked">{blocked}</span> : null}
            <Tooltip content={`Start ${item.key} as a mission`}>
              <Button
                variant="primary" className="board__start"
                disabled={blocked !== null || start.isPending}
                onClick={() => start.mutate()}
              >
                {start.isPending ? 'Starting…' : 'Start'}
              </Button>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}
