import { PlatformRoute } from '~/state/preferences/base-state';

import { estimateLap } from './route';

describe('estimateLap', () => {
  const gatherer = (quality: number, bays: number): PlatformRoute => ({
    stops: [
      { location: 'aquilo', wait: 60 },
      { location: 'shattered-planet', wait: 60, fill: { quality, bays } },
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
    const lap = estimateLap(gatherer(5, 10));
    expect(lap?.minutes).toBeCloseTo(685.3, 1);
    expect(lap?.gather).toBeUndefined();
  });

  it('should size collectors and the turn back from the base', () => {
    // 0.1 chunks/s and a 265-chunk hold: a full hold every 2650 s at most,
    // so it may fly 159,000 km past the edge, which 8 legendary collectors
    // reach. It then brings home 264, half of them on the way back.
    const lap = estimateLap(gatherer(5, 10), 0.1);
    expect(lap?.gather).toEqual({
      collectors: 8,
      turnBack: 132,
      chunks: 264,
      hold: 265,
      km: 157321,
    });
    // 2 x (100,000 + 157,321) km at 200 km/s plus 60 s at Aquilo
    expect(lap?.minutes).toBeCloseTo(43.89, 2);
    expect(0.1 * lap!.minutes * 60).toBeLessThanOrEqual(264);
  });

  it('should need more collectors at lower quality', () => {
    // 3 arms instead of 8
    expect(estimateLap(gatherer(0, 10), 0.1)?.gather?.collectors).toEqual(21);
  });

  it('should say when even a full hold is too little', () => {
    const gather = estimateLap(gatherer(5, 0), 1)?.gather;
    expect(gather?.problem).toEqual('holdTooSmall');
    expect(gather?.hold).toEqual(65);
  });
});
