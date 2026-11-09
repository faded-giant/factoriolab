import { baseId, qualityId } from '~/data/schema/quality';
import { ModuleSettings } from '~/state/module-settings';
import { Dataset } from '~/state/settings/dataset';

/**
 * Ways to make items of a higher quality. A strategy only picks the modules
 * each kind of machine gets; the solver then works out the recipes, loops and
 * machine counts from the quality split those modules give.
 */
export type QualityStrategy = 'every' | 'upcycle' | 'raw';

export const QUALITY_STRATEGIES: QualityStrategy[] = [
  'every',
  'upcycle',
  'raw',
];

export interface QualityPlan {
  strategy: QualityStrategy;
  /** Module tier, 1 to 3 */
  tier: number;
  /** Quality level of the modules themselves */
  quality: number;
}

/** Machines that recycle, and that crush asteroids, by base id */
const RECYCLER = 'recycler';
const CRUSHER = 'crusher';

/** Machines a strategy always sets, used yet or not */
export const STRATEGY_MACHINES = [RECYCLER, CRUSHER];

/**
 * Module kind for a machine: quality modules where quality is made, and
 * productivity elsewhere so fewer inputs are needed
 */
function moduleKind(
  strategy: QualityStrategy,
  machine: string,
): 'quality' | 'productivity' {
  if (machine === RECYCLER) return 'quality';
  switch (strategy) {
    case 'every':
      return 'quality';
    case 'upcycle':
      return 'productivity';
    case 'raw':
      return machine === CRUSHER ? 'quality' : 'productivity';
  }
}

/** The module item for a kind, tier and quality, if the data has it */
export function moduleId(
  data: Dataset,
  kind: 'quality' | 'productivity',
  tier: number,
  quality: number,
): string | undefined {
  const id = `${kind}-module${tier > 1 ? `-${tier.toString()}` : ''}`;
  const q = data.qualityIds
    .map((i) => data.qualityRecord[i])
    .find((r) => r?.level === quality);
  const withQuality = q ? qualityId(id, q) : id;
  if (data.itemRecord[withQuality]?.module) return withQuality;
  return data.itemRecord[id]?.module ? id : undefined;
}

/**
 * Machine id -> modules filling every slot, for each machine of `machineIds`
 * that takes modules. A recipe that does not allow a machine's modules falls
 * back to the usual module ranking.
 */
export function strategyModules(
  data: Dataset,
  machineIds: Iterable<string>,
  plan: QualityPlan,
): Record<string, ModuleSettings[]> {
  const result: Record<string, ModuleSettings[]> = {};
  for (const id of machineIds) {
    const slots = data.machineRecord[id]?.modules;
    if (slots == null || slots === true || slots.isZero()) continue;
    const kind = moduleKind(plan.strategy, baseId(id));
    const module = moduleId(data, kind, plan.tier, plan.quality);
    if (module) result[id] = [{ id: module, count: slots }];
  }
  return result;
}

/** Every quality of each machine in `ids`, as base ids */
export function allQualities(data: Dataset, ids: Iterable<string>): string[] {
  const bases = new Set([...ids].map((i) => baseId(i)));
  return data.machineIds.filter((m) => bases.has(baseId(m)));
}
