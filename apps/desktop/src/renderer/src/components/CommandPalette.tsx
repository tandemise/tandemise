import { useEffect, useMemo, useRef, useState } from 'react';
import { useDialogLayer } from '@tandemise/design/react';
import { useLocation } from 'wouter';
import { Icon, type IconName } from './Icon.js';
import { useMissions } from '../lib/queries.js';
import { humanizeStatus } from '../lib/format.js';
import { evalsHref } from '../screens/evals/link.js';

interface Command {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon: IconName;
  readonly run: () => void;
}

/**
 * ⌘K. Navigation and mission-jumping only - the palette is a way to move, not
 * a second place to perform destructive actions.
 */
export function CommandPalette({ onClose }: { onClose: () => void }): JSX.Element {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // The same layer stack as every dialog: Escape closes it, Tab stays inside, focus goes back to where it was.
  useDialogLayer(panel, onClose, { initialFocus: '.palette__input' });
  const missions = useMissions();

  const commands = useMemo<readonly Command[]>(() => {
    const go = (href: string) => () => {
      navigate(href);
      onClose();
    };
    const navigation: Command[] = [
      { id: 'new', group: 'Actions', label: 'New mission', hint: '⌘N', icon: 'plus', run: go('/missions/new') },
      { id: 'home', group: 'Go to', label: 'Home', icon: 'home', run: go('/') },
      { id: 'missions', group: 'Go to', label: 'Missions', icon: 'flag', run: go('/missions') },
      { id: 'inbox', group: 'Go to', label: 'Inbox', icon: 'approvals', run: go('/inbox') },
      { id: 'artifacts', group: 'Go to', label: 'Artifacts', icon: 'artifacts', run: go('/artifacts') },
      { id: 'team', group: 'Go to', label: 'Team', icon: 'workforce', run: go('/team') },
      { id: 'skills', group: 'Go to', label: 'Skills', icon: 'book', run: go('/skills') },
      { id: 'evals', group: 'Go to', label: 'Evals', icon: 'target', run: go(evalsHref({ tab: 'suites' })) },
      { id: 'runtimes', group: 'Go to', label: 'Runtimes', icon: 'runtimes', run: go('/runtimes') },
      { id: 'integrations', group: 'Go to', label: 'Integrations', icon: 'integrations', run: go('/integrations') },
      { id: 'project', group: 'Go to', label: 'Repositories', icon: 'folder', run: go('/project') },
      { id: 'settings', group: 'Go to', label: 'Settings', icon: 'settings', run: go('/settings') },
    ];
    const missionCommands: Command[] = (missions.data ?? []).map((summary) => ({
      id: summary.mission.id,
      group: 'Missions',
      label: summary.mission.title,
      hint: humanizeStatus(summary.mission.status),
      icon: 'flag',
      run: go(`/missions/${summary.mission.id}`),
    }));
    return [...navigation, ...missionCommands];
  }, [missions.data, navigate, onClose]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands.slice(0, 12);
    return commands.filter((command) => command.label.toLowerCase().includes(needle)).slice(0, 20);
  }, [commands, query]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((current) => Math.min(current + 1, matches.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((current) => Math.max(current - 1, 0));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        matches[active]?.run();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [matches, active, onClose]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let lastGroup = '';

  return (
    <div className="overlay overlay--top" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          className="palette__input"
          role="combobox"
          aria-label="Jump to a mission, or type a command"
          aria-expanded={true}
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={matches[active] ? `palette-option-${matches[active].id}` : undefined}
          placeholder="Jump to a mission, or type a command…"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="palette__list" ref={listRef} id="palette-list" role="listbox" aria-label="Commands and missions">
          {matches.length === 0 ? (
            <div role="presentation" style={{ padding: '20px 16px', color: 'var(--text-tertiary)', fontSize: 'var(--fs-sm)' }}>
              Nothing matches “{query}”.
            </div>
          ) : (
            matches.map((command, index) => {
              const header = command.group !== lastGroup ? command.group : null;
              lastGroup = command.group;
              return (
                <div key={command.id} role="presentation">
                  {header ? <div className="palette__group" aria-hidden="true">{header}</div> : null}
                  <button
                    type="button"
                    tabIndex={-1}
                    role="option"
                    id={`palette-option-${command.id}`}
                    aria-selected={index === active}
                    className="palette__item"
                    data-active={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={command.run}
                  >
                    <Icon name={command.icon} size={15} className="navitem__icon" />
                    <span className="truncate">{command.label}</span>
                    {command.hint ? <span className="palette__hint">{command.hint}</span> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="palette__foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
