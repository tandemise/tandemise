import type {
  Approval, ApprovalKind, ArtifactManifest, ArtifactType, CheckOutcome, CheckResult, CriteriaTrace, CriterionResult,
  Evaluation, GateFacts, GateValue, RiskClass,
} from '@tandemise/domain';
import { RISK_CLASSES, blockingFindings, criteriaCoveragePercent } from '@tandemise/domain';

/**
 * The gate fact vocabulary lives in `@tandemise/domain` (`gate-facts.ts`) since
 * P15, next to the validator that reads each fact's scope. It is re-exported
 * here so everything that imported it from this package keeps working.
 */
export { GATE_FACT_VOCABULARY } from '@tandemise/domain';
export type { FactDefinition, FactScope } from '@tandemise/domain';

/** Fact name each approval kind is published under. */
const APPROVAL_FACT_NAME: Readonly<Record<ApprovalKind, string>> = {
  plan: 'approval.plan',
  choice: 'approval.choice',
  exception: 'approval.exception',
  action: 'approval.action',
  // MVP.md §17.2 names this gate condition `approval.release_candidate`.
  release: 'approval.release_candidate',
  intervention: 'approval.intervention',
  check: 'approval.check',
};

/**
 * Assembles the fact map `evaluateGate` consumes.
 *
 * Built incrementally because the inputs arrive at different times - checks
 * when a run finishes, the review when the evaluator role reports, the approval
 * when a human decides - and a partially built map is a legitimate thing to
 * evaluate against: it is how the UI shows which conditions are still
 * outstanding.
 */
/** FAIL beats TIMEOUT beats SKIP beats PASS: the least reassuring measurement wins. */
function worstOutcome(existing: GateValue, next: CheckOutcome): CheckOutcome {
  if (existing === undefined) return next;
  const rank = (o: GateValue): number => (o === 'FAIL' ? 3 : o === 'TIMEOUT' ? 2 : o === 'SKIP' ? 1 : 0);
  return rank(existing) >= rank(next) ? (existing as CheckOutcome) : next;
}

export class GateFactBuilder {
  readonly #facts: Record<string, GateValue> = {};

  /**
   * Folds check results into facts, worst-outcome-wins per name.
   *
   * This fold is over SCOPE, not over time. The caller passes one result per
   * (repository, name) - already reduced to the newest measurement of each -
   * so the same name arrives more than once only when a mission spans several
   * repositories. A gate asking "did the tests pass" means all of them, so any
   * FAIL is decisive and SKIP only survives when nothing actually ran.
   *
   * Passing raw history here instead is a bug, and was one: worst-wins over a
   * task's every attempt pins a check to FAIL from its first failure onward,
   * which no retry can ever clear. Reduce time first - see
   * `GateService.#currentChecks`.
   */
  withChecks(results: readonly CheckResult[]): this {
    for (const result of results) {
      const existing = this.#facts[result.name];
      this.#facts[result.name] = worstOutcome(existing, result.outcome);
    }
    return this;
  }

  withArtifacts(manifests: readonly ArtifactManifest[]): this {
    const counts = new Map<ArtifactType, number>();
    for (const m of manifests) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
    for (const [type, count] of counts) {
      this.#facts[`artifact.${type}.exists`] = count > 0;
      this.#facts[`artifact.${type}.count`] = count;
    }
    return this;
  }

  /** Declares which types were looked for, so a missing one reads `false` not `undefined`. */
  expectingArtifactTypes(types: readonly ArtifactType[]): this {
    for (const type of types) {
      this.#facts[`artifact.${type}.exists`] ??= false;
      this.#facts[`artifact.${type}.count`] ??= 0;
    }
    return this;
  }

  withReview(evaluation: Evaluation): this {
    this.#facts['review.verdict'] = evaluation.verdict;
    this.#facts['review.blocking_findings'] = blockingFindings(evaluation).length;
    this.#facts['review.major_findings'] = evaluation.findings.filter((f) => f.severity === 'major').length;
    return this;
  }

