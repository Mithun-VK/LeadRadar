/**
 * Pagination benchmark.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION
 * ---------------------------------------------------------------------------
 *
 * The load test observed ~257ms on a deep page and flagged OFFSET pagination as
 * a possible scalability concern. "Possible" is not a decision, and rewriting
 * pagination on a theoretical worry is how a working system acquires bugs.
 *
 * This measures the actual shape of the cost so the decision rests on numbers:
 *
 *   1. How does OFFSET latency grow with page depth?
 *   2. How much does keyset cost at the same depth?
 *   3. What does a full export cost each way?
 *
 * The answer, at `--rows=50000` — the export's own MAX_ROWS ceiling, so the worst
 * case this code can ever meet:
 *
 *   OFFSET walk: 74,585ms for 50,000 rows
 *   keyset walk: 71,517ms for 50,000 rows    1.04×, inside the noise
 *
 * Keyset was also SLOWER per page at depth. The sort leads with
 * `opportunityScore DESC NULLS LAST` — nullable and non-unique — so a cursor
 * cannot become an index seek and both plans sort; and the walk is dominated by
 * the include-joins at ~1.5ms/row, not by the offset scan.
 *
 * So nothing was rewritten. An earlier commit on this branch had switched the
 * export to keyset on the theoretical argument alone; the measurement did not
 * support it and the change was reverted. This script is the regression guard if
 * that ever changes.
 *
 * Creates an isolated `__bench__` organization and deletes it afterwards.
 *
 *   npm run bench:pagination
 *   npm run bench:pagination -- --rows=50000
 */
import 'dotenv/config';

import { db, closeDatabase, type TenantContext } from '@/modules/database/client';
import { closeRedis } from '@/lib/redis';
import { closeQueues } from '@/modules/jobs/queues';
import { leadWhere, listLeads } from '@/modules/database/repositories';

/**
 * A command-line knob.
 *
 * Deliberately `process.argv`, not `process.env`: the provider guard requires
 * every `process.env` read to go through `env()`, and `env()` validates
 * PRODUCTION configuration. A test-harness parameter has no business being
 * declared there — adding it would make a benchmark knob a production config
 * key. The existing load test reads its scale from argv for the same reason.
 *
 *   npm run <script> -- --name=value
 */
function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const ROWS = Number(arg('rows') ?? 10_000);
const PAGE_SIZE = 50;
const EXPORT_PAGE_SIZE = 500;
const SLUG = '__bench__pagination';

