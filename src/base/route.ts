import { rational } from '~/rational/rational';
import {
  BaseState,
  BaseTab,
  PlatformRoute,
} from '~/state/preferences/base-state';

import { needsRocket, SPACE_PLATFORM } from './base-logic';

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

/** The platform tab that carries tab `tab`'s import of an item, if any */
export function carrierFor(
  base: BaseState,
  tab: BaseTab,
  itemId: string,
): BaseTab | undefined {
  const via = tab.via?.[itemId];
  if (via) return base.tabs.find((t) => t.id === via);
  // A platform importing from a planet picks the items up itself
  if (tab.location === SPACE_PLATFORM && tab.links?.[itemId]) return tab;
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

/** Everything a platform tab carries for other tabs, or picks up itself */
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
 * counts, not their sum.
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

export interface RouteWarning {
  /** Platform tab id */
  platform: string;
  /** Location the route should visit */
  location: string;
}

/** Locations a platform has to visit for what it carries, but does not */
export function routeWarnings(base: BaseState): RouteWarning[] {
  const warnings: RouteWarning[] = [];
  for (const platform of base.tabs) {
    if (platform.location !== SPACE_PLATFORM) continue;
    const stops = new Set(platform.route?.stops.map((s) => s.location));
    const needed = new Set<string>();
    for (const s of carriedBy(base, platform.id))
      for (const id of [s.from, s.to]) {
        const location = base.tabs.find((t) => t.id === id)?.location;
        if (location && location !== SPACE_PLATFORM) needed.add(location);
      }
    for (const location of needed)
      if (!stops.has(location))
        warnings.push({ platform: platform.id, location });
  }
  return warnings;
}
