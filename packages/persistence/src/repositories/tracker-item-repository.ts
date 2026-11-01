import { TandemiseError, asId, ids, type Clock, type TrackerItemId, type WorkspaceId } from '@tandemise/shared';
import type {
  TrackedItem, TrackerCommentMarker, TrackerCommentRow, TrackerItem, TrackerItemRepositoryPort, TrackerRef,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJsonOrNull, toJson } from '../json.js';

interface ItemRow {
  id: string;
  workspace_id: string;
  item_ref: string;
  key: string;
  url: string;
  title: string;
  description: string;
  state: string;
  assignee: string | null;
  type: string | null;
  subtasks: number | null;
  tags: string | null;
  upstream_created_at: string;
  upstream_updated_at: string;
  written_state: string | null;
  refreshed_at: string;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  workspace_id: string;
  item_ref: string;
  marker: string;
  comment_id: string;
  body: string;
  posted_at: string;
  updated_at: string;
}

const ITEM_COLUMNS = `id, workspace_id, item_ref, key, url, title, description, state, assignee, type, subtasks, tags,
  upstream_created_at, upstream_updated_at, written_state, refreshed_at, created_at, updated_at`;

function itemFromRow(r: ItemRow): TrackedItem {
  return {
    id: asId<'TrackerItemId'>(r.id),
    workspaceId: asId<'WorkspaceId'>(r.workspace_id),
    ref: r.item_ref as TrackerRef,
    key: r.key,
    url: r.url,
    title: r.title,
    description: r.description,
    state: r.state,
    assignee: r.assignee,
    ...(r.type === null ? {} : { type: r.type }),
    ...(r.subtasks === null ? {} : { subtasks: r.subtasks }),
    ...tagsOf(r.tags),
    createdAt: r.upstream_created_at,
    updatedAt: r.upstream_updated_at,
    writtenState: r.written_state,
    refreshedAt: r.refreshed_at,
  };
}

/** Null (never said, or not a list of strings) is no tags at all. */
function tagsOf(text: string | null): { tags?: readonly string[] } {
  const tags = parseJsonOrNull<unknown>(text);
  return Array.isArray(tags) && tags.every((t) => typeof t === 'string') ? { tags: tags as string[] } : {};
}

