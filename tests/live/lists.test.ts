// Live conformance: list / item create, update, delete against the REAL Cozi API.
// Uses its own throwaway lists only; every check is a fresh `GET /list/` read-back.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ResourceNotFoundError } from '../../src/cozi/index.js';
import { familyMembersHandler } from '../../src/tools/family.js';
import { addItemHandler, removeItemsHandler, updateItemHandler } from '../../src/tools/items.js';
import {
  createListHandler,
  deleteListHandler,
  getListItemsHandler,
  getListsHandler,
} from '../../src/tools/lists.js';
import { Live, MARK, haveCreds } from './harness.js';

describe.skipIf(!haveCreds)('live list conformance', () => {
  const live = haveCreds ? new Live() : (null as unknown as Live);
  const createdListIds: string[] = [];

  const listTitle = (label: string) => `${MARK} ${label}`;

  async function rawList(listId: string) {
    return (await live.client.getLists()).find((l) => l.id === listId);
  }

  beforeAll(async () => {
    await live.authenticate();
    // Sweep leftovers from an aborted run.
    for (const l of await live.client.getLists()) {
      if (l.id && l.title.startsWith(MARK)) await live.client.deleteList(l.id);
    }
  });

  afterAll(async () => {
    const failures: string[] = [];
    for (const id of createdListIds.splice(0)) {
      try {
        await live.client.deleteList(id);
      } catch (e) {
        failures.push(`${id}: ${String(e)}`);
      }
    }
    const leftovers = (await live.client.getLists()).filter((l) => l.title.startsWith(MARK));
    for (const l of leftovers) if (l.id) await live.client.deleteList(l.id);
    if (failures.length || leftovers.length) {
      throw new Error(`live list teardown incomplete: ${failures.join('; ')} (${leftovers.length} leftover(s) swept)`);
    }
  });

  it('family_members returns ids usable as attendees', async () => {
    const members = await familyMembersHandler(live.client);
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) expect(m.id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('create_list persists with the right type and is visible in get_lists', async () => {
    for (const type of ['shopping', 'todo'] as const) {
      const created = await createListHandler(live.client, listTitle(`create ${type}`), type);
      createdListIds.push(created.id);
      expect(created.id).toBeTruthy();
      expect(created.type).toBe(type);
      const raw = await rawList(created.id);
      expect(raw?.title).toBe(listTitle(`create ${type}`));
      expect(raw?.listType).toBe(type);
      expect(raw?.items).toEqual([]);
      const summary = (await getListsHandler(live.client, type)).find((l) => l.id === created.id);
      expect(summary).toMatchObject({ id: created.id, title: listTitle(`create ${type}`), type, item_count: 0 });
    }
  });

  it('add / update text / mark complete / mark incomplete / remove, each verified by a fresh read', async () => {
    const list = await createListHandler(live.client, listTitle('items'), 'todo');
    createdListIds.push(list.id);

    const a = await addItemHandler(live.client, list.id, 'first item', 0);
    const b = await addItemHandler(live.client, list.id, 'second item', 1);
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
    let items = (await rawList(list.id))!.items;
    expect(items.map((i) => [i.id, i.text, i.status])).toEqual([
      [a.id, 'first item', 'incomplete'],
      [b.id, 'second item', 'incomplete'],
    ]);

    const renamed = await updateItemHandler(live.client, list.id, a.id, 'first item (renamed)', undefined);
    expect(renamed).toEqual({ id: a.id, text: 'first item (renamed)', status: 'incomplete' });
    items = (await rawList(list.id))!.items;
    expect(items.find((i) => i.id === a.id)?.text).toBe('first item (renamed)');
    expect(items.find((i) => i.id === b.id)?.text).toBe('second item');

    const done = await updateItemHandler(live.client, list.id, b.id, undefined, true);
    expect(done).toEqual({ id: b.id, text: 'second item', status: 'complete' });
    expect((await rawList(list.id))!.items.find((i) => i.id === b.id)?.status).toBe('complete');
    // get_list_items filters completed items by default and includes them on request.
    expect((await getListItemsHandler(live.client, list.id, false)).map((i) => i.id)).toEqual([a.id]);
    expect((await getListItemsHandler(live.client, list.id, true)).map((i) => i.id).sort()).toEqual([a.id, b.id].sort());

    const undone = await updateItemHandler(live.client, list.id, b.id, undefined, false);
    expect(undone.status).toBe('incomplete');
    expect((await rawList(list.id))!.items.find((i) => i.id === b.id)?.status).toBe('incomplete');

    // Text and status in one call: two sequential writes, both must land.
    const both = await updateItemHandler(live.client, list.id, b.id, 'second item (renamed)', true);
    expect(both).toEqual({ id: b.id, text: 'second item (renamed)', status: 'complete' });
    const rawB = (await rawList(list.id))!.items.find((i) => i.id === b.id);
    expect([rawB?.text, rawB?.status]).toEqual(['second item (renamed)', 'complete']);

    expect(await removeItemsHandler(live.client, list.id, [a.id])).toBe(true);
    expect((await rawList(list.id))!.items.map((i) => i.id)).toEqual([b.id]);
    expect(await removeItemsHandler(live.client, list.id, [b.id])).toBe(true);
    expect((await rawList(list.id))!.items).toEqual([]);
  });

  it('updating an item id that does not exist raises and leaves no phantom behind', async () => {
    const list = await createListHandler(live.client, listTitle('phantom'), 'shopping');
    createdListIds.push(list.id);
    await expect(
      updateItemHandler(live.client, list.id, 'no-such-item-id', 'ghost', undefined),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect((await rawList(list.id))!.items).toEqual([]);
  });

  it('get_list_items on an unknown list raises', async () => {
    await expect(getListItemsHandler(live.client, 'no-such-list-id', true)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it('delete_list removes the list from get_lists', async () => {
    const list = await createListHandler(live.client, listTitle('delete'), 'todo');
    await addItemHandler(live.client, list.id, 'doomed', 0);
    expect(await deleteListHandler(live.client, list.id)).toBe(true);
    expect(await rawList(list.id)).toBeUndefined();
  });
});
