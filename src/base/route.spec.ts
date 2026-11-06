import { PlatformRoute, RouteFill } from '~/state/preferences/base-state';

import { estimateLap } from './route';

describe('estimateLap', () => {
  const gatherer = (fill: RouteFill): PlatformRoute => ({
    stops: [
      { location: 'aquilo', wait: 60 },
      { location: 'shattered-planet', wait: 60, fill },
    ],
    speed: 200,
  });

  it('should fly all the way to the shattered planet without a fill', () => {
    const lap = estimateLap({
      stops: [
        { location: 'aquilo', wait: 60 },
        { location: 'shattered-planet', wait: 60 },
      ],
      speed: 200,
    });
    // 2 x 4,100,000 km at 200 km/s plus 120 s waiting
    expect(lap?.minutes).toBeCloseTo(685.3, 1);
    expect(lap?.gather).toBeUndefined();
  });

  it('should fly all the way while nothing needs chunks', () => {
    const lap = estimateLap(gatherer({ collectors: 8, quality: 5 }));
    expect(lap?.minutes).toBeCloseTo(685.3, 1);
    expect(lap?.gather).toBeUndefined();
  });

  it('should turn back once it has half a lap of what the base uses', () => {
    // 0.1 chunks/s: it brings home 264, half of them on the way back
    const lap = estimateLap(gatherer({ collectors: 8, quality: 5 }), 0.1);
    expect(lap?.gather).toEqual({
      turnBack: 132,
      chunks: 264,
      km: 157321,
      auto: true,
    });
    // 2 x (100,000 + 157,321) km at 200 km/s plus 60 s at Aquilo
    expect(lap?.minutes).toBeCloseTo(43.89, 2);
    expect(0.1 * lap!.minutes * 60).toBeLessThanOrEqual(264);
  });

  it('should fly further with fewer arms at lower quality', () => {
    const lap = estimateLap(gatherer({ collectors: 8, quality: 0 }), 0.1);
    expect(lap?.gather?.km).toEqual(330530);
    expect(lap?.gather?.turnBack).toEqual(219);
  });

  it('should warn when a typed turn back brings too few', () => {
    const lap = estimateLap(
      gatherer({ collectors: 8, quality: 5, chunks: 100 }),
      0.1,
    );
    // Brings 200 in a 40.5 min lap that uses 243
    expect(lap?.gather).toEqual({
      turnBack: 100,
      chunks: 200,
      km: 136931,
      auto: false,
      short: 243,
    });
  });

  it('should reach the planet if it never fills', () => {
    const lap = estimateLap(
      gatherer({ collectors: 1, quality: 0, chunks: 1e9 }),
    );
    expect(lap?.gather?.km).toEqual(4000000);
    expect(lap?.minutes).toBeCloseTo(684.3, 1);
  });
});
