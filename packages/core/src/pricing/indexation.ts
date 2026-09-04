/**
 * Bringing a benchmark record or a prior-period price to the date of the line.
 *
 * A published index is not one series: it is a run of segments, each on its own base, and the
 * base changes (INE moved the IPC to `2025=100` with the January 2026 release). Comparing a
 * value from one base with a value from another is meaningless, so {@link chainIndex} first
 * re-expresses every segment on the base of the most recent one, and {@link indexFactor} then
 * divides two values from that single chained series.
 */

/** One observation of an index series. */
export interface IndexObservation {
  /** First day of the period, ISO `yyyy-mm-dd`. */
  period: string;
  value: number;
  /** Base label, e.g. `2021=100`. Observations with different labels are different segments. */
  base?: string;
}

/** Options for {@link chainIndex}. */
export interface ChainOptions {
  /**
   * Link factors by base label, for segments that do not overlap. The factor converts a value
   * on that base to the target (most recent) base: `valueOnTargetBase = value * factor`.
   */
  links?: Record<string, number>;
}

function baseKey(o: IndexObservation): string {
  return o.base ?? '';
}

function sortByPeriod(observations: readonly IndexObservation[]): IndexObservation[] {
  return [...observations].sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Split a series into segments of constant base, in period order. A base that reappears later
 * starts a new segment: the caller is expected to feed one continuous publication per base.
 */
export function indexSegments(observations: readonly IndexObservation[]): IndexObservation[][] {
  const sorted = sortByPeriod(observations);
  const segments: IndexObservation[][] = [];
  let current: IndexObservation[] = [];
  let currentBase: string | null = null;
  for (const obs of sorted) {
    const key = baseKey(obs);
    if (currentBase === null || key === currentBase) {
      currentBase = key;
      current.push(obs);
    } else {
      segments.push(current);
      current = [obs];
      currentBase = key;
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Re-express every segment of a series on the base of the most recent segment.
 *
 * Two consecutive segments are linked through a period they both publish; when they do not
 * overlap, the link factor for the older base must be supplied in `options.links`. Returns
 * null when a link is needed and missing, so the caller can say "not indexable" instead of
 * quoting a number that mixes bases.
 */
export function chainIndex(
  observations: readonly IndexObservation[],
  options: ChainOptions = {},
): IndexObservation[] | null {
  const segments = indexSegments(observations);
  if (segments.length === 0) return [];
  const targetBase = baseKey((segments[segments.length - 1] as IndexObservation[])[0]!);

  // factor that converts each segment onto the base of the next one, walked from the end
  const chained: IndexObservation[][] = [];
  let cumulative = 1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i] as IndexObservation[];
    if (i < segments.length - 1) {
      const next = segments[i + 1] as IndexObservation[];
      const link = linkFactor(segment, next, options.links);
      if (link === null) return null;
      cumulative *= link;
    }
    const factor = cumulative;
    chained.unshift(
      segment.map((o) => ({ period: o.period, value: o.value * factor, base: targetBase })),
    );
  }
  return chained.flat();
}

/** Factor that converts a value on `older`'s base to `newer`'s base. */
function linkFactor(
  older: readonly IndexObservation[],
  newer: readonly IndexObservation[],
  links: Record<string, number> | undefined,
): number | null {
  const newerByPeriod = new Map(newer.map((o) => [o.period, o.value]));
  for (let i = older.length - 1; i >= 0; i--) {
    const obs = older[i] as IndexObservation;
    const overlap = newerByPeriod.get(obs.period);
    if (overlap !== undefined && obs.value !== 0) return overlap / obs.value;
  }
  const explicit = links?.[baseKey(older[0] as IndexObservation)];
  return typeof explicit === 'number' && Number.isFinite(explicit) ? explicit : null;
}

/** Latest observation on or before `date`. */
export function observationAt(
  observations: readonly IndexObservation[],
  date: string,
): IndexObservation | undefined {
  let best: IndexObservation | undefined;
  for (const obs of observations) {
    if (obs.period > date) continue;
    if (!best || obs.period > best.period) best = obs;
  }
  return best;
}

/**
 * Multiplier that brings a figure from `fromDate` to `toDate` on a published index.
 *
 * The series is chained onto its most recent base first, so a base change between the two
 * dates is handled. Returns null when either end has no observation on or before its date, or
 * when the segments cannot be chained — the caller then reports "not indexable" rather than a
 * factor of 1.
 */
export function indexFactor(
  series: readonly IndexObservation[],
  fromDate: string,
  toDate: string,
  options: ChainOptions = {},
): number | null {
  const chained = chainIndex(series, options);
  if (chained === null || chained.length === 0) return null;
  const from = observationAt(chained, fromDate);
  const to = observationAt(chained, toDate);
  if (!from || !to || from.value === 0) return null;
  return to.value / from.value;
}

/**
 * Variation between two dates as a fraction (`0.042` = +4.2%), or null when the series cannot
 * answer. Convenience wrapper over {@link indexFactor} for the HISTORY layer, whose band is
 * ±(variation + 3 points).
 */
export function indexVariation(
  series: readonly IndexObservation[],
  fromDate: string,
  toDate: string,
  options: ChainOptions = {},
): number | null {
  const factor = indexFactor(series, fromDate, toDate, options);
  return factor === null ? null : factor - 1;
}
