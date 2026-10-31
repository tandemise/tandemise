import { useMemo, useState } from 'react';
import type { ArtifactReadView, FeedChange, OpenRequest } from '@tandemise/api-contract';
import { isApprovalForMember, isHumanTaskForMember } from '@tandemise/api-contract/for-me';
import { stripFrontMatter } from '@tandemise/artifacts/strip-front-matter';
import { Icon } from '../../components/Icon.js';
import { Markdown } from '../../components/Markdown.js';
import { Empty, ErrorState, IdChip, Skeleton } from '../../components/primitives.js';
import { useArtifact, useMission } from '../../lib/queries.js';
import { Attribution } from '../../components/ActorChip.js';
import { RequestChangesButton } from '../../components/RequestChanges.js';
import { HandoffLinkButton, openableLinks } from '../../components/HandoffLinks.js';
import { useDaemon } from '../../lib/connection.js';
import { describeError } from '../../lib/daemon.js';
import { showFlash } from '../../lib/notices.js';
import { actorLabel, useActors, type Actors } from '../../lib/team.js';
import { bytes, dateTime, pluralize, titleCase } from '../../lib/format.js';
import { lineDiff, type DiffLine } from '../../lib/line-diff.js';
import { Badge, Banner, Button, Chip, Tooltip } from '@tandemise/design/react';

/** Unchanged lines kept around each change in the comparison; the rest fold into "N unchanged lines". */
const DIFF_CONTEXT = 2;

/**
 * One artifact, read the way a busy owner reads: what it says first, then the
 * document, then the appendix only if they ask for it.
 *
 * The handoff (headline, points, needs, links) is the part people act on, so it
 * sits above the body. The YAML it came from is never shown, the appendix is
 * collapsed, and record-keeping values (id, size, sha) wait behind "Details"
 * because nobody scans for them.
 */
export function ArtifactReader({ id }: { id: string | null }): JSX.Element {
  // The version switcher reads another version in place. It is remembered against the id it was picked from,
  // so opening a different artifact from outside starts at that artifact again.
  const [picked, setPicked] = useState<{ readonly from: string | null; readonly to: string } | null>(null);
  const shownId = picked !== null && picked.from === id ? picked.to : id;
  const artifact = useArtifact(shownId);

  if (!id) {
    return <Empty icon="artifacts" title="Select an artifact" body="Pick something on the left to read it here." />;
  }

  if (artifact.isPending) {
    return (
      <div className="stack" style={{ gap: 'var(--s4)' }}>
        <Skeleton height={28} width="55%" />
        <Skeleton height={12} width="30%" />
        <div style={{ height: 'var(--s4)' }} />
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} height={13} width={`${62 + ((index * 23) % 36)}%`} />
        ))}
      </div>
    );
  }

  if (artifact.isError) return <ErrorState error={artifact.error} onRetry={() => void artifact.refetch()} />;

  return <ReaderDocument key={artifact.data.manifest.id} view={artifact.data} onVersion={(to) => setPicked({ from: id, to })} />;
}

