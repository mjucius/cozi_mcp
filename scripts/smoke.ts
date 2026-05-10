// Smoke test against real Cozi API. Run with:
//   COZI_USERNAME=… COZI_PASSWORD=… npx tsx scripts/smoke.ts
// This file is gitignored.

import { CoziClient } from '../src/cozi/index.js';

const username = process.env.COZI_USERNAME;
const password = process.env.COZI_PASSWORD;

if (!username || !password) {
  process.stderr.write('Set COZI_USERNAME and COZI_PASSWORD env vars.\n');
  process.exit(1);
}

const client = new CoziClient(username, password);

console.error('→ authenticate()');
await client.authenticate();
console.error('  ✓ authenticated');

console.error('→ getFamilyMembers()');
const people = await client.getFamilyMembers();
console.error(`  ✓ ${people.length} members`);
for (const p of people) console.error(`    - ${p.name} (id=${p.id}, color=${p.color ?? '-'})`);

console.error('→ getLists()');
const lists = await client.getLists();
console.error(`  ✓ ${lists.length} lists`);
for (const l of lists) {
  const open = l.items.filter((i) => i.status === 'incomplete').length;
  const done = l.items.filter((i) => i.status === 'complete').length;
  console.error(`    - "${l.title}" (type=${l.listType}, ${open} open / ${done} done)`);
}

const now = new Date();
const year = now.getFullYear();
const month = now.getMonth() + 1;
console.error(`→ getCalendar(${year}, ${month})`);
const appts = await client.getCalendar(year, month);
console.error(`  ✓ ${appts.length} appointments`);
for (const a of appts.slice(0, 5)) {
  const time = a.startTime ? `${a.startTime.h}:${String(a.startTime.m).padStart(2, '0')}` : 'all-day';
  console.error(`    - ${a.startDay} ${time} "${a.subject}" (id=${a.id})`);
}
if (appts.length > 5) console.error(`    … and ${appts.length - 5} more`);

console.error('\nAll read paths green ✓');
