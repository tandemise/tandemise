import { Fragment, type ReactNode } from 'react';

/**
 * A small Markdown renderer that emits React elements.
 *
 * Artifact bodies are written by agents, which makes them untrusted content
 * (MVP.md §14.1). Rendering to elements rather than to an HTML string removes
 * the injection surface entirely - there is no `dangerouslySetInnerHTML` here
 * and no sanitizer to get wrong. The trade is a deliberately small dialect:
 * headings, lists, code, quotes, tables, rules, and inline emphasis/code/links.
 */
export function Markdown({ source }: { source: string }): JSX.Element {
  return <div className="prose">{renderBlocks(source.replace(/\r\n/g, '\n'))}</div>;
}

/** The smallest heading level the document uses (4 if none), ignoring `#` lines inside fenced code. */
function topHeadingLevel(lines: readonly string[]): number {
  let top = 4;
  let fenced = false;
  for (const line of lines) {
    if (/^```/.test(line)) fenced = !fenced;
    else if (!fenced) top = Math.min(top, /^(#{1,4})\s/.exec(line)?.[1]?.length ?? 4);
  }
  return top;
}

function renderBlocks(source: string): ReactNode[] {
  const lines = source.split('\n');
  // The document's top heading level, whatever it wrote it as (`#` or `##`), becomes an h3 for a screen reader.
  const top = topHeadingLevel(lines);
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      out.push(
        <pre key={key++}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      const text = heading[2] ?? '';
      const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[level - 1] ?? 'h4';
      // A document always sits under the page's h1 and the reader's h2, so its top heading is an h3 to a screen
      // reader and the rest follow without a gap (1.3.1); the tag keeps the look.
      out.push(<Tag key={key++} aria-level={Math.min(6, level - top + 3)}>{renderInline(text)}</Tag>);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr key={key++} />);
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(<blockquote key={key++}>{renderBlocks(body.join('\n'))}</blockquote>);
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i += 1;
        // A wrapped continuation line belongs to the item above it.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? '') && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? '')) {
          items[items.length - 1] += ` ${(lines[i] ?? '').trim()}`;
          i += 1;
        }
      }
      const children = items.map((item, index) => <li key={index}>{renderInline(item)}</li>);
      out.push(ordered ? <ol key={key++}>{children}</ol> : <ul key={key++}>{children}</ul>);
      continue;
    }

    if (line.includes('|') && /^\s*\|?[-:\s|]+\|[-:\s|]*$/.test(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|')) {
        rows.push(splitRow(lines[i] ?? ''));
        i += 1;
      }
      out.push(
        <div key={key++} style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                {header.map((cell, index) => (
                  <th key={index}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !isBlockStart(lines[i] ?? '')) {
      paragraph.push(lines[i] ?? '');
      i += 1;
    }
    out.push(<p key={key++}>{renderInline(paragraph.join(' '))}</p>);
  }

  return out;
}

function isBlockStart(line: string): boolean {
  return /^(#{1,4}\s|```|>|\s*([-*+]|\d+\.)\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(line);
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Inline pass: a backslash escape first (a status report quotes titles like
 * SCRIPTED_FAIL_RELEASE literally), then code spans (they suppress everything
 * inside), then links, then emphasis.
 */
const INLINE = /(\\[\\`*_[\]])|(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/g;

function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(text.slice(cursor, index));
    const token = match[0];

    if (token.startsWith('\\')) {
      parts.push(token.slice(1));
    } else if (token.startsWith('`')) {
      parts.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = link?.[1] ?? token;
      const href = link?.[2] ?? '';
      parts.push(
        isSafeHref(href) ? (
          <a key={key++} href={href} onClick={openExternally(href)}>
            {label}
          </a>
        ) : (
          <Fragment key={key++}>{label}</Fragment>
        ),
      );
    } else if (token.startsWith('**')) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    cursor = index + token.length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function openExternally(href: string) {
  return (event: React.MouseEvent): void => {
    event.preventDefault();
    void window.tandemise.openExternal(href);
  };
}
