import { rational } from '~/rational/rational';
import {
  BaseState,
  BaseTab,
  PlatformRoute,
  RouteFill,
  RouteStop,
} from '~/state/preferences/base-state';

import { needsRocket, SPACE_PLATFORM } from './base-logic';
import { SPOIL_MINUTES } from './spoil';

/** Platform routes, launch buffers and silo counts, kept free of Angular */

/**
 * Space Age space connections in km, from
 * `space-age/prototypes/planet/planet.lua` (2.1)
 */
export const SPACE_CONNECTIONS: [string, string, number][] = [
  ['nauvis', 'vulcanus', 15000],
  ['nauvis', 'gleba', 15000],
  ['nauvis', 'fulgora', 15000],
  ['vulcanus', 'gleba', 15000],
  ['gleba', 'fulgora', 15000],
  ['gleba', 'aquilo', 30000],
  ['fulgora', 'aquilo', 30000],
  ['aquilo', 'solar-system-edge', 100000],
  ['solar-system-edge', 'shattered-planet', 4000000],
];

/** Route stops that are not planets, so not in the calculator's locations */
export const SPACE_LOCATIONS: Record<string, string> = {
  'solar-system-edge': 'Solar system edge',
  'shattered-planet': 'Shattered planet',
};

/**
 * Shortest flight between two locations in km, following space connections
 * the way platforms do. Undefined if they are not connected.
 */
export function distance(from: string, to: string): number | undefined {
  if (from === to) return 0;
  const best = new Map<string, number>([[from, 0]]);
  const todo = new Set([from]);
  while (todo.size) {
    let here = '';
    for (const id of todo)
      if (!here || (best.get(id) ?? 0) < (best.get(here) ?? 0)) here = id;
    todo.delete(here);
    const km = best.get(here) ?? 0;
    if (here === to) return km;
    for (const [a, b, length] of SPACE_CONNECTIONS) {
      const next = a === here ? b : b === here ? a : undefined;
      if (next == null) continue;
      const known = best.get(next);
      if (known == null || km + length < known) {
        best.set(next, km + length);
        todo.add(next);
      }
    }
  }
  return undefined;
}

export const SHATTERED_PLANET = 'shattered-planet';
export const PROMETHIUM_CHUNK = 'promethium-asteroid-chunk';
const EDGE = 'solar-system-edge';

/**
 * PLACEHOLDER until the real asteroid data is read in. Promethium chunks
 * rise linearly from none at the solar system edge to this many per km, per
 * collector arm, at the shattered planet. Not taken from the game.
 */
const PLACEHOLDER_CHUNKS_PER_KM_ARM = 0.002 / 3;
/** Collector arms: 3, and one more per quality level (from memory) */
const collectorArms = (quality: number): number => 3 + quality;

export interface GatherPlan {
  /** Chunks aboard when it turns back, for the cargo condition */
  turnBack: number;
  /** Chunks it brings home: as many again come in on the way back */
  chunks: number;
  /** km past the solar system edge where it turns back */
  km: number;
  /** Whether the turn back was worked out from what the base uses */
  auto: boolean;
  /** Chunks the base uses per lap, if a typed turn back brings fewer */
  short?: number;
}

export interface LapEstimate {
  /** Seconds flying */
  travel: number;
  /** Seconds waiting in orbit */
  wait: number;
  minutes: number;
  /** For a platform that fills up with chunks before the shattered planet */
  gather?: GatherPlan;
}

/**
 * km between two stops. With `x`, a stop that turns back when full is
 * reached `x` km past the edge rather than at the shattered planet.
 */
function legKm(from: RouteStop, to: RouteStop, x?: number): number {
  const at = (stop: RouteStop): number | undefined =>
    x != null && stop.location === SHATTERED_PLANET && stop.fill
      ? x
      : undefined;
  const a = at(from);
  const b = at(to);
  if (a != null && b != null) return Math.abs(a - b);
  if (a != null) return a + (distance(EDGE, to.location) ?? NaN);
  if (b != null) return (distance(from.location, EDGE) ?? NaN) + b;
  return distance(from.location, to.location) ?? NaN;
}

