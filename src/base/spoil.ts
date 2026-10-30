/**
 * Minutes until an item spoils, from `spoil_ticks` in
 * `space-age/prototypes/item.lua` (2.1). Items not listed do not spoil.
 */
export const SPOIL_MINUTES: Record<string, number> = {
  'agricultural-science-pack': 60,
  bioflux: 120,
  'biter-egg': 30,
  'captive-biter-spawner': 30,
  'copper-bacteria': 1,
  'iron-bacteria': 1,
  jelly: 4,
  jellynut: 60,
  nutrients: 5,
  'pentapod-egg': 15,
  yumako: 60,
  'yumako-mash': 3,
};