function ReaderDocument({ view, onVersion }: { view: ArtifactReadView; onVersion: (artifactId: string) => void }): JSX.Element {
  const { manifest, body, split, appendixWords } = view;
  const actors = useActors();
  const [details, setDetails] = useState(false);
  const [comparing, setComparing] = useState(false);
  // Read defensively: the offline mock serves read views without the round fields.
  const versions = view.versions ?? [];
  const changes = view.changes ?? [];
  const at = versions.findIndex((v) => v.artifactId === manifest.id);
  const previous = at > 0 ? versions[at - 1]! : null;
  const isText = manifest.mediaType.startsWith('text/') || manifest.mediaType === 'application/json';
  const handoff = manifest.handoff ?? null;
  // An artifact from before the handoff contract has no headline of its own; its summary is the closest thing.
  const headline = handoff?.headline ?? manifest.summary;
  // A lone first version is not worth a chip; one with a successor is, so "older" can be said.
  // Read defensively: the offline mock serves bare manifests without version fields.
  // With several versions the switcher says which one this is, so the chip would repeat it.
  const showVersion = versions.length <= 1 && ((manifest.version ?? 1) > 1 || (manifest.supersededBy ?? null) !== null);
  // Output a round overtook before it was judged: without this it would read as the latest version.
  const setAside = (view.withdrawnAt ?? null) !== null;
  const links = openableLinks(handoff?.links);
  // `needs` asks the person the request is for; anyone else is told who it waits on, as the feed does.
  // Read defensively: the offline mock serves read views without it.
  const waitingOn = handoff?.needs ? waitingFor(view.openRequest ?? null, actors) : null;

  return (
    <article>
      <header className="reader__head">
        <h2 className="reader__title">{manifest.title}</h2>
        <div className="reader__byline">
          <Attribution
            by={manifest.author ?? actors.ref(manifest.authorId)}
            responsible={manifest.responsible ?? actors.ref(manifest.responsibleId)}
            recordedBy={manifest.recordedByRef ?? actors.ref(manifest.recordedBy)}
            meId={actors.meId}
          />
          {manifest.taskId && (view.canRequestChanges ?? true) ? (
            <ReaderRequestChanges taskId={manifest.taskId} missionId={manifest.missionId} artifactId={manifest.id} title={manifest.title} />
          ) : null}
        </div>

        {headline ? <p className="handoff__headline">{headline}</p> : null}

        {handoff && handoff.points.length > 0 ? (
          <ul className="handoff__points">
            {handoff.points.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        ) : null}

        {changes.length > 0 ? (
          <Changes changes={changes} version={manifest.version ?? 1} actors={actors} />
        ) : handoff && handoff.changed.length > 0 ? (
          // A view without resolved changes (the offline mock) still lists what the handoff says changed.
          <div className="handoff__changed">
            <div className="handoff__label">Changed</div>
            <ul>
              {handoff.changed.map((change, index) => (
                <li key={index}>{change.what}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {handoff?.needs && waitingOn ? (
          <div className="handoff__needs">
            <Icon name="clock" size={14} />
            <span>{waitingOn}</span>
          </div>
        ) : handoff?.needs ? (
          <div className="handoff__needs">
            <Icon name="flag" size={14} />
            <span>
              <strong>Needs</strong> {handoff.needs}
            </span>
          </div>
        ) : null}

        {links.length > 0 ? (
          <div className="handoff__links">
            {links.map((link) => (
              <HandoffLinkButton key={`${link.label}-${link.url ?? link.path}`} link={link} workspaceId={manifest.workspaceId} icon />
            ))}
          </div>
        ) : null}

        <div className="reader__meta">
          {versions.length > 1 ? (
            <span className="reader__versions" role="group" aria-label="Versions">
              {versions.map((v) => (
                <Tooltip key={v.artifactId} content={v.round !== null ? `Round ${v.round} · ${dateTime(v.createdAt)}` : dateTime(v.createdAt)}>
                  <button
                    type="button"
                    className="reader__version"
                    aria-pressed={v.artifactId === manifest.id}
                    onClick={() => v.artifactId !== manifest.id && onVersion(v.artifactId)}
                  >
                    v{v.version}
                  </button>
                </Tooltip>
              ))}
            </span>
          ) : null}
          {versions.length > 1 && setAside ? <Tooltip content="Set aside: its task was redone before this was reviewed"><Chip tabIndex={0}>Set aside</Chip></Tooltip> : null}
          {versions.length > 1 && !setAside && manifest.supersededBy ? <Chip muted>Older version</Chip> : null}
          {previous !== null && isText ? (
            <button type="button" className="reader__details-toggle reader__compare" aria-pressed={comparing} onClick={() => setComparing((on) => !on)}>
              {comparing ? 'Show the document' : `Compare with v${previous.version}`}
            </button>
          ) : null}
          <Chip>{titleCase(manifest.type)}</Chip>
          <span>{dateTime(manifest.createdAt)}</span>
          {showVersion ? (
            <Tooltip content={setAside ? 'Set aside: its task was redone before this was reviewed' : manifest.supersededBy ? 'A newer version replaced this one' : 'Latest version'}>
              <Chip tabIndex={0}>
                v{manifest.version}
                {setAside ? ' · set aside' : manifest.supersededBy ? ' · older' : ''}
              </Chip>
            </Tooltip>
          ) : setAside ? (
            <Tooltip content="Set aside: its task was redone before this was reviewed">
              <Chip tabIndex={0}>Set aside</Chip>
            </Tooltip>
          ) : null}
          {/* A note about length, not a failure: neutral, and it says only what was measured. */}
          {manifest.overBudget ? (
            <Tooltip content={manifest.wordCount != null ? `${pluralize(manifest.wordCount, 'word')}, longer than the word budget for its type` : 'Longer than the word budget for its type'}>
              <Badge tabIndex={0}>Over budget</Badge>
            </Tooltip>
          ) : null}
          {manifest.sourceRefs.map((ref, index) => (
            <Chip key={index} muted icon={<Icon name={ref.kind.startsWith('git') ? 'branch' : 'link'} size={10} />}>
              {ref.label ?? ref.value}
            </Chip>
          ))}
          <button
            type="button"
            className="reader__details-toggle"
            aria-expanded={details}
            onClick={() => setDetails((open) => !open)}
          >
            Details
            <Icon name={details ? 'chevronUp' : 'chevronDown'} size={11} />
          </button>
        </div>
        {details ? (
          <div className="reader__meta">
            <IdChip id={manifest.id} />
            <span>{bytes(manifest.byteSize)}</span>
            <Tooltip content={`sha256 ${manifest.sha256}`}>
              <span className="mono">{manifest.sha256.slice(0, 12)}</span>
            </Tooltip>
            {manifest.wordCount != null ? <span>{pluralize(manifest.wordCount, 'word')} in the main body</span> : null}
          </div>
        ) : null}
      </header>

      {isText && comparing && previous !== null ? (
        <Comparison before={previous.artifactId} beforeVersion={previous.version} after={body} afterVersion={manifest.version ?? versions.length} />
      ) : isText ? (
        <>
          <Markdown source={withoutTitleHeading(split ? split.main : stripFrontMatter(body), manifest.title)} />
          {split ? (
            <details className="reader__appendix">
              <summary>
                <Icon name="chevronRight" size={13} className="reader__appendix-chevron" />
                Appendix ({pluralize(appendixWords ?? 0, 'word')})
              </summary>
              <Markdown source={split.appendix} />
            </details>
          ) : null}
        </>
      ) : (
        <Banner icon={<Icon name="file" size={15} className="dim" />} action={<RevealButton artifactId={manifest.id} />}>
          This artifact is <span className="mono">{manifest.mediaType}</span> and cannot be shown inline.
        </Banner>
      )}
    </article>
  );
}

/**
 * "Reveal in Finder" for a body the reader cannot show. The stored `contentRef`
 * is relative to the artifact store, which Finder cannot place, so the daemon
 * resolves the absolute path first (spec A5).
 */
function RevealButton({ artifactId }: { artifactId: string }): JSX.Element {
  const daemon = useDaemon();
  const [busy, setBusy] = useState(false);
  const reveal = async (): Promise<void> => {
    setBusy(true);
    try {
      const { path } = await daemon.artifactPath(artifactId);
      await window.tandemise.revealInFinder(path);
    } catch (error) {
      showFlash(describeError(error).detail);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button disabled={busy} onClick={() => void reveal()}>
      Reveal in Finder
    </Button>
  );
}

/**
 * "Request changes" about the output being read, named after its task. The
 * task's title comes from its mission, which the reader otherwise never needs.
 */
function ReaderRequestChanges({ taskId, missionId, artifactId, title }: { taskId: string; missionId: string; artifactId: string; title: string }): JSX.Element | null {
  const mission = useMission(missionId);
  const task = mission.data?.tasks.find((t) => t.id === taskId);
  // A wait step reads no notes; a mission that fails to load still lets the note be sent, named after the document.
  if (task?.executor === 'wait') return null;
  // A stage your upload covers has no round to take a note: the daemon refuses one, so the button is not offered.
  if (task?.coveredBy) return null;
  return (
    <span className="reader__request">
      <RequestChangesButton
        taskId={taskId}
        taskTitle={task?.title ?? title}
        missionId={missionId}
        outputs={[{ id: artifactId, label: title }]}
        about={artifactId}
      />
    </span>
  );
}

/**
 * "Changes in v2": what the round changed, each expanding to the note it
 * answers and who wrote it. A decline is marked, since the note's author is
 * the person most likely to look for it.
 */
function Changes({ changes, version, actors }: { changes: readonly FeedChange[]; version: number; actors: Actors }): JSX.Element {
  return (
    <div className="handoff__changed">
      <div className="handoff__label">Changes in v{version}</div>
      <ul className="reader__changes">
        {changes.map((change, index) => {
          const what = change.declined ? change.what.replace(/^Declined:\s*/i, '') : change.what;
          return (
            <li key={index}>
              {change.feedback.length > 0 ? (
                <details className="reader__change">
                  <summary>
                    {change.declined ? <Chip muted>Declined</Chip> : null}
                    <span>{what}</span>
                    <Icon name="chevronDown" size={11} className="reader__change-chevron" />
                  </summary>
                  <ul className="reader__notes">
                    {change.feedback.map((note) => (
                      <li key={note.id}>
                        <span className="reader__note-author">{actorLabel(note.author, actors.meId)}</span>
                        <span className="reader__note-text">{note.text}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : (
                <span className="reader__change reader__change--plain">
                  {change.declined ? <Chip muted>Declined</Chip> : null}
                  <span>{what}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The two bodies line by line, front matter removed so the YAML never shows.
 * Long unchanged stretches fold away: what a person wants from a comparison is
 * what moved, not the page again.
 */
function Comparison({ before, beforeVersion, after, afterVersion }: { before: string; beforeVersion: number; after: string; afterVersion: number }): JSX.Element {
  const older = useArtifact(before);
  const olderBody = older.data?.body;
  // Computed once per pair of bodies: a stream invalidation re-renders the reader, and the table is quadratic.
  const lines = useMemo(
    () => (olderBody === undefined ? [] : lineDiff(stripFrontMatter(olderBody).trim(), stripFrontMatter(after).trim())),
    [olderBody, after],
  );
  if (older.isPending) return <Skeleton height={120} />;
  if (older.isError) return <ErrorState error={older.error} onRetry={() => void older.refetch()} />;
  if (lines === null) {
    return <Banner>Too large to compare line by line. Switch between v{beforeVersion} and v{afterVersion} above to read both.</Banner>;
  }
  const added = lines.filter((l) => l.kind === 'added').length;
  const removed = lines.filter((l) => l.kind === 'removed').length;
  return (
    <div className="diff">
      <div className="diff__summary">
        v{beforeVersion} → v{afterVersion}: {pluralize(added, 'line')} added, {pluralize(removed, 'line')} removed
      </div>
      <div className="diff__body">
        {folded(lines).map((row, index) =>
          row.kind === 'fold' ? (
            <div key={index} className="diff__fold">
              {pluralize(row.count, 'unchanged line')}
            </div>
          ) : (
            <div key={index} className={`diff__line diff__line--${row.kind}`}>
              <span className="diff__sign" aria-hidden="true">
                {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}
              </span>
              <span className="diff__text">{row.text || ' '}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

type Row = DiffLine | { readonly kind: 'fold'; readonly count: number };

/** Keeps `DIFF_CONTEXT` unchanged lines around each change and folds the rest. */
function folded(lines: readonly DiffLine[]): readonly Row[] {
  const near = lines.map((_, index) =>
    lines.slice(Math.max(0, index - DIFF_CONTEXT), index + DIFF_CONTEXT + 1).some((l) => l.kind !== 'same'),
  );
  const rows: Row[] = [];
  let hidden = 0;
  lines.forEach((line, index) => {
    if (line.kind === 'same' && !near[index]) {
      hidden += 1;
      return;
    }
    if (hidden > 0) rows.push({ kind: 'fold', count: hidden });
    hidden = 0;
    rows.push(line);
  });
  if (hidden > 0) rows.push({ kind: 'fold', count: hidden });
  return rows;
}

/**
 * "Waiting for Ana Ruiz" when the open request is not for the reader, by the
 * shared for-me rules; null when it is for them, or nothing is open. The latest
 * addressee is where an escalated request sits now.
 */
function waitingFor(request: OpenRequest | null, actors: Actors): string | null {
  if (request === null) return null;
  if (request.kind === 'approval') {
    if (isApprovalForMember(request.addresseeIds, actors.meId)) return null;
    return `Waiting for ${actors.name(request.addresseeIds[request.addresseeIds.length - 1]!)}`;
  }
  if (isHumanTaskForMember(request, actors.meId)) return null;
  const who = request.assigneeId ?? request.claimableIds[0] ?? null;
  return who === null ? 'Waiting for someone to take this step' : `Waiting for ${actors.name(who)}`;
}

/**
 * Drops a leading `# Title` that only repeats the title already shown above
 * the handoff. Most artifacts open with one, and reading the same words twice
 * pushes the body below the fold. A first heading that says something else is
 * content and stays.
 */
function withoutTitleHeading(markdown: string, title: string): string {
  const match = /^[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (match === null || match[1]!.trim().toLowerCase() !== title.trim().toLowerCase()) return markdown;
  return markdown.slice(match[0].length);
}
