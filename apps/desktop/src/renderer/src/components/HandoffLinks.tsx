import { useState } from 'react';
import type { HandoffLink } from '@tandemise/domain';
import { Icon } from './Icon.js';
import { useDaemon } from '../lib/connection.js';
import { describeError } from '../lib/daemon.js';
import { showFlash } from '../lib/notices.js';
import { Tooltip } from '@tandemise/design/react';

/**
 * The links on a handoff that do something when clicked: a web address the
 * main process will open (it refuses anything but http(s), and a dead button
 * is worse than none), or a workspace path the daemon can resolve (spec A5).
 */
export function openableLinks(links: readonly HandoffLink[] | undefined): readonly HandoffLink[] {
  return (links ?? []).filter((link) => isWorkspacePath(link) || (link.url !== undefined && /^https?:\/\//i.test(link.url)));
}

function isWorkspacePath(link: HandoffLink): link is HandoffLink & { path: string } {
  return link.kind === 'workspace' && link.path !== undefined && link.path !== '';
}

/**
 * One handoff link as a button. A workspace path is resolved by the daemon
 * first (it checks the path stays inside the project's repositories or the
 * artifact store) and then shown in the file manager; the renderer never builds an
 * absolute path itself.
 */
export function HandoffLinkButton({
  link,
  workspaceId,
  className = 'btn',
  icon = false,
}: {
  link: HandoffLink;
  workspaceId: string | undefined;
  className?: string;
  /** The reader's style: the label, then an external-link icon rather than an arrow in the text. */
  icon?: boolean;
}): JSX.Element {
  const daemon = useDaemon();
  const [opening, setOpening] = useState(false);

  if (isWorkspacePath(link)) {
    const reveal = async (): Promise<void> => {
      if (workspaceId === undefined) return;
      setOpening(true);
      try {
        const { path } = await daemon.resolveWorkspaceLink(workspaceId, link.path);
        await window.tandemise.revealInFinder(path);
      } catch (error) {
        // A button has no room for an error box; the refusal is said the way a result is.
        showFlash(describeError(error).detail);
      } finally {
        setOpening(false);
      }
    };
    return (
      <Tooltip content={link.path}>
        <button type="button" className={className} disabled={opening || workspaceId === undefined} onClick={() => void reveal()}>
          Open workspace ↗
        </button>
      </Tooltip>
    );
  }

  const url = link.url ?? '';
  return (
    <Tooltip content={url}>
      <button type="button" className={className} onClick={() => void window.tandemise.openExternal(url)}>
        {link.label}
        {icon ? <Icon name="externalLink" size={12} /> : ' ↗'}
      </button>
    </Tooltip>
  );
}
