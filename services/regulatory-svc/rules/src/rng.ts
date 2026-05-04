// Deterministic seeded PRNG (mulberry32). Same seed → same draws across runs.
// Used by gen_history and the simulator to ensure reproducibility.

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Uniform float in [a, b). */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Standard normal via Box-Muller. */
  normal(mean = 0, std = 1): number {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + std * z;
  }
  /** Bernoulli — true with probability p. */
  bernoulli(p: number): boolean {
    return this.next() < p;
  }
}
