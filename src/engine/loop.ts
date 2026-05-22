export type TickFn = (dt: number) => void;
export type RenderFn = (alpha: number) => void;

export function stepAccumulator(elapsedMs: number, stepMs: number, tick: TickFn, maxTicks = 8): number {
  let acc = elapsedMs;
  let n = 0;
  while (acc >= stepMs && n < maxTicks) {
    tick(stepMs / 1000);
    acc -= stepMs;
    n++;
  }
  if (n === maxTicks) return 0;
  return acc;
}

export function startLoop(tick: TickFn, render: RenderFn, hz = 60) {
  const stepMs = 1000 / hz;
  let last = performance.now();
  let acc = 0;
  const frame = (now: number) => {
    const elapsed = Math.min(250, now - last);
    last = now;
    acc = stepAccumulator(acc + elapsed, stepMs, tick);
    render(acc / stepMs);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
