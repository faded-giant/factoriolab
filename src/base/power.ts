import { Rational, rational } from '~/rational/rational';
import {
  BaseState,
  BaseTab,
  PowerSource,
  TabPower,
} from '~/state/preferences/base-state';

/** Same as in base-logic, which imports this file */
const SPACE_PLATFORM = 'space-platform';

/**
 * Generators to cover a tab's electric use, and the fuel they burn. Numbers
 * come from the Factorio 2.1 prototypes; quality scales every generator by
 * the usual 1 + 0.3 per level.
 */

/** Surface solar % and day length (s) for planets, solar % in orbit */
export const SOLAR: Record<
  string,
  { surface?: number; space: number; day?: number }
> = {
  nauvis: { surface: 100, space: 300, day: 420 },
  vulcanus: { surface: 400, space: 600, day: 90 },
  gleba: { surface: 50, space: 200, day: 600 },
  fulgora: { surface: 20, space: 120, day: 180 },
  aquilo: { surface: 1, space: 60, day: 1200 },
  'solar-system-edge': { space: 1 },
  'shattered-planet': { space: 1 },
};

/** MW at normal quality */
const SOLAR_PANEL = 0.06;
const ACCUMULATOR_MJ = 5;
const STEAM_ENGINE = 0.9;
/** Boiler heat, enough for two engines */
const BOILER = 1.8;
const BOILER_EFFECTIVITY = 1;
const STEAM_TURBINE = 5.82;
const HEAT_EXCHANGER = 10;
const NUCLEAR_REACTOR = 40;
/** Heat out per MW of fuel burned */
const HEATING_TOWER_EFFECTIVITY = 2.5;
const HEATING_TOWER = 40 * HEATING_TOWER_EFFECTIVITY;
/** Plasma for two generators; the reactor also draws power itself */
const FUSION_REACTOR = 100;
const FUSION_REACTOR_DRAW = 10;
const FUSION_GENERATOR = 50;

/** Day/night shape shared by all planets: day 50%, dusk and dawn 20% each */
const SOLAR_AVERAGE = 0.7;
/** Accumulator energy per panel, as a fraction of peak power x day length */
const SOLAR_NIGHT = 0.168;

/** Steam items, and MJ each holds for a generator */
export const STEAM_500 = 'steam';
const STEAM_MJ: Record<string, number> = { [STEAM_500]: 0.097 };
export const URANIUM_FUEL_CELL = 'uranium-fuel-cell';
const URANIUM_FUEL_CELL_MJ = 8000;
export const FUSION_POWER_CELL = 'fusion-power-cell';
const FUSION_POWER_CELL_MJ = 40000;

/** Machines that run on heat, which the data lists as electric */
export const HEAT_MACHINES = new Set(['heat-exchanger']);

export const POWER_SOURCES: PowerSource[] = [
  'solar',
  'steam-engine',
  'steam-turbine',
  'heating-tower',
  'nuclear',
  'fusion',
];

/** Building shown for each source */
export const POWER_SOURCE_ICONS: Record<PowerSource, string> = {
  solar: 'solar-panel',
  'steam-engine': 'steam-engine',
  'steam-turbine': 'steam-turbine',
  'heating-tower': 'heating-tower',
  nuclear: 'nuclear-reactor',
  fusion: 'fusion-reactor',
};

/** New choices default to legendary, like new builds */
export const DEFAULT_POWER_QUALITY = 5;
export const DEFAULT_FUEL = 'solid-fuel';

/** Sources that burn a fuel the user picks */
export const BURNER_SOURCES = new Set<PowerSource>([
  'steam-engine',
  'heating-tower',
]);

export function qualityMultiplier(level: number): number {
  return 1 + 0.3 * level;
}

export interface PowerLine {
  /** Item id of the building */
  itemId: string;
  count: number;
}

export interface PowerPlan {
  /** Electric use this source covers, MW */
  demand: number;
  buildings: PowerLine[];
  /** Fuel the build makes for the generators, per second */
  fuel?: { itemId: string; rate: Rational };
  /** Reactors laid out in two rows, for the neighbour bonus */
  rows?: number;
  /** Why no plan could be made */
  problem?: 'noRoute' | 'noSun' | 'noFuel';
}

export interface TabPowerPlan {
  /** Electric use of the whole tab, MW */
  demand: number;
  /** One per source, in the tab's order */
  sources: PowerPlan[];
  /** MW no source covers */
  uncovered: number;
}

