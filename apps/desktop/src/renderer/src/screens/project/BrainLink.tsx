import { useState } from 'react';
import { Link } from 'wouter';
import type { BrainAdoptPreview, BrainView, SetupItemView } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { ConfirmDialog } from '../../components/Modal.js';
import { ErrorState, Field, SectionHead, SkeletonList } from '../../components/primitives.js';
import { useBrain, useDaemonMutation } from '../../lib/queries.js';
import { showFlash } from '../../lib/notices.js';
import { Banner, Button, Card, Segmented } from '@tandemise/design/react';

const CHOICES = [
  { value: 'mine', label: 'Keep mine' },
  { value: 'theirs', label: 'Take theirs' },
] as const;

type Mode = 'create' | 'adopt' | 'local' | null;

/**
 * The project's brain (#51): one git repository for what it has learned and
 * how its factory works. Unlinked, three ways in: create one on GitHub, use
 * one a teammate made, or keep it on this machine. Linked, its status in the
 * daemon's own words and Sync now. Copy comes from the daemon, never built here.
 */
export function BrainLink({ workspaceId, ownerHint }: { workspaceId: string; ownerHint: string }): JSX.Element {
  const brain = useBrain();
  const [mode, setMode] = useState<Mode>(null);
  const [owner, setOwner] = useState(ownerHint);
  const [name, setName] = useState('brain');
  const [remote, setRemote] = useState('');
  const [preview, setPreview] = useState<BrainAdoptPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>({});
  const [unlinking, setUnlinking] = useState(false);
  const [sharing, setSharing] = useState(false);

  const link = useDaemonMutation((daemon, body: Parameters<typeof daemon.linkBrain>[1]) => daemon.linkBrain(workspaceId, body), ['workspaces']);
  const apply = useDaemonMutation((daemon, body: { hash: string; choices: Record<string, 'mine' | 'theirs'> }) => daemon.applyBrain(workspaceId, body), ['workspaces', 'missions']);
  const sync = useDaemonMutation((daemon) => daemon.syncBrain(workspaceId), ['workspaces', 'missions']);
  const unlink = useDaemonMutation((daemon) => daemon.unlinkBrain(workspaceId), ['workspaces']);
  const share = useDaemonMutation((daemon, body: { owner: string; name: string }) => daemon.shareBrain(workspaceId, body), ['workspaces']);

  const view = brain.data;
  const run = (body: Parameters<typeof link.mutate>[0]): void => {
    link.mutate(body, {
      onSuccess: (result) => {
        if ('items' in result) {
          setPreview(result);
          setChoices(Object.fromEntries(result.items.flatMap((i) => (i.choice === null ? [] : [[i.id, i.choice]]))));
        } else {
          setMode(null);
          showFlash(result.statusLine);
        }
      },
    });
  };

  return (
    <section className="section" aria-label="Brain">
      <SectionHead title="Brain" meta={view === undefined ? undefined : view.linked ? (view.remote ?? 'On this machine') : 'Not linked'} />
      {brain.isPending ? <SkeletonList rows={1} /> : brain.isError ? <ErrorState error={brain.error} /> : view?.linked ? (
        <Linked
          view={view}
          syncing={sync.isPending}
          onSync={() => sync.mutate(undefined, { onSuccess: (v) => showFlash(v.statusLine) })}
          onShare={() => setSharing(true)}
          onUnlink={() => setUnlinking(true)}
        />
      ) : (
        <Card>
          <p className="field__hint" style={{ marginBottom: 'var(--s3)' }}>
            A brain is one git repository that holds what this project has learned and how its factory works: roles, workflows,
            rules and lessons. A teammate who links the same brain gets the same factory. Sharing is <span className="mono">git pull</span> and{' '}
            <span className="mono">git push</span>; secrets and your own settings never go in it.
          </p>
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <Button variant={mode === 'create' ? 'primary' : 'secondary'} onClick={() => { setMode('create'); setPreview(null); }}>
              <Icon name="plus" size={13} />
              Create a brain
            </Button>
            <Button variant={mode === 'adopt' ? 'primary' : 'secondary'} onClick={() => { setMode('adopt'); setPreview(null); }}>
              <Icon name="folder" size={13} />
              Use an existing brain
            </Button>
            <Button disabled={link.isPending} onClick={() => { setMode('local'); run({ mode: 'local' }); }}>
              Keep it on this machine
            </Button>
          </div>

          {mode === 'create' ? (
            <div className="stack" style={{ marginTop: 'var(--s3)' }} aria-label="Create a brain">
              <div className="row" style={{ gap: 'var(--s2)', alignItems: 'flex-end' }}>
                <Field label="GitHub owner"><input className="input" aria-label="GitHub owner" value={owner} onChange={(e) => setOwner(e.target.value)} /></Field>
                <Field label="Repository name"><input className="input" aria-label="Repository name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
                <Button variant="primary" disabled={link.isPending || owner.trim() === '' || name.trim() === ''} onClick={() => run({ mode: 'create', owner: owner.trim(), name: name.trim() })}>
                  {link.isPending ? 'Creating…' : 'Create'}
                </Button>
              </div>
              <p className="field__hint">A private repository named {owner.trim() || 'owner'}/{name.trim() || 'brain'}, made with your GitHub CLI.</p>
            </div>
          ) : null}

          {mode === 'adopt' && preview === null ? (
            <div className="row" style={{ gap: 'var(--s2)', alignItems: 'flex-end', marginTop: 'var(--s3)' }} aria-label="Use an existing brain">
              <Field label="Brain repository" hint="github.com/owner/name, or a git address">
                <input className="input" aria-label="Brain repository" value={remote} placeholder="github.com/acme/brain" onChange={(e) => setRemote(e.target.value)} />
              </Field>
              <Button variant="primary" disabled={link.isPending || remote.trim() === ''} onClick={() => run({ mode: 'adopt', remote: remote.trim() })}>
                {link.isPending ? 'Reading…' : 'Preview'}
              </Button>
            </div>
          ) : null}

          {preview !== null ? (
            <AdoptPreview
              preview={preview}
              choices={choices}
              onChoose={(id, c) => setChoices((current) => ({ ...current, [id]: c }))}
              pending={apply.isPending}
              onLink={() => apply.mutate({ hash: preview.hash, choices }, { onSuccess: (v) => { setPreview(null); setMode(null); showFlash(v.statusLine); } })}
              onCancel={() => setPreview(null)}
            />
          ) : null}
          {link.isError ? <ErrorState error={link.error} /> : null}
          {apply.isError ? <ErrorState error={apply.error} /> : null}
        </Card>
      )}

      {unlinking ? <ConfirmDialog
        title="Unlink the brain?"
        body="This project keeps its factory as it is now and stops loading lessons. The brain repository and this machine's copy are not deleted."
        confirmLabel="Unlink"
        onConfirm={() => unlink.mutate(undefined, { onSuccess: () => { setUnlinking(false); showFlash('Unlinked. The brain itself is untouched.'); } })}
        busy={unlink.isPending}
        onCancel={() => setUnlinking(false)}
      /> : null}
      {sharing && view?.linked ? (
        <Card style={{ marginTop: 'var(--s3)' }} aria-label="Share this brain">
          <div className="row" style={{ gap: 'var(--s2)', alignItems: 'flex-end' }}>
            <Field label="GitHub owner"><input className="input" aria-label="Share owner" value={owner} onChange={(e) => setOwner(e.target.value)} /></Field>
            <Field label="Repository name"><input className="input" aria-label="Share name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Button variant="primary" disabled={share.isPending} onClick={() => share.mutate({ owner: owner.trim(), name: name.trim() }, { onSuccess: (v) => { setSharing(false); showFlash(v.statusLine); } })}>
              {share.isPending ? 'Sharing…' : 'Share'}
            </Button>
            <Button variant="ghost" onClick={() => setSharing(false)}>Cancel</Button>
          </div>
          {share.isError ? <ErrorState error={share.error} /> : null}
        </Card>
      ) : null}
    </section>
  );
}

