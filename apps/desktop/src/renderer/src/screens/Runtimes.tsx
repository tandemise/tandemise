import { useState } from 'react';
import type { RuntimeDiscoveryView, RuntimeView } from '@tandemise/api-contract';
import type { RuntimeSettingField } from '@tandemise/domain';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { ConfirmDialog, Modal } from '../components/Modal.js';
import { Empty, ErrorState, Field, SkeletonList, StatusDot, Switch } from '../components/primitives.js';
import { useDaemonMutation, useRuntimes, useSettings } from '../lib/queries.js';
import { useWorkspaceId } from '../lib/workspace.js';
import { dateTime, healthTone, pluralize, shortenPath, titleCase } from '../lib/format.js';
import { Badge, Banner, Button, Card, Chip, Tooltip } from '@tandemise/design/react';

export function Runtimes(): JSX.Element {
  const runtimes = useRuntimes();
  const [discovered, setDiscovered] = useState<readonly RuntimeDiscoveryView[] | null>(null);
  const [addingCli, setAddingCli] = useState(false);
  const [removing, setRemoving] = useState<RuntimeView | null>(null);
  const [editing, setEditing] = useState<{ view: RuntimeView; mode: ProfileMode } | null>(null);

  const discover = useDaemonMutation((daemon) => daemon.discoverRuntimes(), ['runtimes']);
  const remove = useDaemonMutation((daemon, id: string) => daemon.deleteRuntime(id), ['runtimes']);

  return (
    <>
      <PageHeader
        title="Runtimes"
        subtitle="The agent CLIs on this machine, and how much work each may take."
        actions={
          <>
            <Button onClick={() => setAddingCli(true)}>
              <Icon name="plus" size={13} />
              Add CLI runtime
            </Button>
            <Button
              variant="primary"
              disabled={discover.isPending}
              onClick={() => discover.mutate(undefined, { onSuccess: setDiscovered })}
            >
              <Icon name="search" size={13} />
              {discover.isPending ? 'Scanning…' : 'Discover runtimes'}
            </Button>
          </>
        }
      />

      <div className="page">
        <div className="page__inner">
          {runtimes.isError ? <ErrorState error={runtimes.error} onRetry={() => void runtimes.refetch()} /> : null}
          {discover.isError ? <ErrorState error={discover.error} /> : null}

          {runtimes.isPending ? (
            <SkeletonList rows={3} />
          ) : (runtimes.data ?? []).length === 0 ? (
            <Card>
              <Empty
                icon="runtimes"
                title="No runtimes configured"
                body="Tandemise routes roles to runtimes, never the other way round. Run discovery to find the agent CLIs already installed, or add a generic CLI runtime by hand."
                action={
                  <Button variant="primary" size="lg" onClick={() => discover.mutate(undefined, { onSuccess: setDiscovered })}>
                    <Icon name="search" size={14} />
                    Discover runtimes
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="stack" style={{ gap: 'var(--s4)' }}>
              {(runtimes.data ?? []).map((view) => (
                <RuntimeCard
                  key={view.profile.id}
                  view={view}
                  onRemove={() => setRemoving(view)}
                  onEdit={(mode) => setEditing({ view, mode })}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {discovered ? <DiscoveryModal results={discovered} onClose={() => setDiscovered(null)} /> : null}
      {addingCli ? <GenericCliModal onClose={() => setAddingCli(false)} /> : null}
      {editing ? <ProfileModal view={editing.view} mode={editing.mode} onClose={() => setEditing(null)} /> : null}
      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.profile.name}?`}
          confirmLabel="Remove runtime"
          destructive
          busy={remove.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.profile.id, { onSuccess: () => setRemoving(null) })}
          body={
            <>
              <p>Roles routed to this runtime fall through to the next one in their preference list.</p>
              {removing.rolesRouted.length > 0 ? (
                <p style={{ marginTop: 'var(--s3)' }}>
                  Currently preferred by {removing.rolesRouted.map(titleCase).join(', ')}.
                </p>
              ) : null}
            </>
          }
        />
      ) : null}
    </>
  );
}

function RuntimeCard({
  view,
  onRemove,
  onEdit,
}: {
  view: RuntimeView;
  onRemove: () => void;
  onEdit: (mode: ProfileMode) => void;
}): JSX.Element {
  const { profile, health } = view;
  const tone = healthTone(health.state);
  const update = useDaemonMutation((daemon, body: { enabled?: boolean; maxConcurrent?: number }) => daemon.updateRuntime(profile.id, body), ['runtimes']);
  // A daemon older than this renderer does not send the schema at all.
  const schema = view.settingsSchema ?? [];
  const check = useDaemonMutation((daemon) => daemon.checkRuntimeHealth(profile.id), ['runtimes']);

  return (
    <article className="card card--flush">
      <div className="card__head">
        <StatusDot tone={tone} live={view.activeRuns > 0} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <span style={{ fontWeight: 600, fontSize: 'var(--fs-base)' }}>{profile.name}</span>
            <Chip muted>{view.adapterDisplayName}</Chip>
            {health.version ? <Chip>{versionLabel(health.version)}</Chip> : null}
          </div>
          <div className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}>
            {health.detail} · checked {dateTime(health.checkedAt)}
          </div>
        </div>
        <Button variant="ghost" disabled={check.isPending} onClick={() => check.mutate(undefined)}>
          <Icon name="refresh" size={13} />
          {check.isPending ? 'Checking…' : 'Check health'}
        </Button>
        <Button variant="ghost" onClick={() => onEdit('edit')}>
          <Icon name="wrench" size={13} />
          Configure
        </Button>
        <Tooltip content={`Add a second ${view.adapterDisplayName} profile starting from this one`}>
          <Button variant="ghost" onClick={() => onEdit('duplicate')}>
            <Icon name="layers" size={13} />
            Duplicate
          </Button>
        </Tooltip>
        <Switch checked={profile.enabled} label={`Enable ${profile.name}`} onChange={(enabled) => update.mutate({ enabled })} />
        <Tooltip content="Remove runtime">
          <Button iconOnly variant="ghost" aria-label="Remove runtime" onClick={onRemove}>
            <Icon name="trash" size={14} />
          </Button>
        </Tooltip>
      </div>

      <div className="card__body" style={{ display: 'grid', gap: 'var(--s4)' }}>
        {health.quotaWarning ? (
          <Banner tone="warn" icon={<Icon name="alert" size={14} />}>
            {health.quotaWarning}
          </Banner>
        ) : null}

        <div className="grid grid--2">
          <Detail label="Executable">
            {profile.executablePath ? (
              <Tooltip content={profile.executablePath}>
                <span className="mono">{shortenPath(profile.executablePath, 4)}</span>
              </Tooltip>
            ) : (
              <span className="mono">resolved from PATH</span>
            )}
          </Detail>
          <Detail label="Concurrency">
            <div className="row">
              <input
                className="input"
                type="number"
                min={1}
                max={8}
                aria-label={`Concurrency of ${profile.name}`}
                style={{ width: 72 }}
                defaultValue={profile.maxConcurrent}
                onBlur={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next) && next !== profile.maxConcurrent) update.mutate({ maxConcurrent: next });
                }}
              />
              <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
                {view.activeRuns} running now
              </span>
            </div>
          </Detail>
        </div>

        {schema.length > 0 ? (
          <Detail label="Settings">
            <div className="row row--wrap" style={{ gap: 4 }}>
              {schema.map((field) => {
                const value = profile.settings[field.key];
                const shown = typeof value === 'string' && value.length > 0 ? value : null;
                return (
                  <span key={field.key} className={shown === null ? 'chip chip--muted' : 'chip'}>
                    {field.label}: {shown ?? 'default'}
                  </span>
                );
              })}
            </div>
          </Detail>
        ) : null}

        <Detail label="Capabilities">
          <div className="row row--wrap" style={{ gap: 4 }}>
            {profile.capabilities.length === 0 ? (
              <span className="dim">None reported</span>
            ) : (
              profile.capabilities.map((capability) => (
                <span key={capability} className="chip">
                  {capability}
                </span>
              ))
            )}
          </div>
        </Detail>

        {view.rolesRouted.length > 0 ? (
          <Detail label={`Preferred by ${pluralize(view.rolesRouted.length, 'role')}`}>
            <div className="row row--wrap" style={{ gap: 4 }}>
              {view.rolesRouted.map((role) => (
                <span key={role} className="chip chip--muted">
                  {titleCase(role)}
                </span>
              ))}
            </div>
          </Detail>
        ) : null}

        {update.isError ? <ErrorState error={update.error} /> : null}
      </div>
    </article>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="qa__q" style={{ marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)' }}>{children}</div>
    </div>
  );
}

/** "2.1.295" reads "v2.1.295"; a label like "built-in" stays as it is, not "vbuilt-in". */
function versionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

function DiscoveryModal({ results: found, onClose }: { results: readonly RuntimeDiscoveryView[]; onClose: () => void }): JSX.Element {
  // The fake runtime is for tests and demos: offered only with developer mode on (#108).
  const developer = useSettings().data?.developerMode === true;
  const results = developer ? found : found.filter((d) => d.adapterId !== 'fake');
  // A runtime belongs to the project. Two projects frequently want the same CLI
  // under different logins - a different `configDir` is the whole point of a
  // second profile - so a runtime configured here is this project's, not the
  // machine's.
  const workspaceId = useWorkspaceId();
  // The results are a snapshot from when discovery ran. Without this, a runtime
  // just added still offered a plain "Add", as if the click had done nothing.
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const configured = (discovery: RuntimeDiscoveryView): boolean => discovery.configured || added.has(discovery.adapterId);
  const create = useDaemonMutation(
    (daemon, discovery: RuntimeDiscoveryView) =>
      daemon.createRuntime({
        workspaceId,
        adapterId: discovery.adapterId,
        // A second profile of the same adapter would otherwise be
        // indistinguishable from the first in every list that shows a name.
        name: configured(discovery) ? `${discovery.displayName} (2)` : discovery.displayName,
        executablePath: discovery.executablePath,
        settings: discovery.suggestedSettings as Record<string, unknown>,
        enabled: true,
      }),
    ['runtimes'],
  );

  return (
    <Modal title="Runtimes on this machine" wide onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="stack">
        {results.length === 0 ? (
          <p>No agent runtimes were found on this machine. Install one, or add a generic CLI runtime by hand.</p>
        ) : (
          results.map((discovery) => (
            <div key={discovery.adapterId} className="list__row" style={{ border: '1px solid var(--border)', borderRadius: 'var(--tds-radius-md)' }}>
              <StatusDot tone={discovery.detected ? 'succeeded' : 'pending'} />
              <div className="list__main">
                <div className="list__title">{discovery.displayName}</div>
                <div className="list__subtitle truncate">
                  {discovery.detected
                    ? `${discovery.version ? `${versionLabel(discovery.version)} · ` : ''}${discovery.executablePath ?? 'on PATH'}`
                    : discovery.detail}
                </div>
              </div>
              {!discovery.detected ? (
                <Chip muted>not found</Chip>
              ) : (
                <div className="row" style={{ gap: 'var(--s2)' }}>
                  {configured(discovery) ? <Badge tone="succeeded">Configured</Badge> : null}
                  {/* Still offered once configured: a second profile of the same
                      adapter is a normal setup, not a mistake - one login for
                      deep work, another for review. */}
                  <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate(discovery, { onSuccess: () => setAdded((prev) => new Set(prev).add(discovery.adapterId)) })}>
                    {configured(discovery) ? 'Add another' : 'Add'}
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
        {create.isError ? <ErrorState error={create.error} /> : null}
      </div>
    </Modal>
  );
}

type ProfileMode = 'edit' | 'duplicate';

/**
 * Configure one runtime profile, or fork a second one from it.
 *
 * The settings fields are not written here. An adapter describes what it
 * understands (`view.settingsSchema`) and this renders whatever it is told, so
 * teaching Tandemise a new runtime setting never means touching the desktop -
 * which is the same reason a profile references an `adapterId` and not a vendor
 * (MVP.md §P2).
 *
 * Duplicating matters more than it looks: two profiles of the same adapter,
 * pointed at different config directories, are two independent workers with
 * their own logins and settings. That is what lets routing prefer one of them
 * for review and the other for deep work.
 */
function ProfileModal({ view, mode, onClose }: { view: RuntimeView; mode: ProfileMode; onClose: () => void }): JSX.Element {
  const { profile } = view;
  const workspaceId = useWorkspaceId();
  const schema = view.settingsSchema ?? [];
  const duplicating = mode === 'duplicate';
  const [name, setName] = useState(duplicating ? `${profile.name} (copy)` : profile.name);
  const [executablePath, setExecutablePath] = useState(profile.executablePath ?? '');
  const [settings, setSettings] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      schema.map((field) => {
        const value = profile.settings[field.key];
        return [field.key, typeof value === 'string' || typeof value === 'number' ? String(value) : ''];
      }),
    ),
  );

  const body = {
    name: name.trim(),
    executablePath: executablePath.trim() === '' ? null : executablePath.trim(),
    // Blank means "not set", which must reach the daemon as an absent key
    // rather than as an empty string the adapter would then try to honour.
    settings: Object.fromEntries(Object.entries(settings).filter(([, value]) => value.trim() !== '')),
  };

  const save = useDaemonMutation(
    (daemon) =>
      duplicating
        ? daemon.createRuntime({
            workspaceId,
            adapterId: profile.adapterId,
            ...body,
            args: [...profile.args],
            capabilities: [...profile.capabilities],
            maxConcurrent: profile.maxConcurrent,
            enabled: true,
          })
        : daemon.updateRuntime(profile.id, body),
    ['runtimes'],
  );

  return (
    <Modal
      title={duplicating ? `New profile from ${profile.name}` : `Configure ${profile.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={name.trim() === '' || save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            {save.isPending ? 'Saving…' : duplicating ? 'Create profile' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s4)', color: 'var(--text)' }}>
        {duplicating ? (
          <p className="muted">
            A second {view.adapterDisplayName} profile runs as its own worker. Give it a different config directory and it has its own login,
            settings and MCP servers — then route roles to whichever you prefer under Team.
          </p>
        ) : null}

        <Field label="Name">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>

        <Field label="Executable" hint="Absolute path. Leave blank to resolve from PATH.">
          <input
            className="input mono"
            value={executablePath}
            onChange={(event) => setExecutablePath(event.target.value)}
            placeholder="resolved from PATH"
          />
        </Field>

        {schema.map((field) => (
          <SettingInput
            key={field.key}
            field={field}
            value={settings[field.key] ?? ''}
            onChange={(next) => setSettings((prev) => ({ ...prev, [field.key]: next }))}
          />
        ))}

        {save.isError ? <ErrorState error={save.error} /> : null}
      </div>
    </Modal>
  );
}

function SettingInput({
  field,
  value,
  onChange,
}: {
  field: RuntimeSettingField;
  value: string;
  onChange: (next: string) => void;
}): JSX.Element {
  return (
    <Field label={field.label} hint={field.hint}>
      {field.kind === 'select' ? (
        <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input mono"
          type={field.kind === 'number' ? 'number' : 'text'}
          {...(field.min === undefined ? {} : { min: field.min })}
          {...(field.max === undefined ? {} : { max: field.max })}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder ?? ''}
        />
      )}
    </Field>
  );
}

/**
 * Wiring an arbitrary CLI is the escape hatch that makes "add a new runtime"
 * configuration rather than code (MVP.md §P2) - Codex, Gemini and opencode all
 * arrive this way.
 */
function GenericCliModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [promptVia, setPromptVia] = useState<'stdin' | 'arg' | 'file'>('stdin');

  const workspaceId = useWorkspaceId();
  const create = useDaemonMutation(
    (daemon) =>
      daemon.createRuntime({
        workspaceId,
        adapterId: 'generic-cli',
        name: name.trim(),
        executablePath: command.trim(),
        args: args.split(/\s+/).filter(Boolean),
        settings: { promptVia },
        enabled: true,
      }),
    ['runtimes'],
  );

  return (
    <Modal
      title="Add a CLI runtime"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || !command.trim() || create.isPending}
            onClick={() => create.mutate(undefined, { onSuccess: onClose })}
          >
            {create.isPending ? 'Adding…' : 'Add runtime'}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s4)', color: 'var(--text)' }}>
        <p className="muted">
          Any agent CLI that accepts a prompt and writes to stdout can be a Tandemise runtime. No new code is needed — the generic adapter
          normalizes its output into the shared event vocabulary.
        </p>
        <Field label="Name">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Codex" autoFocus />
        </Field>
        <Field label="Command" hint="Absolute path, or a name resolved from PATH.">
          <input className="input mono" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="/usr/local/bin/codex" />
        </Field>
        <Field label="Arguments" hint="Space separated. Added before the prompt.">
          <input className="input mono" value={args} onChange={(event) => setArgs(event.target.value)} placeholder="exec --json" />
        </Field>
        <Field label="How does it receive the prompt?">
          <select className="select" value={promptVia} onChange={(event) => setPromptVia(event.target.value as typeof promptVia)}>
            <option value="stdin">On stdin</option>
            <option value="arg">As the final argument</option>
            <option value="file">In a temporary file, path passed as the final argument</option>
          </select>
        </Field>
        {create.isError ? <ErrorState error={create.error} /> : null}
      </div>
    </Modal>
  );
}
