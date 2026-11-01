import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import { Modal } from './Modal.js';

import { useWorkspace } from '../lib/workspace.js';
import { ProjectForm } from '../screens/FirstProject.js';

/**
 * Which project this window is working on.
 *
 * It sits at the top of the sidebar rather than in Settings because it changes
 * what every screen below it is showing - a project is the frame, not a
 * setting. An install with one project still shows it, so the frame is visible
 * before there is anything to switch between.
 */
export function WorkspaceSwitcher(): JSX.Element {
  const { current, all, select } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Back to the button that opened it, if focus was inside the menu.
      if (root.current?.contains(document.activeElement)) root.current.querySelector<HTMLElement>('.wsswitch__trigger')?.focus();
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const repositories = current?.repositories.length ?? 0;

  return (
    <div className="wsswitch" ref={root}>
      <button
        type="button"
        className="wsswitch__trigger"
        aria-expanded={open}
        aria-controls="wsswitch-menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="wsswitch__body">
          <span className="wsswitch__name truncate">{current?.workspace.name ?? 'No project'}</span>
          <span className="wsswitch__meta">
            {repositories === 0 ? 'No repositories' : `${repositories} ${repositories === 1 ? 'repository' : 'repositories'}`}
          </span>
        </span>
        <Icon name="chevronDown" size={13} />
      </button>

      {open ? (
        // A disclosure of plain buttons: a listbox may hold only options, and "New project…" is an action (4.1.2).
        <div className="wsswitch__menu" id="wsswitch-menu" role="group" aria-label="Projects">
          {all.map((view) => (
            <button
              key={view.workspace.id}
              type="button"
              aria-current={view.workspace.id === current?.workspace.id ? 'true' : undefined}
              className="wsswitch__option"
              onClick={() => {
                select(view.workspace.id);
                setOpen(false);
              }}
            >
              <span className="wsswitch__check">
                {view.workspace.id === current?.workspace.id ? <Icon name="check" size={13} /> : null}
              </span>
              <span className="truncate">{view.workspace.name}</span>
              <span className="wsswitch__count">{view.repositories.length}</span>
            </button>
          ))}
          <div className="wsswitch__sep" role="separator" />
          <button
            type="button"
            className="wsswitch__option"
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
          >
            <span className="wsswitch__check">
              <Icon name="plus" size={13} />
            </span>
            <span>New project…</span>
          </button>
        </div>
      ) : null}

      {creating ? <NewWorkspaceModal onClose={() => setCreating(false)} onCreated={select} /> : null}
    </div>
  );
}

function NewWorkspaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}): JSX.Element {
  return (
    <Modal title="New project" onClose={onClose}>
      <div className="stack" style={{ gap: 'var(--s4)', color: 'var(--text)' }}>
        <p className="muted">
          A project keeps its own repositories, roles, runtimes and integrations. Nothing configured here reaches another project.
        </p>
        <ProjectForm
          onCreated={(id) => {
            onCreated(id);
            onClose();
          }}
        />
      </div>
    </Modal>
  );
}
