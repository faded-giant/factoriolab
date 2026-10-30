import { Rational, rational } from '~/rational/rational';
import { Step } from '~/solver/step';
import { ObjectiveState } from '~/state/objectives/objective';
import { ObjectiveType } from '~/state/objectives/objective-type';
import { ObjectiveUnit } from '~/state/objectives/objective-unit';
import { TotalValue } from '~/state/objectives/total-value';
import {
  BaseState,
  BaseTab,
  TabImport,
  TabSummary,
} from '~/state/preferences/base-state';

/** Pure calculations for linking builds in a base, kept free of Angular */

export const SPACE_PLATFORM = 'space-platform';

/** Rocket parts that make up one rocket, for counting launch costs */
export interface RocketCost {
  itemId: string;
  parts: Rational;
}

/** Items per second as a short per-minute string */
export function perMinute(perSecond: Rational | string): string {
  const value = rational(perSecond.toString()).mul(rational(60n)).toNumber();
  return `${Number(value.toFixed(1))}/min`;
}

/** Shown in the tab bar */
export function tabLabel(tab: BaseTab): string {
  return tab.label ?? tab.build ?? tab.id;
}

/**
 * Bases saved before tabs had ids used the build name as the key. Gives such
 * tabs an id equal to their build name, which keeps every reference valid.
 */
export function withTabIds(base: BaseState): BaseState {
  if (base.tabs.every((t) => (t as Partial<BaseTab>).id != null)) return base;
  return {
    ...base,
    tabs: base.tabs.map((t) =>
      (t as Partial<BaseTab>).id != null ? t : { ...t, id: t.build ?? '' },
    ),
  };
}

/** Item id -> items per second that other tabs pull from tab `id` */
export function exportsFor(
  base: BaseState,
  id: string,
): Record<string, Rational> {
  const result: Record<string, Rational> = {};
  for (const tab of base.tabs) {
    if (tab.id === id) continue;
    for (const [itemId, source] of Object.entries(tab.links ?? {})) {
      if (source !== id) continue;
      const rate = base.imports?.[tab.id]?.[itemId]?.rate;
      if (rate == null) continue;
      result[itemId] = (result[itemId] ?? rational.zero).add(rational(rate));
    }
  }
  return result;
}

/**
 * Whether items shipped from `source` to `target` have to be launched. Planets
 * launch rockets to reach anywhere else; platforms drop items for free.
 */
export function needsRocket(source: BaseTab, target: BaseTab): boolean {
  return (
    source.location != null &&
    source.location !== SPACE_PLATFORM &&
    source.location !== target.location
  );
}

/** Rockets per second tab `id` launches to ship its exports */
export function launchesFor(base: BaseState, id: string): Rational {
  const source = base.tabs.find((t) => t.id === id);
  let total = rational.zero;
  if (!source) return total;
  for (const tab of base.tabs) {
    if (tab.id === id || !needsRocket(source, tab)) continue;
    for (const [itemId, src] of Object.entries(tab.links ?? {})) {
      if (src !== id) continue;
      const rockets = base.imports?.[tab.id]?.[itemId]?.rockets;
      if (rockets != null)
        total = total.add(rational(rockets).div(rational(60n)));
    }
  }
  return total;
}

/**
 * Item id -> items per second tab `id` has to make for other tabs: its exports,
 * plus the rocket parts to launch them
 */
export function demandsFor(
  base: BaseState,
  id: string,
  rocket?: RocketCost,
): Record<string, Rational> {
  const result = exportsFor(base, id);
  if (!rocket) return result;
  const parts = launchesFor(base, id).mul(rocket.parts);
  if (parts.nonzero())
    result[rocket.itemId] = (result[rocket.itemId] ?? rational.zero).add(parts);
  return result;
}

/** Whether a tab's export objectives are behind what other tabs now need */
export function isStale(
  base: BaseState,
  id: string,
  rocket?: RocketCost,
): boolean {
  const tab = base.tabs.find((t) => t.id === id);
  if (!tab) return false;
  const exports = demandsFor(base, id, rocket);
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

/** Totals for the overview; `siloIds` are the machines that are silos */
export function summarize(
  machines: Record<string, TotalValue>,
  power: Rational,
  siloIds = new Set<string>(),
): TabSummary {
  let buildings = rational.zero;
  let silos = rational.zero;
  for (const [id, total] of Object.entries(machines)) {
    if (total.tooltipType !== 'machine') continue;
    buildings = buildings.add(total.total);
    if (siloIds.has(id)) silos = silos.add(total.total);
  }
  const summary: TabSummary = {
    buildings: buildings.toString(),
    power: power.toString(),
  };
  if (silos.nonzero()) summary.silos = silos.toString();
  return summary;
}

/** Points tabs backed by a renamed build at its new name */
export function renameBuild(
  base: BaseState,
  from: string,
  to: string,
): BaseState {
  base = withTabIds(base);
  if (!base.tabs.some((t) => t.build === from)) return base;
  return {
    ...base,
    tabs: base.tabs.map((t) => (t.build === from ? { ...t, build: to } : t)),
  };
}

export interface BaseWarning {
  /** Tab id */
  tab: string;
  itemId: string;
  kind: 'missingSource' | 'importsOwnExport';
  /** Supplying tab, for `missingSource` */
  source?: string;
}

/** Problems worth flagging on the overview */
export function baseWarnings(base: BaseState): BaseWarning[] {
  const ids = new Set(base.tabs.map((t) => t.id));
  const warnings: BaseWarning[] = [];
  for (const tab of base.tabs) {
    for (const [itemId, source] of Object.entries(tab.links ?? {}))
      if (!ids.has(source))
        warnings.push({ tab: tab.id, itemId, kind: 'missingSource', source });

    // A tab asked to export an item it has excluded just imports it again
    const exports = exportsFor(base, tab.id);
    for (const itemId of Object.keys(exports))
      if (base.imports?.[tab.id]?.[itemId])
        warnings.push({ tab: tab.id, itemId, kind: 'importsOwnExport' });
  }
  return warnings;
}

/** Tabs whose exports changed, or that were never solved, in base order */
export function tabsToProcess(base: BaseState, rocket?: RocketCost): BaseTab[] {
  return base.tabs.filter(
    (t) =>
      isStale(base, t.id, rocket) ||
      (t.build != null && !base.summaries?.[t.id]),
  );
}