/** km and waits of a lap; see legKm for `x` */
function lapParts(
  stops: RouteStop[],
  x?: number,
): { km: number; wait: number } | undefined {
  let km = 0;
  let wait = 0;
  for (let i = 0; i < stops.length; i++) {
    const leg = legKm(stops[i], stops[(i + 1) % stops.length], x);
    if (Number.isNaN(leg)) return undefined;
    km += leg;
    // Turning back early means never stopping there
    if (x == null || !stops[i].fill) wait += stops[i].wait ?? 0;
  }
  return { km, wait };
}

/**
 * Where a platform that turns back when full does so, for a base that needs
 * `rate` chunks per second from it. With chunks per km rising as k x / L, n
 * collectors gather n k x^2 / 2L flying out to x km past the edge and the
 * same again flying back, so it brings home c = n k x^2 / L: x = s sqrt(c),
 * s = sqrt(L / n k), turning back at c / 2. Bringing home just a lap's use,
 * c = rate x lap where the lap grows with sqrt(c): c = a + b sqrt(c), a
 * quadratic in sqrt(c).
 */
function gatherPlan(
  stops: RouteStop[],
  fill: RouteFill,
  speed: number,
  rate: number,
): GatherPlan | undefined {
  const length = distance(EDGE, SHATTERED_PLANET);
  const near = lapParts(stops, 0);
  if (!length || !near || !(fill.collectors > 0)) return undefined;
  const k = PLACEHOLDER_CHUNKS_PER_KM_ARM * collectorArms(fill.quality ?? 5);
  const s = Math.sqrt(length / (fill.collectors * k));
  const typed = fill.chunks != null && fill.chunks > 0;
  let chunks: number;
  if (typed) chunks = 2 * (fill.chunks ?? 0);
  else if (rate > 0) {
    const a = rate * (near.km / speed + near.wait);
    const b = (rate * 2 * s) / speed;
    const root = (b + Math.sqrt(b * b + 4 * a)) / 2;
    chunks = Math.ceil(root * root - 1e-9);
  } else return undefined;
  // Not full by the shattered planet: it brings what it gathered there
  const km = Math.min(length, s * Math.sqrt(chunks));
  if (km >= length) chunks = Math.floor((length / s) ** 2);
  const plan: GatherPlan = {
    turnBack: typed ? (fill.chunks ?? 0) : Math.ceil(chunks / 2),
    chunks,
    km: Math.round(km),
    auto: !typed,
  };
  const use = ((near.km + 2 * km) / speed + near.wait) * rate;
  if (use > chunks + 1e-9) plan.short = Math.ceil(use - 1e-9);
  return plan;
}

/**
 * Lap time from a route's stops and cruise speed. Time spent speeding up
 * and slowing down is not counted. `chunkRate` is the promethium chunks per
 * second the platform carries, for a stop that turns back when full.
 */
export function estimateLap(
  route?: PlatformRoute,
  chunkRate = 0,
): LapEstimate | undefined {
  const stops = route?.stops ?? [];
  if (stops.length < 2 || !route?.speed || route.speed <= 0) return undefined;
  const fill = stops.find(
    (s) => s.location === SHATTERED_PLANET && s.fill,
  )?.fill;
  const gather = fill && gatherPlan(stops, fill, route.speed, chunkRate);
  // Without a demand to size it by, it flies all the way
  const parts = lapParts(stops, gather?.km);
  if (!parts) return undefined;
  const travel = parts.km / route.speed;
  return {
    travel,
    wait: parts.wait,
    minutes: (travel + parts.wait) / 60,
    gather,
  };
}

/** Promethium chunks per second a platform carries */
export function chunkRate(base: BaseState, platformId: string): number {
  return carriedBy(base, platformId)
    .filter((s) => s.itemId === PROMETHIUM_CHUNK)
    .reduce((sum, s) => sum + s.rate, 0);
}

/** Minutes per lap: the one typed in, else the estimate */
export function lapMinutes(
  route?: PlatformRoute,
  chunks = 0,
): number | undefined {
  if (route?.lap != null && route.lap > 0) return route.lap;
  return estimateLap(route, chunks)?.minutes;
}

