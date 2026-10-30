import { rational } from '~/rational/rational';
import {
  BaseState,
  BaseTab,
  PlatformRoute,
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

export interface LapEstimate {
  /** Seconds flying */
  travel: number;
  /** Seconds waiting in orbit */
  wait: number;
  minutes: number;
}

/**
 * Lap time from a route's stops and cruise speed. Time spent speeding up
 * and slowing down is not counted.
 */
export function estimateLap(route?: PlatformRoute): LapEstimate | undefined {
  const stops = route?.stops ?? [];
  if (stops.length < 2 || !route?.speed || route.speed <= 0) return undefined;
  let km = 0;
  let wait = 0;
  for (let i = 0; i < stops.length; i++) {
    const leg = distance(
      stops[i].location,
      stops[(i + 1) % stops.length].location,
    );
    if (leg == null) return undefined;
    km += leg;
    wait += stops[i].wait ?? 0;
  }
  const travel = km / route.speed;
  return { travel, wait, minutes: (travel + wait) / 60 };
}

/** Minutes per lap: the one typed in, else the estimate */
export function lapMinutes(route?: PlatformRoute): number | undefined {
  if (route?.lap != null && route.lap > 0) return route.lap;
  return estimateLap(route)?.minutes;
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

export interface SiloBuffer {
  /** Platform tab id */
  platform: string;
  /** Rockets that have to be ready when the platform arrives */
  rockets: number;
  silos: number;
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

  const perCarrier = new Map<string, number>();
  for (const tab of base.tabs) {
    if (tab.id === id) continue;
    for (const [itemId, from] of Object.entries(tab.links ?? {})) {
      if (from !== id || !needsRocket(source, tab)) continue;
      const rockets = base.imports?.[tab.id]?.[itemId]?.rockets;
      const carrier = carrierFor(base, tab, itemId);
      if (rockets == null || !carrier) continue;
      perCarrier.set(
        carrier.id,
        (perCarrier.get(carrier.id) ?? 0) + rational(rockets).toNumber(),
      );
    }
  }

  const silos = base.summaries?.[id]?.silos;
  const production = silos ? Math.ceil(rational(silos).toNumber() - 1e-9) : 0;
  const perSilo = base.secondRocket ? 2 : 1;
  const buffers: SiloBuffer[] = [];
  const unknown: string[] = [];
  for (const [platform, perMinute] of perCarrier) {
    const lap = lapMinutes(base.tabs.find((t) => t.id === platform)?.route);
    if (lap == null) {
      unknown.push(platform);
      continue;
    }
    const rockets = Math.ceil(perMinute * lap - 1e-9);
    buffers.push({ platform, rockets, silos: Math.ceil(rockets / perSilo) });
  }

  if (!production && !buffers.length && !unknown.length) return undefined;
  const total = Math.max(production, ...buffers.map((b) => b.silos));
  return { production, buffers, unknown, total };
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
      const lap = lapMinutes(carrier.route);
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
  route: PlatformRoute | undefined,
  from: string | undefined,
  to: string | undefined,
): number {
  const lap = (lapMinutes(route) ?? 0) * 60;
  const stops = route?.stops ?? [];
  const start = stops.findIndex((s) => s.location === from);
  if (route?.lap || !route?.speed || start < 0 || !to) return lap / 2;
  let seconds = 0;
  for (let n = 0; n < stops.length; n++) {
    const i = (start + n) % stops.length;
    const next = stops[(i + 1) % stops.length];
    seconds += stops[i].wait ?? 0;
    seconds += (distance(stops[i].location, next.location) ?? 0) / route.speed;
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
    const lap = carrier ? lapMinutes(carrier.route) : undefined;
    if (carrier && lap != null) {
      age += 2 * lap;
      if (source.id !== carrier.id && tab.id !== carrier.id)
        age +=
          travelTime(carrier.route, stationAt(source), stationAt(tab)) / 60;
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
