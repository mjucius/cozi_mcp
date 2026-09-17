// Live round-trip for multi-day appointments (issue #8). Read/write against real Cozi;
// creates events in a far-future month and deletes them all at the end. Run with:
//   set -a && . creds.env && set +a && npx tsx scripts/smoke-multiday.ts

import { CoziClient } from '../src/cozi/index.js';
import {
  createAppointmentHandler,
  deleteAppointmentHandler,
  getCalendarHandler,
  updateAppointmentHandler,
} from '../src/tools/calendar.js';

const username = process.env.COZI_USERNAME;
const password = process.env.COZI_PASSWORD;
if (!username || !password) {
  process.stderr.write('Set COZI_USERNAME and COZI_PASSWORD env vars.\n');
  process.exit(1);
}

const log = (s: string) => process.stderr.write(`${s}\n`);
const client = new CoziClient(username, password);
await client.authenticate();
log('✓ authenticated');

const SUBJ = 'MULTIDAY_SMOKE_DELETE_ME';
const SUBJ_SINGLE = 'MULTIDAY_SMOKE_SINGLE_DELETE_ME';
const SUBJ_CROSS = 'MULTIDAY_SMOKE_CROSSMONTH_DELETE_ME';
const created: Array<{ id: string; year: number; month: number }> = [];

// Raw wire read, so we see dateSpan exactly as Cozi stored it.
async function raw(year: number, month: number, subject: string) {
  const c = client as unknown as {
    http: { request(o: unknown): Promise<unknown> };
    accountEndpoint(s: string): string;
  };
  const res = (await c.http.request({
    method: 'GET',
    endpoint: c.accountEndpoint(`/calendar/${year}/${month}`),
  })) as { items?: Record<string, Record<string, unknown>> };
  return Object.values(res.items ?? {}).find((i) => i.description === subject);
}

function check(label: string, ok: boolean, detail: string) {
  log(`${ok ? '✓' : '✗'} ${label} — ${detail}`);
  if (!ok) process.exitCode = 1;
}

try {
  // 1. create multi-day
  const a = await createAppointmentHandler(
    client, SUBJ, '2027-07-19T10:00:00', '2027-07-22T11:00:00', undefined, false, '', undefined,
  );
  created.push({ id: a.id, year: 2027, month: 7 });
  check('create multi-day: slim end_day', a.end_day === '2027-07-22', `end=${a.end} end_day=${a.end_day}`);
  let r = await raw(2027, 7, SUBJ);
  check('create multi-day: stored dateSpan=4', r?.dateSpan === 4, `dateSpan=${String(r?.dateSpan)} day=${String(r?.day)}`);
  check('create multi-day: stored day', r?.day === '2027-07-19', `day=${String(r?.day)}`);

  // 2. shrink via edit (full-replace edit must actually collapse the span)
  const shrunk = await updateAppointmentHandler(client, a.id, 2027, 7, { end: '2027-07-19T11:00:00' });
  check('shrink: slim drops end_day', shrunk.end_day === undefined, `end_day=${String(shrunk.end_day)}`);
  r = await raw(2027, 7, SUBJ);
  const span = r?.dateSpan;
  check('shrink: stored dateSpan collapsed', span === 1 || span === 0 || span === undefined, `dateSpan=${String(span)}`);

  // 3. grow via edit
  await updateAppointmentHandler(client, a.id, 2027, 7, { end: '2027-07-25T11:00:00' });
  r = await raw(2027, 7, SUBJ);
  check('grow: stored dateSpan=7', r?.dateSpan === 7, `dateSpan=${String(r?.dateSpan)}`);

  // 4. ordinary single-day create still round-trips (wire value is now 1, was 0)
  const s = await createAppointmentHandler(
    client, SUBJ_SINGLE, '2027-07-11T09:00:00', '2027-07-11T10:00:00', undefined, false, '', undefined,
  );
  created.push({ id: s.id, year: 2027, month: 7 });
  check('single-day: slim omits end_day', s.end_day === undefined, `end=${s.end}`);
  r = await raw(2027, 7, SUBJ_SINGLE);
  check('single-day: stored dateSpan<=1', (r?.dateSpan as number ?? 1) <= 1, `dateSpan=${String(r?.dateSpan)}`);
  check('single-day: times preserved', r?.startTime === '09:00:00' && r?.endTime === '10:00:00',
    `start=${String(r?.startTime)} end=${String(r?.endTime)}`);

  // 5. cross-month span appears in both months, keyed on the start day.
  //    Written with bare dates — the all-day shorthand — to prove that path end to end.
  const x = await createAppointmentHandler(
    client, SUBJ_CROSS, '2027-07-30', '2027-08-02', undefined, true, '', undefined,
  );
  created.push({ id: x.id, year: 2027, month: 7 });
  check('cross-month: slim end_day', x.end_day === '2027-08-02', `end_day=${String(x.end_day)}`);
  const inJul = await raw(2027, 7, SUBJ_CROSS);
  const inAug = await raw(2027, 8, SUBJ_CROSS);
  check('cross-month: in July page', inJul?.dateSpan === 4, `dateSpan=${String(inJul?.dateSpan)}`);
  check('cross-month: in August page with start day', inAug?.day === '2027-07-30',
    `day=${String(inAug?.day)} dateSpan=${String(inAug?.dateSpan)}`);
  check('cross-month: stored as all-day (00:00:00)',
    inJul?.startTime === '00:00:00' && inJul?.endTime === '00:00:00',
    `start=${String(inJul?.startTime)} end=${String(inJul?.endTime)}`);
  const readBack = (await getCalendarHandler(client, 2027, 8)).find((i) => i.subject === SUBJ_CROSS);
  check('cross-month: reads back as all_day with end_day',
    readBack?.all_day === true && readBack?.end_day === '2027-08-02',
    `all_day=${String(readBack?.all_day)} end_day=${String(readBack?.end_day)}`);
} finally {
  for (const c of created) {
    try {
      await deleteAppointmentHandler(client, c.id, c.year, c.month);
      log(`✓ cleaned up ${c.id}`);
    } catch (e) {
      log(`✗ FAILED TO CLEAN UP ${c.id}: ${String(e)}`);
      process.exitCode = 1;
    }
  }
}