/** Minutes per lap of a platform tab, sizing any gathering from the base */
export function platformLap(
  base: BaseState,
  tab: BaseTab | undefined,
): number | undefined {
  return tab && lapMinutes(tab.route, chunkRate(base, tab.id));
}

/** Whether a tab is a platform that flies a route, rather than staying put */
export function isMoving(tab: BaseTab): boolean {
  return tab.location === SPACE_PLATFORM && tab.route?.stops.length !== 1;
}

/**
 * Where a tab stays: a planet, or the one stop of a parked platform (a barge).
 * Undefined for platforms that move.
 */
export function stationAt(tab: BaseTab): string | undefined {
  if (tab.location !== SPACE_PLATFORM) return tab.location;
  const stops = tab.route?.stops ?? [];
  return stops.length === 1 ? stops[0].location : undefined;
}

/**
 * The moving platform that brings tab `tab` its import of an item, if any:
 * the one picked with "via", else the supplier or importer itself if it is
 * the one flying. Imports between tabs that stay put arrive continuously.
 */
export function carrierFor(
  base: BaseState,
  tab: BaseTab,
  itemId: string,
): BaseTab | undefined {
  const via = tab.via?.[itemId];
  if (via) return base.tabs.find((t) => t.id === via);
  const source = base.tabs.find((t) => t.id === tab.links?.[itemId]);
  if (source && isMoving(source)) return source;
  if (source && isMoving(tab)) return tab;
  return undefined;
}

export interface Shipment {
  itemId: string;
  /** Supplying tab id */
  from: string;
  /** Importing tab id */
  to: string;
  /** Items per second */
  rate: number;
  /** Rocket launches per minute, if launched */
  rockets?: number;
}

/** Everything a platform tab carries between other tabs, or for itself */
export function carriedBy(base: BaseState, platformId: string): Shipment[] {
  const result: Shipment[] = [];
  for (const tab of base.tabs)
    for (const [itemId, from] of Object.entries(tab.links ?? {})) {
      if (carrierFor(base, tab, itemId)?.id !== platformId) continue;
      const entry = base.imports?.[tab.id]?.[itemId];
      if (!entry) continue;
      const source = base.tabs.find((t) => t.id === from);
      result.push({
        itemId,
        from,
        to: tab.id,
        rate: rational(entry.rate).toNumber(),
        rockets:
          source && needsRocket(source, tab) && entry.rockets != null
            ? rational(entry.rockets).toNumber()
            : undefined,
      });
    }
  return result;
}

export interface SiloItem {
  itemId: string;
  /** Rockets of this item waiting when the platform arrives */
  rockets: number;
  silos: number;
}

export interface SiloBuffer {
  /** Platform tab id */
  platform: string;
  /** Rockets that have to be ready when the platform arrives */
  rockets: number;
  silos: number;
  /** The same buffer by item, most silos first */
  items: SiloItem[];
}

export interface SiloPlan {
  /** Silos the build needs to keep up with its launches */
  production: number;
  buffers: SiloBuffer[];
  /** Platforms that pick up here but have no lap time yet */
  unknown: string[];
  /** Silos to build: enough for production and for the largest buffer */
  total: number;
}

/**
 * Rocket silos planet tab `id` needs. Each platform that picks up here must
 * find a whole lap of its launches waiting, one loaded rocket per silo (two
 * with `secondRocket`). Silos refill between visits, so the largest buffer
 * counts, not their sum. Platforms parked overhead take rockets as they come.
 */
