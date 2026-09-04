/**
 * Deterministic PRNG for the synthetic corpus.
 *
 * All *substantive* content (amounts, dates, vendors, planted discrepancies) is fixed
 * literal data in the fixture/model files below — it does not depend on randomness, so it
 * cannot drift between runs. The PRNG here is used only for cosmetic, non-load-bearing
 * variation (JPEG grain, skew jitter, handwriting-stroke wobble) so that "photo-like"
 * renders look organic without threatening reproducibility: given the same seed and the
 * same call sequence, every run produces byte-identical inputs to the renderer.
 */

/** mulberry32: small, fast, good-enough statistical quality for cosmetic jitter only. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Master seed for the whole synthetic corpus. Change only deliberately. */
export const MASTER_SEED = 0x5641_4c31; // "VAL1" — arbitrary, fixed.

/** Stable small integer hash of a string, used to derive a per-purpose sub-seed. */
export function seedFrom(label: string, base: number = MASTER_SEED): number {
  let h = base ^ 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

export interface Rng {
  next(): number;
  range(min: number, max: number): number;
  int(min: number, maxInclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  sign(): 1 | -1;
}

/** A named, independently-seeded RNG stream derived from the master seed. */
export function rngFor(label: string): Rng {
  const rand = mulberry32(seedFrom(label));
  return {
    next: rand,
    range(min: number, max: number) {
      return min + rand() * (max - min);
    },
    int(min: number, maxInclusive: number) {
      return min + Math.floor(rand() * (maxInclusive - min + 1));
    },
    pick<T>(arr: readonly T[]): T {
      const it = arr[Math.floor(rand() * arr.length)];
      if (it === undefined) throw new RangeError('pick from empty array');
      return it;
    },
    sign() {
      return rand() < 0.5 ? -1 : 1;
    },
  };
}
