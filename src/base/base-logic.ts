import { rational, Rational } from '~/rational/rational';
import { Step } from '~/solver/step';
import { BaseState, TabImport, TabSummary } from '~/state/preferences/base-state';
import { ObjectiveState } from '~/state/objectives/objective';
import { ObjectiveType } from '~/state/objectives/objective-type';
import { ObjectiveUnit } from '~/state/objectives/objective-unit';
import { TotalValue } from '~/state/objectives/total-value';

/** Pure calculations for linking builds in a base, kept free of Angular */

/** Items per second as a short per-minute string */
export function perMinute(perSecond: Rational | string): string {
  const value = rational(perSecond.toString()).mul(rational(60n)).toNumber();
  return `${Number(value.toFixed(1))}/min`;
}

/** Item id -> items per second that other tabs pull from `build` */
export function exportsFor(
  base: BaseState,
  build: string,
): Record<string, Rational> {
  const result: Record<string, Rational> = {};
  for (const tab of base.tabs) {
    if (tab.build === build) continue;
    for (const [itemId, source] of Object.entries(tab.links ?? {})) {
      if (source !== build) continue;
      const rate = base.imports?.[tab.build]?.[itemId]?.rate;
      if (rate == null) continue;
      result[itemId] = (result[itemId] ?? rational.zero).add(rational(rate));
    }
  }
  return result;
}

/** Whether a tab's export objectives are behind what other tabs now need */
export function isStale(base: BaseState, build: string): boolean {
  const tab = base.tabs.find((t) => t.build === build);
  if (!tab) return false;
  const exports = exportsFor(base, build);
  const applied = tab.applied ?? {};
  const ids = new Set([...Object.keys(exports), ...Object.keys(applied)]);
  for (const id of ids) {
    const a = exports[id] ?? rational.zero;
    const b = applied[id] != null ? rational(applied[id]) : rational.zero;
    if (!a.eq(b)) return true;
  }
  return false;
}

export interface ReconcilePlan {
  updates: { id: string; value: Rational }[];
  adds: { targetId: string; value: Rational }[];
  /** Item ids whose export objective should be removed */
  removes: string[];
}

function isExportObjective(o: ObjectiveState, itemId: string): boolean {
  return (
    o.targetId === itemId &&
    o.unit === ObjectiveUnit.Items &&
    o.type === ObjectiveType.Output
  );
}

/**
 * Changes needed so a tab's objectives produce exactly what other tabs pull
 * from it. `dispRate` converts items per second to the tab's display rate.
 */
export function planReconcile(
  objectives: ObjectiveState[],
  exports: Record<string, Rational>,
  previouslyApplied: Record<string, string>,
  dispRate: Rational,
): ReconcilePlan {
  const plan: ReconcilePlan = { updates: [], adds: [], removes: [] };

  for (const [itemId, perSecond] of Object.entries(exports)) {
    const value = perSecond.mul(dispRate);
    const existing = objectives.find((o) => isExportObjective(o, itemId));
    if (!value.nonzero()) {
      if (existing) plan.removes.push(itemId);
    } else if (!existing) plan.adds.push({ targetId: itemId, value });
    else if (!existing.value.eq(value))
      plan.updates.push({ id: existing.id, value });
  }

  // Exports nobody pulls any more
  for (const itemId of Object.keys(previouslyApplied)) {
    if (exports[itemId] != null) continue;
    if (objectives.some((o) => isExportObjective(o, itemId)))
      plan.removes.push(itemId);
  }

  return plan;
}

export function findExportObjective(
  objectives: ObjectiveState[],
  itemId: string,
): ObjectiveState | undefined {
  return objectives.find((o) => isExportObjective(o, itemId));
}

/** What a solved tab needs from outside: its excluded items */
export function importsFrom(
  steps: Step[],
  excludedIds: Set<string>,
  dispRate: Rational,
): Record<string, TabImport> {
  const result: Record<string, TabImport> = {};
  for (const step of steps) {
    if (step.itemId == null || !excludedIds.has(step.itemId)) continue;
    if (!step.items?.nonzero()) continue;
    const entry: TabImport = { rate: step.items.div(dispRate).toString() };
    if (step.rockets?.nonzero())
      entry.rockets = step.rockets.div(dispRate).mul(rational(60n)).toString();
    result[step.itemId] = entry;
  }
  return result;
}

export function summarize(
  machines: Record<string, TotalValue>,
  power: Rational,
): TabSummary {
  let buildings = rational.zero;
  for (const total of Object.values(machines))
    if (total.tooltipType === 'machine') buildings = buildings.add(total.total);
  return { buildings: buildings.toString(), power: power.toString() };
}

/** Points every reference to a renamed build at its new name */
export function renameBuild(
  base: BaseState,
  from: string,
  to: string,
): BaseState {
  const rename = <T>(
    record: Record<string, T> | undefined,
  ): Record<string, T> | undefined => {
    if (!record || !(from in record)) return record;
    const next = { ...record, [to]: record[from] };
    delete next[from];
    return next;
  };

  return {
    ...base,
    tabs: base.tabs.map((t) => ({
      ...t,
      build: t.build === from ? to : t.build,
      links: t.links
        ? Object.fromEntries(
            Object.entries(t.links).map(([i, s]) => [i, s === from ? to : s]),
          )
        : undefined,
    })),
    imports: rename(base.imports),
    summaries: rename(base.summaries),
  };
}

export interface BaseWarning {
  build: string;
  itemId: string;
  kind: 'missingSource' | 'importsOwnExport';
  /** Supplying tab, for `missingSource` */
  source?: string;
}

/** Problems worth flagging on the overview */
export function baseWarnings(base: BaseState): BaseWarning[] {
  const builds = new Set(base.tabs.map((t) => t.build));
  const warnings: BaseWarning[] = [];
  for (const tab of base.tabs) {
    for (const [itemId, source] of Object.entries(tab.links ?? {}))
      if (!builds.has(source))
        warnings.push({ build: tab.build, itemId, kind: 'missingSource', source });

    // A tab asked to export an item it has excluded just imports it again
    const exports = exportsFor(base, tab.build);
    for (const itemId of Object.keys(exports))
      if (base.imports?.[tab.build]?.[itemId])
        warnings.push({ build: tab.build, itemId, kind: 'importsOwnExport' });
  }
  return warnings;
}