export function siloPlan(base: BaseState, id: string): SiloPlan | undefined {
  const source = base.tabs.find((t) => t.id === id);
  if (!source?.location || source.location === SPACE_PLATFORM) return undefined;

  // Carrier id -> item id -> rockets per minute
  const perCarrier = new Map<string, Map<string, number>>();
  for (const tab of base.tabs) {
    if (tab.id === id) continue;
    for (const [itemId, from] of Object.entries(tab.links ?? {})) {
      if (from !== id || !needsRocket(source, tab)) continue;
      const rockets = base.imports?.[tab.id]?.[itemId]?.rockets;
      const carrier = carrierFor(base, tab, itemId);
      if (rockets == null || !carrier) continue;
      const items = perCarrier.get(carrier.id) ?? new Map<string, number>();
      perCarrier.set(carrier.id, items);
      items.set(
        itemId,
        (items.get(itemId) ?? 0) + rational(rockets).toNumber(),
      );
    }
  }

  const silos = base.summaries?.[id]?.silos;
  const production = silos ? Math.ceil(rational(silos).toNumber() - 1e-9) : 0;
  const perSilo = base.secondRocket ? 2 : 1;
  const buffers: SiloBuffer[] = [];
  const unknown: string[] = [];
  const ready = (perMinute: number, lap: number): number =>
    Math.ceil(perMinute * lap - 1e-9);
  for (const [platform, perItem] of perCarrier) {
    const lap = platformLap(
      base,
      base.tabs.find((t) => t.id === platform),
    );
    if (lap == null) {
      unknown.push(platform);
      continue;
    }
    let perMinute = 0;
    for (const r of perItem.values()) perMinute += r;
    const rockets = ready(perMinute, lap);
    const items = [...perItem]
      .map(([itemId, r]) => {
        const n = ready(r, lap);
        return { itemId, rockets: n, silos: Math.ceil(n / perSilo) };
      })
      .sort((a, b) => b.silos - a.silos || b.rockets - a.rockets);
    buffers.push({
      platform,
      rockets,
      silos: Math.ceil(rockets / perSilo),
      items,
    });
  }

  if (!production && !buffers.length && !unknown.length) return undefined;
  const total = Math.max(production, ...buffers.map((b) => b.silos));
  return { production, buffers, unknown, total };
}

/** Silos each exported item needs, over all the platforms collecting it */
export function itemSilos(plan: SiloPlan | undefined): Map<string, number> {
  const result = new Map<string, number>();
  for (const b of plan?.buffers ?? [])
    for (const i of b.items)
      result.set(i.itemId, (result.get(i.itemId) ?? 0) + i.silos);
  return result;
}

export type BufferKind = 'pickup' | 'dropoff' | 'carry';

export interface BufferLine {
  itemId: string;
  /** Items held at most */
  amount: number;
  kind: BufferKind;
  /** The moving platform whose lap sets the amount */
  platform: string;
  /** That platform's lap, minutes */
  lap: number;
}

/**
 * What each tab has to hold for hand-offs with moving platforms, by tab id.
 * Whoever stays put holds one lap of the items: the supplier until the
 * platform picks them up, the importer to keep running until the next drop,
 * and the platform while it carries them. Pickups from planets wait loaded
 * in rockets, so they are counted as silos instead.
 */
export function buffers(base: BaseState): Record<string, BufferLine[]> {
  const result: Record<string, BufferLine[]> = {};
  const add = (id: string, line: BufferLine): void => {
    const lines = (result[id] ??= []);
    const same = lines.find(
      (l) =>
        l.itemId === line.itemId &&
        l.kind === line.kind &&
        l.platform === line.platform,
    );
    if (same) same.amount += line.amount;
    else lines.push(line);
  };

  for (const tab of base.tabs)
    for (const [itemId, from] of Object.entries(tab.links ?? {})) {
      const carrier = carrierFor(base, tab, itemId);
      const source = base.tabs.find((t) => t.id === from);
      const entry = base.imports?.[tab.id]?.[itemId];
      if (!carrier || !source || !entry) continue;
      const lap = platformLap(base, carrier);
      if (lap == null) continue;
      const amount = rational(entry.rate).toNumber() * lap * 60;
      const line = { itemId, amount, platform: carrier.id, lap };
      if (source.id !== carrier.id && source.location === SPACE_PLATFORM)
        add(source.id, { ...line, kind: 'pickup' });
      add(carrier.id, { ...line, kind: 'carry' });
      if (tab.id !== carrier.id) add(tab.id, { ...line, kind: 'dropoff' });
    }
  return result;
}

/**
 * Seconds a platform takes from one stop to another along its route, or half
 * a lap if that cannot be worked out
 */
