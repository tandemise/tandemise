import type { Mission, MissionCriterion, ProfileHistory, ProfileInput, Repository } from '@tandemise/domain';

/**
 * Gathers a task's profile signals from what is known at Start (#53 §2): its
 * title and goal, the Done-when lines a person gave, file paths named in the
 * text, the repositories named, and a person's Quick or Careful; and, when
 * Start made the mission from a tracker item, that item's type and labels
 * (#154). Once the change is measured, the files it touched (#210).
 */
const PATH_PATTERN = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.\w+)/g;

export function pathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_PATTERN)) out.add(m[1]!.replace(/^\.\//, ''));
  return [...out];
}

export function userCriteriaCount(criteria: readonly MissionCriterion[]): number {
  return criteria.filter((c) => c.source === 'user' && c.status === 'accepted').length;
}

export function gatherSignals(input: {
  readonly mission: Mission;
  readonly criteria: readonly MissionCriterion[];
  readonly repositories: readonly Repository[];
  readonly history?: ProfileHistory | null;
  readonly extraPaths?: readonly string[];
  readonly basis?: 'predicted' | 'measured';
  readonly trackerType?: string | null;
  readonly labels?: readonly string[];
  readonly sources?: readonly string[];
  /** The files the change touched, once measured (#210). */
  readonly changed?: readonly string[];
}): ProfileInput {
  const { mission, repositories } = input;
  const text = `${mission.title}\n${mission.goal}`;
  const lower = text.toLowerCase();
  const own = repositories.find((r) => r.id === mission.repositoryId);
  const named = repositories.filter((r) => new RegExp(`\\b${r.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)).map((r) => r.name);
  const repos = [...new Set([...(own === undefined ? [] : [own.name]), ...named])];
  return {
    item: {
      title: mission.title,
      description: mission.goal,
      trackerType: input.trackerType ?? null,
      labels: input.labels ?? [],
      sources: input.sources ?? [],
      criteria: userCriteriaCount(input.criteria),
    },
    paths: [...new Set([...pathsIn(text), ...(input.extraPaths ?? [])])],
    repos,
    projectRepos: repositories.length,
    history: input.history ?? null,
    person: mission.laneRequest ?? 'auto',
    tiebreak: null,
    basis: input.basis ?? 'predicted',
    ...(input.changed === undefined ? {} : { changed: input.changed }),
  };
}
