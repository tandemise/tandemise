import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { SkillView } from '@tandemise/api-contract';
import { stripFrontMatter } from '@tandemise/artifacts/strip-front-matter';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { ConfirmDialog } from '../components/Modal.js';
import { Markdown } from '../components/Markdown.js';
import { Empty, ErrorState, SkeletonList } from '../components/primitives.js';
import { useDaemonMutation, useSkillVersion, useSkills } from '../lib/queries.js';
import { dateTime, pluralize } from '../lib/format.js';
import { ImportSkills } from './skills/ImportSkills.js';
import { evalsHref } from './evals/link.js';
import { Badge, Button, Card, Chip, Truncate } from '@tandemise/design/react';

/**
 * The skills library (P13): skills the person already has, imported as
 * numbered versions and pinned to the roles that use them.
 *
 * "Update available" is the daemon re-reading each local source folder; the
 * screen never updates anything by itself. A role keeps its pinned version
 * until the person moves it in Team → Roles.
 */
export function Skills(): JSX.Element {
  const skills = useSkills(true);
  const [importing, setImporting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<readonly string[]>([]);
  const list = skills.data?.skills ?? [];
  const selected = useMemo(() => list.find((s) => s.id === selectedId) ?? list[0] ?? null, [list, selectedId]);

  const header = (
    <PageHeader
      title="Skills"
      subtitle="Skills you already use, pinned to the roles that need them. Every run gets exactly the version it was pinned to."
      actions={
        <Button variant="primary" onClick={() => setImporting(true)}>
          <Icon name="plus" size={13} />
          Import skills
        </Button>
      }
    />
  );

  const dialog = importing ? (
    <ImportSkills
      onClose={() => setImporting(false)}
      onImported={(messages) => { setNotice(messages); setImporting(false); }}
    />
  ) : null;

  if (skills.isError || skills.isPending || list.length === 0) {
    return (
      <>
        {header}
        <div className="page">
          <div className="page__inner">
            {skills.isError ? <ErrorState error={skills.error} onRetry={() => void skills.refetch()} /> : null}
            {notice.length > 0 ? <p role="status" className="muted">{notice.join(' ')}</p> : null}
            {skills.isPending ? <SkeletonList rows={3} /> : !skills.isError ? (
              <Card>
                <Empty
                  icon="book"
                  title="No skills yet"
                  body="Import the skills you already use - from ~/.claude/skills, a folder or a git repository - then attach them to roles in Team → Roles."
                  action={<Button onClick={() => setImporting(true)}>Import skills</Button>}
                />
              </Card>
            ) : null}
          </div>
        </div>
        {dialog}
      </>
    );
  }

  return (
    <>
      {header}
      {notice.length > 0 ? (
        <p role="status" className="muted" style={{ margin: 0, padding: 'var(--s2) var(--s6)' }}>{notice.join(' ')}</p>
      ) : null}
      <div className="reader">
        <div className="reader__list" aria-label="Library">
          {list.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className="list__row"
              aria-label={`Skill: ${skill.name}`}
              data-active={skill.id === selected?.id}
              style={{ border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', alignItems: 'flex-start' }}
              onClick={() => setSelectedId(skill.id)}
            >
              <Icon name="book" size={16} className="dim" />
              <div className="list__main">
                <div className="list__title">{skill.name}</div>
                <Truncate as="div" className="list__subtitle">{skill.description || 'No description'}</Truncate>
                <div className="list__subtitle dim" style={{ fontSize: 'var(--fs-xs)' }}>
                  v{skill.latest.version} · {skill.latest.sizeLabel}
                  {skill.source.kind === 'claude' && skill.source.plugin !== undefined ? ` · Plugin ${skill.source.plugin}` : ''}
                  {skill.usedBy.length > 0 ? ` · Used by ${skill.usedBy.map((u) => `${u.roleName} v${u.version}`).join(', ')}` : ''}
                </div>
              </div>
              {skill.sourceStatus === 'update_available' ? <Badge tone="blocked">Update available</Badge> : null}
              {skill.sourceStatus === 'missing' ? <Chip muted>Source gone</Chip> : null}
            </button>
          ))}
        </div>
        <div className="reader__pane">{selected ? <SkillDetail key={selected.id} skill={selected} onDeleted={() => setSelectedId(null)} /> : null}</div>
      </div>
      {dialog}
    </>
  );
}

function SkillDetail({ skill, onDeleted }: { skill: SkillView; onDeleted: () => void }): JSX.Element {
  const [version, setVersion] = useState(skill.latest.version);
  const [deleting, setDeleting] = useState(false);
  const detail = useSkillVersion(skill.id, version);
  const update = useDaemonMutation((daemon) => daemon.updateSkill(skill.id), ['workspaces']);
  const remove = useDaemonMutation((daemon) => daemon.deleteSkill(skill.id), ['workspaces']);
  const shown = skill.versions.find((v) => v.version === version) ?? skill.latest;
  const [, navigate] = useLocation();
  // Roles still on an older version: an update imports the new one but never moves a pin (Ruling 10), so the
  // candidate moves just these roles to latest, inside an eval run only.
  const behind = skill.usedBy.filter((u) => u.version < skill.latest.version);
  const tryOnEvals = (): void =>
    navigate(evalsHref({
      tab: 'runs',
      candidate: { kind: 'skills', roles: Object.fromEntries(behind.map((u) => [u.roleId, [{ name: skill.name, version: 'latest' as const }]])) },
    }));

  return (
    <div className="stack" aria-label="Skill detail" style={{ gap: 'var(--s5)' }}>
      <header className="reader__head">
        <h2 className="reader__title">{skill.name}</h2>
        <div className="reader__meta">
          <Chip>v{skill.latest.version}</Chip>
          <Chip muted className="mono">{skill.latest.shortHash}</Chip>
          <span>{skill.description || 'No description'}</span>
        </div>
      </header>

      <section aria-label="Source" className="stack" style={{ gap: 'var(--s2)' }}>
        <h2 className="section__title">Source</h2>
        <Truncate as="p" className="muted" style={{ margin: 0 }}>{skill.sourceLabel}</Truncate>
        <SourceLine skill={skill} />
        <div className="row" style={{ gap: 'var(--s2)' }}>
          {skill.sourceStatus === 'update_available' || skill.sourceStatus === 'unchecked' ? (
            <Button disabled={update.isPending} onClick={() => update.mutate(undefined, { onSuccess: (done) => setVersion(done.version) })}>
              <Icon name="refresh" size={13} />
              {update.isPending ? 'Updating…' : skill.sourceStatus === 'unchecked' ? 'Update from source' : 'Update'}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => setDeleting(true)}>
            <Icon name="trash" size={13} />
            Delete
          </Button>
        </div>
        {update.isSuccess ? <p role="status" className="muted" style={{ margin: 0 }}>{update.data.message}</p> : null}
        {update.isError ? <ErrorState error={update.error} /> : null}
        {remove.isError ? <ErrorState error={remove.error} /> : null}
      </section>

      <section aria-label="Used by" className="stack" style={{ gap: 'var(--s2)' }}>
        <h2 className="section__title">Used by</h2>
        {skill.usedBy.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No role uses it yet. Attach it to a role in <Link href="/team/roles">Team → Roles</Link>.</p>
        ) : (
          <>
            <ul style={{ margin: 0, paddingLeft: 'var(--s4)' }}>
              {skill.usedBy.map((u) => (
                <li key={u.roleId}>
                  {u.roleName} pins v{u.version}
                  {u.version < skill.latest.version ? <span className="dim"> · v{skill.latest.version} is available in <Link href="/team/roles">Team → Roles</Link></span> : null}
                </li>
              ))}
            </ul>
            {behind.length > 0 ? (
              <div className="row" style={{ gap: 'var(--s2)' }}>
                <Button onClick={tryOnEvals}>
                  <Icon name="target" size={13} />
                  Try on evals
                </Button>
                <span className="dim" style={{ fontSize: 'var(--fs-sm)' }}>Run your eval cases with v{skill.latest.version} before moving any role to it.</span>
              </div>
            ) : null}
          </>
        )}
      </section>

      <section aria-label="Versions" className="stack" style={{ gap: 'var(--s2)' }}>
        <h2 className="section__title">Versions</h2>
        <div className="list">
          {skill.versions.map((v) => (
            <button
              key={v.version}
              type="button"
              className="list__row"
              data-active={v.version === version}
              style={{ border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent' }}
              onClick={() => setVersion(v.version)}
            >
              <div className="list__main">
                <div className="list__title">v{v.version} <span className="mono dim" style={{ fontSize: 'var(--fs-xs)' }}>{v.shortHash}</span></div>
                <div className="list__subtitle dim">{v.sizeLabel} · imported {dateTime(v.importedAt)}</div>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Version contents" className="stack" style={{ gap: 'var(--s2)' }}>
        <h2 className="section__title">v{shown.version}: {pluralize(shown.files.length, 'file')}</h2>
        <ul className="mono" style={{ margin: 0, paddingLeft: 'var(--s4)', fontSize: 'var(--fs-xs)' }}>
          {shown.files.map((f) => <li key={f.path}>{f.path}</li>)}
        </ul>
        {detail.isError ? <ErrorState error={detail.error} /> : null}
        {detail.data?.skillMd === null ? (
          <p className="badge badge--failed" style={{ margin: 0 }}>This version's files are missing from the store. Import it again to restore them.</p>
        ) : detail.data ? (
          <Card aria-label="SKILL.md">
            <Markdown source={stripFrontMatter(detail.data.skillMd)} />
          </Card>
        ) : null}
      </section>

      {deleting ? (
        <ConfirmDialog
          title={`Delete “${skill.name}”?`}
          body="All its versions leave the library. Steps that already pinned it stop and ask you when they run; import it again to bring it back."
          confirmLabel="Delete skill"
          destructive
          busy={remove.isPending}
          onCancel={() => setDeleting(false)}
          onConfirm={() => remove.mutate(undefined, { onSuccess: () => { setDeleting(false); onDeleted(); }, onError: () => setDeleting(false) })}
        />
      ) : null}
    </div>
  );
}

function SourceLine({ skill }: { skill: SkillView }): JSX.Element {
  switch (skill.sourceStatus) {
    case 'current':
      return <p className="dim" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>The source matches v{skill.latest.version}.</p>;
    case 'update_available':
      return <p style={{ margin: 0, fontSize: 'var(--fs-sm)' }}><Badge tone="blocked">Update available</Badge> The source changed since v{skill.latest.version}. Update imports it as v{skill.latest.version + 1}; roles keep their version until you move them.</p>;
    case 'missing':
      return <p className="dim" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>The source folder is gone or no longer a skill. The imported versions still work.</p>;
    default:
      return <p className="dim" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>A repository is checked only when you update from it.</p>;
  }
}
