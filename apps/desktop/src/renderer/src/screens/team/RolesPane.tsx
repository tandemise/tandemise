import { useMemo, useState } from 'react';
import type { RoleSkill, RoleTemplate } from '@tandemise/domain';
import type { SkillView } from '@tandemise/api-contract';
import { Link } from 'wouter';
import { ARTIFACT_TYPES, modelList } from '../../lib/domain.js';
import { Icon } from '../../components/Icon.js';
import { Empty, ErrorState, Field, SkeletonList } from '../../components/primitives.js';
import { useDaemonMutation, useRoles, useSkills } from '../../lib/queries.js';
import { useWorkspace } from '../../lib/workspace.js';
import { titleCase } from '../../lib/format.js';
import { Badge, Button, Card, Chip, Truncate } from '@tandemise/design/react';

/**
 * What each role is: its instructions, contract and hand-offs.
 *
 * Moved here from the old Workforce screen. Which runtime carries a role now
 * belongs to the agent that does it (ranked in the agent's form), not the role.
 */
export function RolesPane(): JSX.Element {
  const roles = useRoles();
  const workspaceId = useWorkspace().current?.workspace.id ?? '';
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => (roles.data ?? []).find((role) => role.id === selectedId) ?? roles.data?.[0] ?? null, [roles.data, selectedId]);

  if (roles.isError) {
    return (
      <div className="page">
        <div className="page__inner">
          <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
        </div>
      </div>
    );
  }
  if (roles.isPending) {
    return (
      <div className="page">
        <div className="page__inner">
          <SkeletonList rows={6} />
        </div>
      </div>
    );
  }
  if ((roles.data ?? []).length === 0) {
    return (
      <div className="page">
        <div className="page__inner">
          <Card>
            <Empty icon="workforce" title="No roles configured" body="The project ships with built-in roles. If this is empty, the daemon has not seeded it yet." />
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="reader">
      <div className="reader__list">
        {(roles.data ?? []).map((role) => (
          <button
            key={role.id}
            type="button"
            className="list__row"
            data-active={role.id === selected?.id}
            style={{ border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent' }}
            onClick={() => setSelectedId(role.id)}
          >
            <div className="list__main">
              <div className="list__title">{role.name}</div>
              <Truncate as="div" className="list__subtitle">{role.summary}</Truncate>
            </div>
            {role.builtIn ? <Chip muted>built-in</Chip> : null}
          </button>
        ))}
      </div>
      <div className="reader__pane">{selected ? <RoleEditor key={selected.id} role={selected} workspaceId={workspaceId} /> : null}</div>
    </div>
  );
}

function RoleEditor({ role, workspaceId }: { role: RoleTemplate; workspaceId: string }): JSX.Element {
  const [instructions, setInstructions] = useState(role.instructions);
  const [outputContract, setOutputContract] = useState(role.outputContract);
  const [capabilities, setCapabilities] = useState(role.defaultCapabilities.join('\n'));
  const [produces, setProduces] = useState<readonly string[]>(role.producesArtifacts);
  const [consumes, setConsumes] = useState<readonly string[]>(role.consumesArtifacts);
  const [model, setModel] = useState(role.models?.model ?? '');
  const [escalate, setEscalate] = useState((role.models?.escalate ?? []).join(', '));
  const [economyModel, setEconomyModel] = useState(role.models?.economyModel ?? '');
  const [skills, setSkills] = useState<readonly RoleSkill[]>(role.skills ?? []);

  const save = useDaemonMutation(
    (daemon) =>
      daemon.upsertRole(role.id, {
        workspaceId,
        id: role.id,
        name: role.name,
        summary: role.summary,
        instructions,
        defaultCapabilities: capabilities.split('\n').map((line) => line.trim()).filter(Boolean),
        producesArtifacts: produces as never,
        consumesArtifacts: consumes as never,
        defaultIsolation: role.defaultIsolation,
        outputContract,
        models: { model: model.trim() || null, escalate: modelList(escalate), economyModel: economyModel.trim() || null },
        skills: [...skills],
      }),
    ['workspaces'],
  );

  const modelsDirty = model !== (role.models?.model ?? '') || escalate !== (role.models?.escalate ?? []).join(', ') || economyModel !== (role.models?.economyModel ?? '');
  const skillsDirty = JSON.stringify(skills) !== JSON.stringify(role.skills ?? []);
  const dirty = instructions !== role.instructions || outputContract !== role.outputContract || capabilities !== role.defaultCapabilities.join('\n') || modelsDirty || skillsDirty;

  return (
    <div className="stack" style={{ gap: 'var(--s5)' }}>
      <header className="reader__head">
        <h2 className="reader__title">{role.name}</h2>
        <div className="reader__meta">
          <Chip muted>{role.defaultIsolation} isolation</Chip>
          <span>{role.summary}</span>
        </div>
      </header>

      <Field label="Instructions" hint="Trusted system instructions for this role. Never sourced from external content.">
        <textarea className="textarea" style={{ minHeight: 180 }} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </Field>

      <Field label="Output contract" hint="The quality bar an evaluator checks this role's output against.">
        <textarea className="textarea" style={{ minHeight: 96 }} value={outputContract} onChange={(event) => setOutputContract(event.target.value)} />
      </Field>

      <Field label="Default capabilities" hint="One per line. Dotted and hierarchical — `github` implies `github.pr.create`.">
        <textarea
          className="textarea"
          style={{ minHeight: 84, fontFamily: 'var(--tds-font-mono)', fontSize: 'var(--fs-sm)' }}
          value={capabilities}
          onChange={(event) => setCapabilities(event.target.value)}
        />
      </Field>

      <section className="stack" aria-label="Models" style={{ gap: 'var(--s3)' }}>
        <div>
          <h2 className="section__title">Models</h2>
          <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
            Names are passed to the runtime exactly as you type them. A workflow step's own model wins over these; leave a field empty to use the runtime's model.
          </p>
        </div>
        <div className="grid grid--3">
          <Field label="Model" hint="Every run of this role, unless a step says otherwise.">
            <input className="input" aria-label="Model" value={model} placeholder="Runtime default" onChange={(event) => setModel(event.target.value)} />
          </Field>
          <Field label="On retry, use" hint="Attempt 2 uses the first, attempt 3 and later the next. Comma-separated.">
            <input className="input" aria-label="On retry, use" value={escalate} placeholder="e.g. a stronger model, then the strongest" onChange={(event) => setEscalate(event.target.value)} />
          </Field>
          <Field label="Economy model" hint="Used for new runs once a limit on the mission or this month passes its warning level.">
            <input className="input" aria-label="Economy model" value={economyModel} placeholder="e.g. a cheaper model" onChange={(event) => setEconomyModel(event.target.value)} />
          </Field>
        </div>
      </section>

      <RoleSkills pinned={skills} onChange={setSkills} />

      <div className="grid grid--2">
        <ArtifactPicker label="Produces" selected={produces} onChange={setProduces} />
        <ArtifactPicker label="Consumes" selected={consumes} onChange={setConsumes} />
      </div>

      {save.isError ? <ErrorState error={save.error} /> : null}

      <div className="row">
        <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(undefined)}>
          {save.isPending ? 'Saving…' : 'Save role'}
        </Button>
        {dirty ? <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>Unsaved changes</span> : null}
        {save.isSuccess && !dirty ? (
          <Badge tone="succeeded">
            <Icon name="check" size={11} />
            Saved
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

function ArtifactPicker({ label, selected, onChange }: { label: string; selected: readonly string[]; onChange: (next: readonly string[]) => void }): JSX.Element {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="row row--wrap" style={{ gap: 4 }}>
        {ARTIFACT_TYPES.map((type) => {
          const on = selected.includes(type);
          return (
            <button
              key={type}
              type="button"
              className="pick"
              aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((value) => value !== type) : [...selected, type])}
            >
              {titleCase(type)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Skills pinned to this role (P13). Each is pinned at a version: a newer
 * import never reaches the role's runs until the person picks "Use vN" here.
 */
function RoleSkills({ pinned, onChange }: { pinned: readonly RoleSkill[]; onChange: (next: readonly RoleSkill[]) => void }): JSX.Element {
  const library = useSkills();
  const [choice, setChoice] = useState('');
  const all: readonly SkillView[] = library.data?.skills ?? [];
  const byName = new Map(all.map((s) => [s.name, s]));
  const attachable = all.filter((s) => !pinned.some((p) => p.name === s.name));
  const attach = (): void => {
    const skill = byName.get(choice);
    if (skill === undefined) return;
    onChange([...pinned, { name: skill.name, version: skill.latest.version }]);
    setChoice('');
  };
  return (
    <section className="stack" aria-label="Skills" style={{ gap: 'var(--s3)' }}>
      <div>
        <h2 className="section__title">Skills</h2>
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
          Every run of this role gets these skills at the version shown. A step in a workflow file can add its own.
        </p>
      </div>
      {pinned.length === 0 ? (
        <p className="dim" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
          No skills attached. Import skills on the <Link href="/skills">Skills</Link> screen, then attach them here.
        </p>
      ) : (
        <div className="list">
          {pinned.map((pin) => {
            const skill = byName.get(pin.name);
            const newest = skill?.latest.version ?? pin.version;
            return (
              <div key={pin.name} className="list__row" aria-label={`Pinned: ${pin.name}`}>
                <Icon name="book" size={14} className="dim" />
                <div className="list__main">
                  <div className="list__title">{pin.name} v{pin.version}</div>
                  <div className="list__subtitle dim">{skill === undefined ? 'Not in the library any more: runs of this role will stop and ask you.' : skill.description || 'No description'}</div>
                </div>
                <div className="list__aside">
                  {newest > pin.version ? (
                    <Button variant="ghost" onClick={() => onChange(pinned.map((p) => (p.name === pin.name ? { name: p.name, version: newest } : p)))}>
                      Use v{newest}
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={() => onChange(pinned.filter((p) => p.name !== pin.name))}>Remove</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {attachable.length > 0 ? (
        <div className="row" style={{ gap: 'var(--s2)' }}>
          <select className="select" aria-label="Attach a skill" value={choice} onChange={(event) => setChoice(event.target.value)} style={{ maxWidth: 320 }}>
            <option value="">Choose a skill…</option>
            {attachable.map((s) => <option key={s.id} value={s.name}>{s.name} (v{s.latest.version})</option>)}
          </select>
          <Button disabled={choice === ''} onClick={attach}>Attach</Button>
        </div>
      ) : null}
    </section>
  );
}
