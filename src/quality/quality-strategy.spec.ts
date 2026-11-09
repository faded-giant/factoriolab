import { rational } from '~/rational/rational';
import { Dataset } from '~/state/settings/dataset';

import { allQualities, strategyModules } from './quality-strategy';

describe('quality strategy', () => {
  const qualities = [
    { id: 'normal', name: 'Normal', level: 0 },
    { id: 'legendary', name: 'Legendary', level: 5 },
  ];
  const module = { module: {} };
  const data = {
    qualityIds: qualities.map((q) => q.id),
    qualityRecord: Object.fromEntries(qualities.map((q) => [q.id, q])),
    machineIds: [
      'assembling-machine-3',
      'assembling-machine-3(5)',
      'recycler',
      'crusher',
      'lab',
    ],
    machineRecord: {
      'assembling-machine-3': { modules: rational(4n) },
      'assembling-machine-3(5)': { modules: rational(4n) },
      recycler: { modules: rational(4n) },
      crusher: { modules: rational(2n) },
      lab: {},
    },
    itemRecord: {
      'quality-module-3': module,
      'quality-module-3(5)': module,
      'productivity-module-3': module,
      'productivity-module-3(5)': module,
    },
  } as unknown as Dataset;
  const ids = allQualities(data, [
    'assembling-machine-3',
    'recycler',
    'crusher',
    'lab',
  ]);
  const plan = (
    strategy: 'every' | 'upcycle' | 'raw',
  ): Record<string, string> =>
    Object.fromEntries(
      Object.entries(
        strategyModules(data, ids, { strategy, tier: 3, quality: 5 }),
      ).map(([id, [m]]) => [id, `${m.id ?? ''} x${m.count?.toString() ?? ''}`]),
    );

  it('should cover every quality of each machine', () => {
    expect(ids).toEqual(data.machineIds);
  });

  it('should put quality modules in every machine', () => {
    expect(plan('every')).toEqual({
      'assembling-machine-3': 'quality-module-3(5) x4',
      'assembling-machine-3(5)': 'quality-module-3(5) x4',
      recycler: 'quality-module-3(5) x4',
      crusher: 'quality-module-3(5) x2',
    });
  });

  it('should upcycle with productivity in crafts and quality in recyclers', () => {
    expect(plan('upcycle')).toEqual({
      'assembling-machine-3': 'productivity-module-3(5) x4',
      'assembling-machine-3(5)': 'productivity-module-3(5) x4',
      recycler: 'quality-module-3(5) x4',
      crusher: 'productivity-module-3(5) x2',
    });
  });

  it('should make quality in crushers for legendary raw materials', () => {
    expect(plan('raw')).toEqual({
      'assembling-machine-3': 'productivity-module-3(5) x4',
      'assembling-machine-3(5)': 'productivity-module-3(5) x4',
      recycler: 'quality-module-3(5) x4',
      crusher: 'quality-module-3(5) x2',
    });
  });

  it('should fall back to normal modules if a quality is missing', () => {
    const lower = strategyModules(data, ['crusher'], {
      strategy: 'raw',
      tier: 3,
      quality: 2,
    });
    expect(lower['crusher'][0].id).toEqual('quality-module-3');
  });
});
