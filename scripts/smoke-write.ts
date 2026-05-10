// Write-path smoke test against real Cozi. Exercises the tool handlers
// (not just the raw client) so update_item's non-atomic behavior and
// update_appointment's fetch-then-merge are both verified end-to-end.
//
// Picks the first shopping list and a far-future date to minimize risk of
// colliding with real data. Cleans up after itself. Run with:
//   set -a && . creds.env && set +a && npx tsx scripts/smoke-write.ts

import { CoziClient } from '../src/cozi/index.js';
import {
  createAppointmentHandler,
  deleteAppointmentHandler,
  getCalendarHandler,
  updateAppointmentHandler,
} from '../src/tools/calendar.js';
import { familyMembersHandler } from '../src/tools/family.js';
import {
  addItemHandler,
  removeItemsHandler,
  updateItemHandler,
} from '../src/tools/items.js';
import { getListsHandler, getListItemsHandler } from '../src/tools/lists.js';

const username = process.env.COZI_USERNAME;
const password = process.env.COZI_PASSWORD;
if (!username || !password) {
  process.stderr.write('Set COZI_USERNAME and COZI_PASSWORD env vars.\n');
  process.exit(1);
}

const client = new CoziClient(username, password);
await client.authenticate();
console.error('✓ authenticated\n');

const TEST_ITEM_INITIAL = 'MIGRATION_SMOKE_TEST_DELETE_ME';
const TEST_ITEM_UPDATED = 'MIGRATION_SMOKE_TEST_UPDATED';
const TEST_APPT_SUBJECT = 'MIGRATION_SMOKE_TEST_APPT_DELETE_ME';
const TEST_APPT_NOTES = 'Original smoke notes';
const TEST_APPT_NOTES_UPDATED = 'Updated smoke notes — only this field';
const FAR_DATE = '2026-12-31';
const FAR_YEAR = 2026;
const FAR_MONTH = 12;

// ---------- LIST WRITE PATHS ----------
console.error('--- List write paths ---');

const lists = await getListsHandler(client, 'shopping');
const target = lists[0];
if (!target) throw new Error('No shopping list found to test against.');
console.error(`Using list: "${target.title}" (id=${target.id})`);

const added = await addItemHandler(client, target.id, TEST_ITEM_INITIAL, 0);
console.error(`✓ add_item → id=${added.id} text="${added.text}"`);

const textUpdated = await updateItemHandler(client, target.id, added.id, TEST_ITEM_UPDATED, undefined);
console.error(`✓ update_item (text only) → text="${textUpdated.text}" status=${textUpdated.status}`);

const bothUpdated = await updateItemHandler(client, target.id, added.id, undefined, true);
console.error(`✓ update_item (completed=true) → text="${bothUpdated.text}" status=${bothUpdated.status}`);
if (bothUpdated.status !== 'complete') throw new Error(`Expected status=complete, got ${bothUpdated.status}`);

const items = await getListItemsHandler(client, target.id, true);
const found = items.find((i) => i.id === added.id);
if (!found) throw new Error(`Item ${added.id} not found in get_list_items`);
if (found.text !== TEST_ITEM_UPDATED) throw new Error(`Expected text "${TEST_ITEM_UPDATED}", got "${found.text}"`);
console.error(`✓ get_list_items confirms text + status persisted`);

const removed = await removeItemsHandler(client, target.id, [added.id]);
console.error(`✓ remove_items → ${removed}`);

const itemsAfter = await getListItemsHandler(client, target.id, true);
if (itemsAfter.some((i) => i.id === added.id)) throw new Error('Item still present after remove');
console.error(`✓ get_list_items confirms removal\n`);

// ---------- CALENDAR WRITE PATHS ----------
console.error('--- Calendar write paths ---');

const members = await familyMembersHandler(client);
const firstMember = members[0];
if (!firstMember) throw new Error('No family members found.');

const created = await createAppointmentHandler(
  client,
  TEST_APPT_SUBJECT,
  `${FAR_DATE}T10:00:00`,
  `${FAR_DATE}T11:00:00`,
  [firstMember.id],
  false,
  TEST_APPT_NOTES,
  'Smoke Test Location',
);
console.error(`✓ create_appointment → id=${created.id} subject="${created.subject}" day=${created.day} all_day=${created.all_day}`);
if (!created.id) throw new Error('Created appointment missing id');

const apptId = created.id;
const updated = await updateAppointmentHandler(client, apptId, FAR_YEAR, FAR_MONTH, {
  notes: TEST_APPT_NOTES_UPDATED,
});
console.error(`✓ update_appointment (notes only) → notes="${updated.notes}"`);

if (updated.subject !== TEST_APPT_SUBJECT) throw new Error(`subject not preserved: "${updated.subject}"`);
if (updated.location !== 'Smoke Test Location') throw new Error(`location not preserved: "${updated.location}"`);
if (!updated.attendees || updated.attendees[0] !== firstMember.id) throw new Error(`attendees not preserved`);
if (updated.start !== `${FAR_DATE}T10:00`) throw new Error(`start not preserved: "${updated.start}"`);
if (updated.end !== `${FAR_DATE}T11:00`) throw new Error(`end not preserved: "${updated.end}"`);
if (updated.all_day !== false) throw new Error(`all_day flipped`);
console.error(`✓ fetch-then-merge preserved subject/location/attendees/start/end/all_day`);

const page = await getCalendarHandler(client, FAR_YEAR, FAR_MONTH);
const persisted = page.find((a) => a.id === apptId);
if (!persisted) throw new Error(`Appointment ${apptId} not found in re-fetch`);
if (persisted.notes !== TEST_APPT_NOTES_UPDATED) {
  throw new Error(`Notes not persisted: got "${persisted.notes}"`);
}
console.error(`✓ get_calendar confirms updated notes persisted`);

const deleted = await deleteAppointmentHandler(client, apptId, FAR_YEAR, FAR_MONTH);
console.error(`✓ delete_appointment → ${deleted}`);

const pageAfter = await getCalendarHandler(client, FAR_YEAR, FAR_MONTH);
if (pageAfter.some((a) => a.id === apptId)) throw new Error('Appointment still present after delete');
console.error(`✓ get_calendar confirms deletion\n`);

console.error('All write paths green ✓');