function Linked({ view, syncing, onSync, onShare, onUnlink }: { view: BrainView; syncing: boolean; onSync: () => void; onShare: () => void; onUnlink: () => void }): JSX.Element {
  return (
    <Card className="stack" aria-label="Brain status">
      <p aria-label="Brain status line" data-status={view.status} style={{ margin: 0 }}>{view.statusLine}</p>
      <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
        {view.counts.rules} rules {view.counts.rules === 1 ? 'file' : 'files'} · {view.counts.lessons} {view.counts.lessons === 1 ? 'lesson' : 'lessons'}
        {view.counts.candidates > 0 ? ` · ${view.counts.candidates} waiting for you` : ''}
        {view.counts.mcpsNeeded > 0 ? ` · needs ${view.counts.mcpsNeeded} ${view.counts.mcpsNeeded === 1 ? 'connection' : 'connections'}` : ''}
      </p>
      {view.problems.map((p) => <Banner key={p} tone="warn">{p}</Banner>)}
      <div className="row" style={{ gap: 'var(--s2)' }}>
        <Button disabled={syncing} onClick={onSync}>
          <Icon name="refresh" size={13} />
          {syncing ? 'Syncing…' : 'Sync now'}
        </Button>
        <Link href="/brain" className="btn btn--ghost">Open the brain</Link>
        {view.status === 'local_only' ? <Button onClick={onShare}>Share this brain</Button> : null}
        <Button variant="ghost" style={{ marginLeft: 'auto' }} onClick={onUnlink}>Unlink</Button>
      </div>
    </Card>
  );
}