export function travelTime(
  base: BaseState,
  carrier: BaseTab,
  from: string | undefined,
  to: string | undefined,
): number {
  const route = carrier.route;
  const lap = (platformLap(base, carrier) ?? 0) * 60;
  const stops = route?.stops ?? [];
  const start = stops.findIndex((s) => s.location === from);
  if (route?.lap || !route?.speed || start < 0 || !to) return lap / 2;
  const x = estimateLap(route, chunkRate(base, carrier.id))?.gather?.km;
  let seconds = 0;
  for (let n = 0; n < stops.length; n++) {
    const i = (start + n) % stops.length;
    const next = stops[(i + 1) % stops.length];
    if (x == null || !stops[i].fill) seconds += stops[i].wait ?? 0;
    seconds += (legKm(stops[i], next, x) || 0) / route.speed;
    if (next.location === to) return seconds;
  }
  return lap / 2;
}

export interface SpoilWarning {
  /** Importing tab id */
  tab: string;
  itemId: string;
  /** Oldest the item gets before it is used, minutes */
  age: number;
  /** When it spoils, minutes */
  spoils: number;
}

/**
 * Items that can spoil before they are used. Each hand-off by a moving
 * platform adds, at worst, a lap waiting on one side, a lap on the other
 * and the flight between; a tab that passes an item on adds its own age.
 */
export function spoilWarnings(base: BaseState): SpoilWarning[] {
  const ages = new Map<string, number>();
  const ageAt = (tab: BaseTab, itemId: string, seen: Set<string>): number => {
    const key = `${tab.id}|${itemId}`;
    const known = ages.get(key);
    if (known != null) return known;
    const from = tab.links?.[itemId];
    const source = base.tabs.find((t) => t.id === from);
    if (!source || seen.has(key)) return 0;
    seen.add(key);
    let age = ageAt(source, itemId, seen);
    const carrier = carrierFor(base, tab, itemId);
    const lap = carrier ? platformLap(base, carrier) : undefined;
    if (carrier && lap != null) {
      age += 2 * lap;
      if (source.id !== carrier.id && tab.id !== carrier.id)
        age +=
          travelTime(base, carrier, stationAt(source), stationAt(tab)) / 60;
    }
    ages.set(key, age);
    return age;
  };

  const warnings: SpoilWarning[] = [];
  for (const tab of base.tabs)
    for (const itemId of Object.keys(tab.links ?? {})) {
      const spoils = SPOIL_MINUTES[itemId];
      if (spoils == null) continue;
      const age = ageAt(tab, itemId, new Set());
      if (age > spoils) warnings.push({ tab: tab.id, itemId, age, spoils });
    }
  return warnings;
}

export type RouteWarning =
  | {
      kind: 'missedStop';
      /** Platform tab id */
      platform: string;
      /** Location the route should visit */
      location: string;
    }
  | {
      kind: 'bothMoving';
      platform: string;
      /** The other moving platform it has to meet */
      other: string;
    };

/**
 * Hand-offs a platform cannot make: a stop missing from its route, or a meet
 * with another moving platform, which only works if their schedules line up
 */
export function routeWarnings(base: BaseState): RouteWarning[] {
  const warnings: RouteWarning[] = [];
  for (const platform of base.tabs) {
    // Parked platforms only carry when picked with "via", which needs them
    // to be at both ends
    if (platform.location !== SPACE_PLATFORM) continue;
    const stops = new Set(platform.route?.stops.map((s) => s.location));
    const needed = new Set<string>();
    const others = new Set<string>();
    for (const s of carriedBy(base, platform.id))
      for (const id of [s.from, s.to]) {
        const tab = base.tabs.find((t) => t.id === id);
        if (!tab || tab.id === platform.id) continue;
        const station = stationAt(tab);
        if (station) needed.add(station);
        else others.add(tab.id);
      }
    for (const location of needed)
      if (!stops.has(location))
        warnings.push({ kind: 'missedStop', platform: platform.id, location });
    for (const other of others)
      warnings.push({ kind: 'bothMoving', platform: platform.id, other });
  }
  return warnings;
}