/** A tab's power sources; older bases kept a single one */
export function tabPowers(tab: BaseTab | undefined): TabPower[] {
  const power = tab?.power as TabPower[] | TabPower | undefined;
  if (power == null) return [];
  return Array.isArray(power) ? power : [power];
}

/**
 * Electric use the plan covers, MW, rounded up to 0.1 MW. Rounding lets the
 * fuel added to a build settle: the fuel chain uses power too, so each pass
 * can only push the demand up a step, never back and forth.
 */
function demandMW(kW: number): number {
  return Math.ceil(kW / 100 - 1e-9) / 10;
}

const tenth = (mw: number): number => Math.ceil(mw * 10 - 1e-9) / 10;

const count = (need: number, each: number): number =>
  Math.ceil(need / each - 1e-9);

/**
 * Smallest number of reactors whose heat covers `need` plus `draw` for each
 * reactor, laid out in two rows so each gets +100% per neighbour: n reactors
 * in 2 x n/2 make each x (4n - 4), and a single one makes `each`.
 */
function reactors(
  need: number,
  each: number,
  draw = 0,
): { n: number; heat: number } {
  if (need + draw <= each + 1e-9) return { n: 1, heat: each };
  for (let n = 2; ; n += 2) {
    const heat = each * (4 * n - 4);
    if (heat >= need + n * draw - 1e-9) return { n, heat };
  }
}

/** Solar % that applies where the tab is: worst stop for a moving platform */
function sunlight(base: BaseState, tab: BaseTab): number | undefined {
  if (tab.location !== SPACE_PLATFORM)
    return SOLAR[tab.location ?? '']?.surface;
  const stops = tab.route?.stops ?? [];
  if (!stops.length) return undefined;
  return Math.min(...stops.map((s) => SOLAR[s.location]?.space ?? 1));
}

/**
 * Generators for tab `id`, or undefined if it has no sources or no totals.
 * Fixed MW shares are covered first, then percentages of the tab's use, and
 * sources with neither split what is left evenly.
 */
export function powerPlan(
  base: BaseState,
  id: string,
  fuels: Record<string, number> = {},
): TabPowerPlan | undefined {
  const tab = base.tabs.find((t) => t.id === id);
  const choices = tabPowers(tab);
  const kW = base.summaries?.[id]?.power;
  if (!tab || !choices.length || kW == null) return undefined;

  const demand = demandMW(rational(kW).toNumber());
  const shares = choices.map(() => 0);
  let left = demand;
  choices.forEach((c, i) => {
    if (c.mw == null) return;
    shares[i] = Math.min(c.mw, left);
    left -= shares[i];
  });
  choices.forEach((c, i) => {
    if (c.mw != null || c.percent == null) return;
    shares[i] = Math.min(tenth((demand * c.percent) / 100), left);
    left -= shares[i];
  });
  const rest = choices.filter((c) => c.mw == null && c.percent == null);
  choices.forEach((c, i) => {
    if (c.mw == null && c.percent == null)
      shares[i] = tenth(left / rest.length);
  });
  if (rest.length) left = 0;

  return {
    demand,
    sources: choices.map((c, i) => sourcePlan(base, tab, c, shares[i], fuels)),
    uncovered: Math.max(0, Number(left.toFixed(1))),
  };
}

