import { estimateLap, turnaround } from './route';

describe('turnaround', () => {
  it('should turn back once the hold is full', () => {
    // sqrt(2 x 4,000,000 km x 2000 / (10 x 0.002)) = 894,427 km
    expect(turnaround({ collectors: 10, chunks: 2000 })).toEqual({
      km: 894427,
      full: true,
    });
  });

  it('should reach the planet if the hold never fills', () => {
    expect(turnaround({ collectors: 1, chunks: 1e9 })).toEqual({
      km: 4000000,
      full: false,
    });
  });

  it('should need collectors and chunks', () => {
    expect(turnaround({ collectors: 0, chunks: 2000 })).toBeUndefined();
  });
});

describe('estimateLap', () => {
  const stops = [{ location: 'aquilo', wait: 60 }];

  it('should fly all the way to the shattered planet without a fill', () => {
    const lap = estimateLap({
      stops: [...stops, { location: 'shattered-planet', wait: 60 }],
      speed: 200,
    });
    // 2 x 4,100,000 km at 200 km/s plus 120 s waiting
    expect(lap?.minutes).toBeCloseTo(685.3, 1);
    expect(lap?.turnaround).toBeUndefined();
  });

  it('should turn back early and skip the wait there', () => {
    const lap = estimateLap({
      stops: [
        ...stops,
        {
          location: 'shattered-planet',
          wait: 60,
          fill: { collectors: 10, chunks: 2000 },
        },
      ],
      speed: 200,
    });
    // 2 x (100,000 + 894,427) km at 200 km/s plus 60 s at Aquilo
    expect(lap?.travel).toBeCloseTo(9944.27, 1);
    expect(lap?.wait).toEqual(60);
    expect(lap?.turnaround).toEqual({ km: 894427, full: true });
  });
});