const ACTION: Readonly<Record<SetupItemView['action'], string>> = { add: 'Add', change: 'Change', remove: 'Remove', same: 'Same' };

function AdoptPreview({ preview, choices, onChoose, pending, onLink, onCancel }: {
  preview: BrainAdoptPreview;
  choices: Record<string, 'mine' | 'theirs'>;
  onChoose: (id: string, choice: 'mine' | 'theirs') => void;
  pending: boolean;
  onLink: () => void;
  onCancel: () => void;
}): JSX.Element {
  const rows = [...preview.items].sort((a, b) => Number(a.action === 'same') - Number(b.action === 'same'));
  return (
    <div className="stack" style={{ marginTop: 'var(--s3)' }} aria-label="Brain preview">
      <p style={{ margin: 0 }}>
        This brain has {preview.brain.rules} rules {preview.brain.rules === 1 ? 'file' : 'files'}
        {preview.brain.mcpsNeeded.length > 0 ? ` and needs ${preview.brain.mcpsNeeded.join(', ')}` : ''}. Choose what to take, then Link.
      </p>
      <table className="table">
        <thead><tr><th>Item</th><th>Change</th><th>Your choice</th></tr></thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id} aria-label={`${item.name}: ${ACTION[item.action]}`}>
              <td>
                <div>{item.name}</div>
                {item.detail !== '' ? <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{item.detail}</div> : null}
                {item.problem !== null ? <div className="field__error">{item.problem}</div> : null}
              </td>
              <td>{ACTION[item.action]}</td>
              <td>
                {item.choice === null ? <span className="muted">—</span> : (
                  <Segmented
                    label={`Choice for ${item.name}`}
                    value={choices[item.id] ?? item.choice}
                    options={CHOICES}
                    onChange={(c) => onChoose(item.id, c)}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ gap: 'var(--s2)' }}>
        <Button variant="primary" disabled={pending} onClick={onLink}>{pending ? 'Linking…' : 'Link'}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