  withQa(input: { readonly criteria: readonly CriterionResult[]; readonly blockingDefects: number; readonly verdict?: string }): this {
    // A ledger already measured coverage against every criterion (withCriteria);
    // QA's own list only speaks for the criteria it chose to mention.
    this.#facts['qa.acceptance_criteria_coverage'] ??= criteriaCoveragePercent(input.criteria);
    this.#facts['qa.blocking_defects'] = input.blockingDefects;
    if (input.verdict !== undefined) this.#facts['qa.verdict'] = input.verdict;
    return this;
  }

  /**
   * Facts from the Done-when ledger, traced against the newest QA report.
   *
   * The criteria.* counts are always written - "no criteria" is a count. The
   * qa facts are not, with an empty ledger: a mission from before the ledger,
   * or one nobody gave criteria, keeps its old facts rather than reading
   * "0 unverified" and shipping. With a ledger, the qa.criteria_* facts are
   * written even before QA ran, because "nothing verified yet" is a
   * measurement, and coverage is recomputed against every counted criterion -
   * the denominator QA's own result list cannot provide.
   */
  withCriteria(trace: CriteriaTrace): this {
    this.#facts['criteria.total'] = trace.total;
    this.#facts['criteria.user_total'] = trace.userTotal;
    this.#facts['criteria.uncovered_user'] = trace.uncoveredUser;
    this.#facts['criteria.unknown_covers'] = trace.unknownCovers;
    if (trace.total === 0) return this;
    this.#facts['qa.criteria_verified'] = trace.verified;
    this.#facts['qa.criteria_failed'] = trace.failed;
    this.#facts['qa.criteria_unverified'] = trace.unverified;
    this.#facts['qa.acceptance_criteria_coverage'] = trace.counted === 0 ? 0 : Math.round((trace.verified / trace.counted) * 100);
    return this;
  }

  /**
   * A pending approval dominates an approved one of the same kind: if anything
   * is still waiting on a human, the gate must not report APPROVED.
   */
  withApprovals(approvals: readonly Approval[]): this {
    const byName = new Map<string, Approval[]>();
    for (const approval of approvals) {
      const name = APPROVAL_FACT_NAME[approval.kind];
      byName.set(name, [...(byName.get(name) ?? []), approval]);
    }
    for (const [name, group] of byName) {
      // Ordered from least to most reassuring, so the result never depends on
      // which row the database returned first. `group[0]` made
      // [APPROVED, EXPIRED] read APPROVED and the reverse read EXPIRED for the
      // same set of facts.
      this.#facts[name] = group.some((a) => a.status === 'PENDING') ? 'PENDING'
        : group.some((a) => a.status === 'REJECTED') ? 'REJECTED'
        : group.some((a) => a.status === 'EXPIRED') ? 'EXPIRED'
        : group.some((a) => a.status === 'CANCELLED') ? 'CANCELLED'
        : group.every((a) => a.status === 'APPROVED') ? 'APPROVED'
        : 'PENDING';
    }
    return this;
  }

  /**
   * Facts about the task itself, for conditions such as "a second opinion on
   * anything that ships". The caller classifies the risk: this package knows
   * the order of the classes, not which capability falls in which.
   */
  /** P12: whether the step's run differs in runtime or model from the run it must be independent of. */
  withIndependence(independent: boolean): this {
    this.#facts['review.independent'] = independent;
    return this;
  }

  /** P13: how many pinned skills the step's newest run received, and how many it did not. */
  withSkills(input: { readonly loaded: number; readonly missing: number }): this {
    this.#facts['skills.loaded'] = input.loaded;
    this.#facts['skills.missing'] = input.missing;
    return this;
  }

  withTask(input: { readonly attempt: number; readonly roleId: string; readonly risk: RiskClass }): this {
    this.#facts['task.attempt'] = input.attempt;
    this.#facts['task.role'] = input.roleId;
    this.#facts['task.risk'] = input.risk;
    this.#facts['task.risk_level'] = RISK_CLASSES.indexOf(input.risk);
    return this;
  }

  withDiff(input: { readonly filesChanged: number }): this {
    this.#facts['diff.files_changed'] = input.filesChanged;
    return this;
  }

  withFact(name: string, value: GateValue): this {
    this.#facts[name] = value;
    return this;
  }

  build(): GateFacts {
    return { ...this.#facts };
  }
}

export function approvalFactName(kind: ApprovalKind): string {
  return APPROVAL_FACT_NAME[kind];
}