/** The board cache (plan Task 2): what the last refresh saw, plus the state Tandemise last wrote. */
export class SqliteTrackerItemRepository implements TrackerItemRepositoryPort {
  readonly #clock: Clock;
  readonly #upsert;
  readonly #selectOne;
  readonly #selectByRef;
  readonly #selectByKey;
  readonly #selectList;
  readonly #setWritten;
  readonly #removeMissing;
  readonly #selectComment;
  readonly #upsertComment;
  readonly #deleteComment;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#clock = clock;
    const h = db.handle;
    // The id, the written state and the row's own created_at survive a refresh.
    this.#upsert = h.prepare<ItemRow>(
      `INSERT INTO tracker_items (${ITEM_COLUMNS}) VALUES (:id, :workspace_id, :item_ref, :key, :url, :title, :description, :state,
         :assignee, :type, :subtasks, :tags, :upstream_created_at, :upstream_updated_at, :written_state, :refreshed_at, :created_at, :updated_at)
       ON CONFLICT (workspace_id, item_ref) DO UPDATE SET key = excluded.key, url = excluded.url, title = excluded.title,
         description = excluded.description, state = excluded.state, assignee = excluded.assignee, type = excluded.type,
         subtasks = excluded.subtasks, tags = excluded.tags,
         upstream_created_at = excluded.upstream_created_at, upstream_updated_at = excluded.upstream_updated_at,
         refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at`,
    );
    this.#selectOne = h.prepare<{ id: string }, ItemRow>(`SELECT ${ITEM_COLUMNS} FROM tracker_items WHERE id = :id`);
    this.#selectByRef = h.prepare<{ ws: string; ref: string }, ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM tracker_items WHERE workspace_id = :ws AND item_ref = :ref`,
    );
    this.#selectByKey = h.prepare<{ ws: string; key: string }, ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM tracker_items WHERE workspace_id = :ws AND key = :key ORDER BY created_at, id LIMIT 1`,
    );
    this.#selectList = h.prepare<{ ws: string }, ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM tracker_items WHERE workspace_id = :ws ORDER BY upstream_created_at, id`,
    );
    this.#setWritten = h.prepare<{ id: string; state: string | null; now: string }>(
      'UPDATE tracker_items SET written_state = :state, updated_at = :now WHERE id = :id',
    );
    this.#removeMissing = h.prepare<{ ws: string; keep: string }>(
      'DELETE FROM tracker_items WHERE workspace_id = :ws AND item_ref NOT IN (SELECT value FROM json_each(:keep))',
    );
    this.#selectComment = h.prepare<{ ws: string; ref: string; marker: string }, CommentRow>(
      `SELECT workspace_id, item_ref, marker, comment_id, body, posted_at, updated_at FROM tracker_comments
       WHERE workspace_id = :ws AND item_ref = :ref AND marker = :marker`,
    );
    this.#upsertComment = h.prepare<CommentRow>(
      `INSERT INTO tracker_comments (workspace_id, item_ref, marker, comment_id, body, posted_at, updated_at)
       VALUES (:workspace_id, :item_ref, :marker, :comment_id, :body, :posted_at, :updated_at)
       ON CONFLICT (workspace_id, item_ref, marker) DO UPDATE SET comment_id = excluded.comment_id, body = excluded.body,
         updated_at = excluded.updated_at`,
    );
    this.#deleteComment = h.prepare<{ ws: string; ref: string; marker: string }>(
      'DELETE FROM tracker_comments WHERE workspace_id = :ws AND item_ref = :ref AND marker = :marker',
    );
  }

  upsert(workspaceId: WorkspaceId, item: TrackerItem): TrackedItem {
    const now = this.#clock.now();
    this.#upsert.run({
      id: ids.trackerItem(), workspace_id: workspaceId, item_ref: item.ref, key: item.key, url: item.url, title: item.title,
      description: item.description, state: item.state, assignee: item.assignee, type: item.type ?? null,
      subtasks: item.subtasks ?? null, tags: item.tags === undefined ? null : toJson(item.tags),
      upstream_created_at: item.createdAt, upstream_updated_at: item.updatedAt, written_state: null, refreshed_at: now,
      created_at: now, updated_at: now,
    });
    const saved = this.byRef(workspaceId, item.ref);
    if (saved === undefined) throw new TandemiseError('INTERNAL', `Tracker item ${item.ref} was not stored`);
    return saved;
  }

  get(id: TrackerItemId): TrackedItem | undefined {
    const row = this.#selectOne.get({ id });
    return row === undefined ? undefined : itemFromRow(row);
  }

  byRef(workspaceId: WorkspaceId, ref: string): TrackedItem | undefined {
    const row = this.#selectByRef.get({ ws: workspaceId, ref });
    return row === undefined ? undefined : itemFromRow(row);
  }

  byKey(workspaceId: WorkspaceId, key: string): TrackedItem | undefined {
    const row = this.#selectByKey.get({ ws: workspaceId, key });
    return row === undefined ? undefined : itemFromRow(row);
  }

  list(workspaceId: WorkspaceId): readonly TrackedItem[] {
    return this.#selectList.all({ ws: workspaceId }).map(itemFromRow);
  }

  setWrittenState(id: TrackerItemId, state: string | null): void {
    this.#setWritten.run({ id, state, now: this.#clock.now() });
  }

  removeMissing(workspaceId: WorkspaceId, keepRefs: readonly string[]): void {
    this.#removeMissing.run({ ws: workspaceId, keep: toJson(keepRefs) });
  }

  comment(workspaceId: WorkspaceId, ref: string, marker: TrackerCommentMarker): TrackerCommentRow | undefined {
    const r = this.#selectComment.get({ ws: workspaceId, ref, marker });
    if (r === undefined) return undefined;
    return {
      workspaceId: asId<'WorkspaceId'>(r.workspace_id), itemRef: r.item_ref, marker: r.marker as TrackerCommentMarker,
      commentId: r.comment_id, body: r.body, postedAt: r.posted_at, updatedAt: r.updated_at,
    };
  }

  saveComment(workspaceId: WorkspaceId, ref: string, marker: TrackerCommentMarker, commentId: string, body: string): void {
    const now = this.#clock.now();
    this.#upsertComment.run({
      workspace_id: workspaceId, item_ref: ref, marker, comment_id: commentId, body, posted_at: now, updated_at: now,
    });
  }

  dropComment(workspaceId: WorkspaceId, ref: string, marker: TrackerCommentMarker): void {
    this.#deleteComment.run({ ws: workspaceId, ref, marker });
  }
}
