import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { Empty, ErrorState, SkeletonList } from '../components/primitives.js';
import { ArtifactReader } from './artifacts/ArtifactReader.js';
import { ArtifactRows } from './artifacts/ArtifactRows.js';
import { useArtifactSearch } from '../lib/queries.js';
import { pluralize } from '../lib/format.js';
import { Card } from '@tandemise/design/react';

export function Artifacts({ openId = null }: { openId?: string | null } = {}): JSX.Element {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  // Opened from elsewhere (a status report from Home): that artifact first, even an older version the list leaves out.
  const [selected, setSelected] = useState<string | null>(openId);
  const artifacts = useArtifactSearch(query);

  // Debounce: the daemon searches artifact bodies, which is not free.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input), 220);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    const first = artifacts.data?.[0]?.id ?? null;
    setSelected((current) => (current && (current === openId || artifacts.data?.some((a) => a.id === current)) ? current : first));
  }, [artifacts.data, openId]);

  useEffect(() => {
    if (openId !== null) setSelected(openId);
  }, [openId]);

  return (
    <>
      <PageHeader
        title="Artifacts"
        subtitle="Every spec, plan, report and decision the workforce has produced."
        actions={
          <div className="search" style={{ width: 280 }}>
            <Icon name="search" size={14} className="search__icon" />
            <input
              className="input"
              type="search"
              aria-label="Search artifacts"
              placeholder="Search titles and contents…"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </div>
        }
      />

      {artifacts.isError ? (
        <div style={{ padding: 'var(--s4) var(--s7)' }}>
          <ErrorState error={artifacts.error} onRetry={() => void artifacts.refetch()} />
        </div>
      ) : artifacts.isPending ? (
        <div className="page">
          <div className="page__inner">
            <SkeletonList rows={6} />
          </div>
        </div>
      ) : (artifacts.data ?? []).length === 0 ? (
        <div className="page">
          <div className="page__inner">
            <Card>
              <Empty
                icon="artifacts"
                title={query ? `Nothing matches “${query}”` : 'No artifacts yet'}
                body={
                  query
                    ? 'Search covers titles, summaries and contents. Try a single distinctive word.'
                    : 'Artifacts are the typed hand-off between roles. The first one appears as soon as a mission produces a spec or a plan.'
                }
              />
            </Card>
          </div>
        </div>
      ) : (
        <div className="reader">
          <div className="reader__list">
            <div className="sidebar__section">{pluralize((artifacts.data ?? []).length, 'artifact')}</div>
            <ArtifactRows artifacts={artifacts.data ?? []} selectedId={selected} onSelect={setSelected} />
          </div>
          <div className="reader__pane">
            <ArtifactReader id={selected} />
          </div>
        </div>
      )}
    </>
  );
}