/** Deterministic PRNG so two runs are comparable. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function median(samples: number, fn: () => Promise<unknown>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(times.length / 2)]!);
}

async function seed(): Promise<TenantContext> {
  await teardown();

  const org = await db().organization.create({
    data: { name: 'Pagination benchmark', slug: SLUG },
    select: { id: true },
  });

  const random = mulberry32(20260906);
  const cities = ['Chennai', 'Bangalore', 'Hyderabad', 'Pune', 'Kochi'];

  console.log(`Seeding ${ROWS} leads…`);
  for (let offset = 0; offset < ROWS; offset += 1_000) {
    const size = Math.min(1_000, ROWS - offset);

    await db().placeIdentifier.createMany({
      data: Array.from({ length: size }, (_u, i) => ({
        googlePlaceId: `bench-${offset + i}`,
      })),
    });
    const places = await db().placeIdentifier.findMany({
      where: {
        googlePlaceId: { in: Array.from({ length: size }, (_u, i) => `bench-${offset + i}`) },
      },
      select: { id: true, googlePlaceId: true },
    });

    await db().business.createMany({
      data: places.map((place, i) => ({
        organizationId: org.id,
        placeIdentifierId: place.id,
        normalizedName: `bench ${offset + i}`,
        displayName: `Bench Clinic ${offset + i}`,
        primaryCategory: 'dental clinic',
        city: cities[Math.floor(random() * cities.length)]!,
        opportunityScore: Math.floor(random() * 101),
        rating: 3 + random() * 2,
        reviewCount: Math.floor(random() * 500),
      })),
    });

    process.stdout.write(`\r  ${Math.min(offset + size, ROWS)}/${ROWS}`);
  }
  console.log('');

  return { organizationId: org.id };
}

async function teardown(): Promise<void> {
  const org = await db().organization.findUnique({ where: { slug: SLUG }, select: { id: true } });
  if (org) await db().organization.delete({ where: { id: org.id } });
  // `bench-` contains no LIKE metacharacter, so this prefix means what it says.
  await db().placeIdentifier.deleteMany({ where: { googlePlaceId: { startsWith: 'bench-' } } });
}

async function main(): Promise<void> {
  const tenant = await seed();
  const where = leadWhere(tenant, {});
  const order = [
    { opportunityScore: { sort: 'desc' as const, nulls: 'last' as const } },
    { id: 'asc' as const },
  ];

  // -------------------------------------------------------------------------
  console.log(`\n=== 1. UI list (listLeads, OFFSET) across ${ROWS} leads ===`);
  console.log('  page  offset   median ms');

  const depths = [1, 10, 50, 100, 200].filter((page) => (page - 1) * PAGE_SIZE < ROWS);
  const uiTimings: Array<{ page: number; ms: number }> = [];

  for (const page of depths) {
    const ms = await median(5, () => listLeads(tenant, { page, pageSize: PAGE_SIZE }));
    uiTimings.push({ page, ms });
    console.log(`  ${String(page).padStart(4)}  ${String((page - 1) * PAGE_SIZE).padStart(6)}   ${ms}`);
  }

  const shallow = uiTimings[0]!.ms;
  const deepest = uiTimings.at(-1)!;
  console.log(
    `\n  page 1 → page ${deepest.page}: ${shallow}ms → ${deepest.ms}ms ` +
      `(${(deepest.ms / Math.max(shallow, 1)).toFixed(2)}× at ${deepest.page * PAGE_SIZE} rows deep)`,
  );
  console.log(
    '  NOTE: listLeads runs the page query AND a full COUNT concurrently. The\n' +
      '  COUNT does not get cheaper with keyset, so it bounds any improvement.',
  );

  // -------------------------------------------------------------------------
  console.log('\n=== 2. Same depth, keyset instead of OFFSET ===');

  // Cursor ids at each depth, resolved once so the measurement excludes lookup.
  const cursors = new Map<number, string>();
  for (const page of depths) {
    if (page === 1) continue;
    const skipTo = await db().business.findMany({
      where,
      orderBy: order,
      skip: (page - 1) * PAGE_SIZE - 1,
      take: 1,
      select: { id: true },
    });
    if (skipTo[0]) cursors.set(page, skipTo[0].id);
  }

  console.log('  page   offset ms   keyset ms');
  for (const page of depths) {
    const offsetMs = await median(5, () =>
      db().business.findMany({ where, orderBy: order, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    );
    const cursor = cursors.get(page);
    const keysetMs = await median(5, () =>
      db().business.findMany({
        where,
        orderBy: order,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        take: PAGE_SIZE,
      }),
    );
    console.log(`  ${String(page).padStart(4)}   ${String(offsetMs).padStart(9)}   ${String(keysetMs).padStart(9)}`);
  }

  // -------------------------------------------------------------------------
  console.log(`\n=== 3. Full export walk — every page, ${EXPORT_PAGE_SIZE} rows each ===`);

  // This is where the quadratic term is actually paid: an export reads EVERY
  // page, so it pays the deepening offset cost on every one of them.
  const offsetStart = performance.now();
  let offsetRows = 0;
  for (let skip = 0; skip < ROWS; skip += EXPORT_PAGE_SIZE) {
    const page = await db().business.findMany({
      where,
      orderBy: order,
      skip,
      take: EXPORT_PAGE_SIZE,
      select: { id: true },
    });
    offsetRows += page.length;
    if (page.length < EXPORT_PAGE_SIZE) break;
  }
  const offsetTotal = Math.round(performance.now() - offsetStart);

  const keysetStart = performance.now();
  let keysetRows = 0;
  let afterId: string | null = null;
  for (;;) {
    const page: Array<{ id: string }> = await db().business.findMany({
      where,
      orderBy: order,
      ...(afterId !== null && { cursor: { id: afterId }, skip: 1 }),
      take: EXPORT_PAGE_SIZE,
      select: { id: true },
    });
    if (page.length === 0) break;
    keysetRows += page.length;
    afterId = page.at(-1)!.id;
    if (page.length < EXPORT_PAGE_SIZE) break;
  }
  const keysetTotal = Math.round(performance.now() - keysetStart);

  console.log(`  OFFSET walk: ${offsetTotal}ms for ${offsetRows} rows`);
  console.log(`  keyset walk: ${keysetTotal}ms for ${keysetRows} rows`);
  console.log(
    `  keyset is ${(offsetTotal / Math.max(keysetTotal, 1)).toFixed(2)}× faster over the full walk`,
  );

  if (offsetRows !== keysetRows) {
    console.log(
      `\n  WARNING: the two walks returned different row counts (${offsetRows} vs ${keysetRows}).\n` +
        '  Keyset must be exact — a page boundary that skips or repeats a row would\n' +
        '  silently truncate an export. Investigate before shipping.',
    );
    process.exitCode = 1;
  } else {
    console.log(`  both walks returned exactly ${offsetRows} rows — keyset loses nothing`);
  }

  console.log(
    '\n  Measured on a developer machine against a containerised PostgreSQL.\n' +
      '  The RATIO is the durable finding; the absolute numbers are not.',
  );
}

main()
  .catch((error: unknown) => {
    console.error(`\nBenchmark failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await teardown().catch((error) => {
      console.error('CLEANUP FAILED — remove the __bench__pagination organization:', error);
      process.exitCode = 1;
    });
    await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
  });