function sourcePlan(
  base: BaseState,
  tab: BaseTab,
  choice: TabPower,
  demand: number,
  fuels: Record<string, number>,
): PowerPlan {
  const q = qualityMultiplier(choice.quality ?? DEFAULT_POWER_QUALITY);
  const plan: PowerPlan = { demand, buildings: [] };
  if (demand <= 0) return plan;
  const perSecond = (n: number): Rational =>
    rational(BigInt(Math.ceil(n * 1e6 - 1e-6)), 1000000n);
  /** Fuel for burning `demand` MW at `effectivity`; false if not a fuel */
  const burn = (effectivity: number): boolean => {
    const fuel = choice.fuel ?? DEFAULT_FUEL;
    const mj = fuels[fuel];
    if (!mj) return false;
    plan.fuel = { itemId: fuel, rate: perSecond(demand / effectivity / mj) };
    return true;
  };
  const steam = (itemId: string): void => {
    plan.fuel = { itemId, rate: perSecond(demand / STEAM_MJ[itemId]) };
  };

  switch (choice.source) {
    case 'solar': {
      const percent = sunlight(base, tab);
      if (percent == null) return { ...plan, problem: 'noRoute' };
      if (percent <= 0) return { ...plan, problem: 'noSun' };
      const peak = SOLAR_PANEL * q * (percent / 100);
      const day = SOLAR[tab.location ?? '']?.day;
      // Platforms are always in sunlight
      if (tab.location === SPACE_PLATFORM || day == null) {
        plan.buildings.push({
          itemId: 'solar-panel',
          count: count(demand, peak),
        });
        break;
      }
      const panels = count(demand, peak * SOLAR_AVERAGE);
      plan.buildings.push(
        { itemId: 'solar-panel', count: panels },
        {
          itemId: 'accumulator',
          count: count(panels * SOLAR_NIGHT * peak * day, ACCUMULATOR_MJ * q),
        },
      );
      break;
    }
    case 'steam-engine': {
      plan.buildings.push(
        { itemId: 'boiler', count: count(demand, BOILER * q) },
        { itemId: 'steam-engine', count: count(demand, STEAM_ENGINE * q) },
      );
      if (!burn(BOILER_EFFECTIVITY)) return { ...plan, problem: 'noFuel' };
      break;
    }
    case 'steam-turbine':
      plan.buildings.push({
        itemId: 'steam-turbine',
        count: count(demand, STEAM_TURBINE * q),
      });
      steam(STEAM_500);
      break;
    case 'heating-tower': {
      plan.buildings.push(
        { itemId: 'heating-tower', count: count(demand, HEATING_TOWER * q) },
        { itemId: 'heat-exchanger', count: count(demand, HEAT_EXCHANGER * q) },
        { itemId: 'steam-turbine', count: count(demand, STEAM_TURBINE * q) },
      );
      if (!burn(HEATING_TOWER_EFFECTIVITY))
        return { ...plan, problem: 'noFuel' };
      break;
    }
    case 'nuclear': {
      const r = reactors(demand, NUCLEAR_REACTOR * q);
      plan.buildings.push(
        { itemId: 'nuclear-reactor', count: r.n },
        { itemId: 'heat-exchanger', count: count(demand, HEAT_EXCHANGER * q) },
        { itemId: 'steam-turbine', count: count(demand, STEAM_TURBINE * q) },
      );
      if (r.n > 1) plan.rows = 2;
      // Fuel burns at the base rate however much the bonus adds
      plan.fuel = {
        itemId: URANIUM_FUEL_CELL,
        rate: perSecond(
          (demand / r.heat) *
            ((r.n * NUCLEAR_REACTOR * q) / URANIUM_FUEL_CELL_MJ),
        ),
      };
      break;
    }
    case 'fusion': {
      // Each reactor also draws power, which the plasma has to cover too
      const r = reactors(demand, FUSION_REACTOR * q, FUSION_REACTOR_DRAW * q);
      const gross = demand + r.n * FUSION_REACTOR_DRAW * q;
      plan.buildings.push(
        { itemId: 'fusion-reactor', count: r.n },
        {
          itemId: 'fusion-generator',
          count: count(gross, FUSION_GENERATOR * q),
        },
      );
      if (r.n > 1) plan.rows = 2;
      plan.fuel = {
        itemId: FUSION_POWER_CELL,
        rate: perSecond(
          (gross / r.heat) *
            ((r.n * FUSION_REACTOR * q) / FUSION_POWER_CELL_MJ),
        ),
      };
      break;
    }
  }
  return plan;
}

/** Fuel tab `id` has to make for its own generators, per second */
export function powerDemands(
  base: BaseState,
  id: string,
  fuels?: Record<string, number>,
): Record<string, Rational> {
  const result: Record<string, Rational> = {};
  for (const { fuel } of powerPlan(base, id, fuels)?.sources ?? [])
    if (fuel?.rate.nonzero())
      result[fuel.itemId] = (result[fuel.itemId] ?? rational.zero).add(
        fuel.rate,
      );
  return result;
}

/** Reads a share typed by the user: "40%", "500" (MW) or blank for the rest */
export function parseShare(text: string): Pick<TabPower, 'percent' | 'mw'> {
  const value = text.trim().toLowerCase().replace(/mw$/, '').trim();
  if (!value) return {};
  const percent = value.endsWith('%');
  const n = Number(percent ? value.slice(0, -1) : value);
  if (!Number.isFinite(n) || n < 0) return {};
  return percent ? { percent: Math.min(n, 100) } : { mw: n };
}

export function shareText(power: TabPower): string {
  if (power.mw != null) return `${power.mw.toString()} MW`;
  if (power.percent != null) return `${power.percent.toString()}%`;
  return '';
}
