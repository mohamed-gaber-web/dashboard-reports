/// <reference lib="webworker" />

import {
  AggregatePlan,
  CONCURRENCY,
  Cube,
  GroupTotal,
  MeasureTotal,
  PAGE_SIZE,
  WorkerRequest,
  WorkerResponse,
} from './aggregate-plan.model';

/**
 * The streaming fold.
 *
 * Runs off the main thread for two reasons, both measured: a 10,000-row page is
 * ~1 MB of JSON even with a narrow `$select`, and `JSON.parse` of that many pages
 * on the main thread would be seconds of jank; and the fold itself is a tight loop
 * over millions of objects.
 *
 * The invariant that makes this safe at scale: **a page is folded and then
 * dropped.** `rows` never escapes `foldPage`, and nothing accumulates them. Peak
 * memory is CONCURRENCY pages plus the cube.
 *
 * It uses `fetch` rather than Angular's HttpClient — a worker has no DI, and
 * routing 1,100 pages back through the main thread would reintroduce the jank
 * this exists to avoid. It still goes to the same-origin `dataPath`, so the dev
 * proxy / Vercel rewrite (and their Origin-stripping) apply exactly as before.
 * The bearer is minted on the main thread and passed in; the worker never speaks
 * to Azure AD.
 */

let cancelled = false;

addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (data.type === 'run') {
    cancelled = false;
    run(data.plan).catch((e: unknown) =>
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
  }
});

function post(msg: WorkerResponse): void {
  postMessage(msg);
}

async function run(plan: AggregatePlan): Promise<void> {
  const dateDimensions = plan.dateDimensions ?? [];

  const cube: Cube = {
    filter: plan.filter,
    builtAt: Date.now(),
    rowsFolded: 0,
    totalRows: plan.totalRows,
    totals: Object.fromEntries(plan.measures.map((m) => [m, { sum: 0, count: 0 } as MeasureTotal])),
    dims: Object.fromEntries(
      [...plan.dimensions, ...dateDimensions].map((d) => [d, {} as Record<string, GroupTotal>]),
    ),
  };

  // Only the columns the fold actually reads, plus the sort key. This is the
  // difference between ~1 MB and ~7.5 MB per page — measured — and it is why a
  // 250k-row slice costs ~25 MB rather than ~190 MB.
  const select = [
    ...new Set([...plan.keyField, ...plan.dimensions, ...dateDimensions, ...plan.measures]),
  ].join(',');

  const pageCount = Math.ceil(plan.totalRows / PAGE_SIZE);
  const skips = Array.from({ length: pageCount }, (_, i) => i * PAGE_SIZE);

  // Deep $skip costs the same as a shallow one here, so pages are independent
  // and fetched concurrently. A worker pool keeps CONCURRENCY requests in flight
  // without materialising every promise at once.
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, skips.length) }, async () => {
    while (!cancelled) {
      const i = next++;
      if (i >= skips.length) return;

      const rows = await fetchPage(plan, select, skips[i]);
      if (cancelled) return;

      foldPage(rows, plan, cube); // rows are consumed here and never referenced again
      cube.rowsFolded += rows.length;
      post({ type: 'progress', loaded: cube.rowsFolded, total: plan.totalRows });
    }
  });

  await Promise.all(workers);

  cube.builtAt = Date.now();
  post({ type: 'done', cube });
}

async function fetchPage(
  plan: AggregatePlan,
  select: string,
  skip: number,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    $filter: plan.filter,
    $select: select,
    $top: String(PAGE_SIZE),
    $skip: String(skip),
    // A stable TOTAL order is required for $skip to partition the set cleanly —
    // without it the server may return overlapping or missing rows across pages.
    $orderby: plan.keyField.map((k) => `${k} asc`).join(','),
  });
  if (plan.crossCompany) params.set('cross-company', 'true');

  const res = await fetch(`${plan.dataPath}/${plan.entity}?${params}`, {
    headers: { Authorization: `Bearer ${plan.token}`, Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`D365 returned ${res.status} at row ${skip}: ${await res.text()}`);
  }

  const body = (await res.json()) as { value?: Record<string, unknown>[] };
  return body.value ?? [];
}

/** Fold one page into the cube, then let it be garbage-collected. */
function foldPage(rows: Record<string, unknown>[], plan: AggregatePlan, cube: Cube): void {
  const dateDimensions = plan.dateDimensions ?? [];

  for (const row of rows) {
    for (const m of plan.measures) {
      const v = toNumber(row[m]);
      if (v !== null) {
        const t = cube.totals[m];
        t.sum += v;
        t.count += 1;
      }
    }

    for (const d of plan.dimensions) {
      accumulate(cube.dims[d], String(row[d] ?? '').trim() || '—', row, plan);
    }

    for (const d of dateDimensions) {
      const key = dayKey(row[d]);
      // No date, or D365's "unset" sentinel. Skipped rather than bucketed: a
      // 1900 spike at the head of a trend line is a worse lie than a gap.
      if (key) accumulate(cube.dims[d], key, row, plan);
    }
  }
}

/** Add one row to `bucket[key]`, creating the group's accumulators on first sight. */
function accumulate(
  bucket: Record<string, GroupTotal>,
  key: string,
  row: Record<string, unknown>,
  plan: AggregatePlan,
): void {
  let g = bucket[key];
  if (!g) {
    g = { count: 0, sums: Object.fromEntries(plan.measures.map((m) => [m, 0])) };
    bucket[key] = g;
  }
  g.count += 1;
  for (const m of plan.measures) {
    const v = toNumber(row[m]);
    if (v !== null) g.sums[m] += v;
  }
}

/**
 * The calendar day a D365 date value falls on, as `YYYY-MM-DD`.
 *
 * The values arrive as ISO strings (`2016-12-30T12:00:00Z`), so the first ten
 * characters ARE the UTC day — no Date parsing, which matters in a loop that
 * runs once per row per date field over up to 250,000 rows.
 */
function dayKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10) return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return day.slice(0, 4) <= '1900' ? null : day;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
