import { describe, expect, it } from 'vitest';
import { ItemStatus, ResourceNotFoundError } from '../src/cozi/index.js';
import {
  addItemHandler,
  removeItemsHandler,
  updateItemHandler,
} from '../src/tools/items.js';
import {
  createListHandler,
  deleteListHandler,
  getListItemsHandler,
  getListsHandler,
} from '../src/tools/lists.js';
import { familyMembersHandler } from '../src/tools/family.js';
import { makeItem, makeList, makePerson } from './helpers/factories.js';
import { asClient, makeMockClient } from './helpers/mock-client.js';

describe('family_members', () => {
  it('returns slim projection', async () => {
    const m = makeMockClient();
    m.getFamilyMembers.mockResolvedValue([
      makePerson({ id: 'p1', name: 'Alice', color: 3, email: 'alice@example.com' }),
      makePerson({ id: 'p2', name: 'Bob', color: null, email: 'bob@example.com' }),
    ]);
    const result = await familyMembersHandler(asClient(m));
    expect(result).toEqual([
      { id: 'p1', name: 'Alice', color: 3 },
      { id: 'p2', name: 'Bob' },
    ]);
    expect(m.getFamilyMembers).toHaveBeenCalledOnce();
    expect(m.getFamilyMembers).toHaveBeenCalledWith();
  });
});

describe('get_lists', () => {
  it('returns summaries, no items', async () => {
    const m = makeMockClient();
    m.getLists.mockResolvedValue([
      makeList({
        id: 'L1',
        title: 'Groceries',
        listType: 'shopping',
        items: [makeItem({ id: 'i1', status: 'incomplete' }), makeItem({ id: 'i2', status: 'complete' })],
      }),
    ]);
    const result = await getListsHandler(asClient(m));
    expect(result).toEqual([
      { id: 'L1', title: 'Groceries', type: 'shopping', item_count: 2, completed_count: 1 },
    ]);
    for (const summary of result) expect('items' in summary).toBe(false);
  });

  it('filters by type', async () => {
    const m = makeMockClient();
    m.getLists.mockResolvedValue([
      makeList({ id: 'L1', listType: 'shopping' }),
      makeList({ id: 'L2', title: 'Chores', listType: 'todo' }),
    ]);
    const shopping = await getListsHandler(asClient(m), 'shopping');
    expect(shopping.map((s) => s.id)).toEqual(['L1']);
    const todo = await getListsHandler(asClient(m), 'todo');
    expect(todo.map((s) => s.id)).toEqual(['L2']);
  });

  it('unknown type raises', async () => {
    const m = makeMockClient();
    m.getLists.mockResolvedValue([]);
    await expect(getListsHandler(asClient(m), 'grocery')).rejects.toThrow(/Unknown list_type/);
  });
});

describe('get_list_items', () => {
  it('default excludes completed', async () => {
    const m = makeMockClient();
    m.getLists.mockResolvedValue([
      makeList({
        id: 'L1',
        items: [
          makeItem({ id: 'a', status: 'incomplete' }),
          makeItem({ id: 'b', status: 'complete' }),
          makeItem({ id: 'c', status: 'incomplete' }),
        ],
      }),
    ]);
    const result = await getListItemsHandler(asClient(m), 'L1', false);
    expect(result.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('include_completed=true returns all', async () => {
    const m = makeMockClient();
    m.getLists.mockResolvedValue([
      makeList({
        id: 'L1',
        items: [makeItem({ id: 'a', status: 'incomplete' }), makeItem({ id: 'b', status: 'complete' })],
      }),
    ]);
    const result = await getListItemsHandler(asClient(m), 'L1', true);
    expect(result.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('unknown list raises ResourceNotFoundError', async () => {
    const m = makeMockClient();
    m.getLists.mockResolvedValue([makeList({ id: 'L1' })]);
    await expect(getListItemsHandler(asClient(m), 'nonexistent', false)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });
});

describe('create_list / delete_list', () => {
  it('create_list passes enum value, returns slim', async () => {
    const m = makeMockClient();
    m.createList.mockResolvedValue(makeList({ id: 'newL', title: 'Pantry', listType: 'shopping' }));
    const result = await createListHandler(asClient(m), 'Pantry', 'shopping');
    expect(result).toEqual({ id: 'newL', title: 'Pantry', type: 'shopping' });
    expect(m.createList).toHaveBeenCalledWith('Pantry', 'shopping');
  });

  it('delete_list returns boolean', async () => {
    const m = makeMockClient();
    m.deleteList.mockResolvedValue(true);
    expect(await deleteListHandler(asClient(m), 'L1')).toBe(true);
    expect(m.deleteList).toHaveBeenCalledOnce();
    expect(m.deleteList).toHaveBeenCalledWith('L1');
  });
});

describe('add_item', () => {
  it('returns slim {id, text}', async () => {
    const m = makeMockClient();
    m.addItem.mockResolvedValue(makeItem({ id: 'i_new', text: 'Eggs' }));
    const result = await addItemHandler(asClient(m), 'L1', 'Eggs', 0);
    expect(result).toEqual({ id: 'i_new', text: 'Eggs' });
    expect(m.addItem).toHaveBeenCalledWith('L1', 'Eggs', 0);
  });

  it('passes position through', async () => {
    const m = makeMockClient();
    m.addItem.mockResolvedValue(makeItem());
    await addItemHandler(asClient(m), 'L1', 'Eggs', 5);
    expect(m.addItem).toHaveBeenCalledWith('L1', 'Eggs', 5);
  });
});

describe('update_item (the merged tool)', () => {
  it('text only calls updateItemText', async () => {
    const m = makeMockClient();
    m.updateItemText.mockResolvedValue(makeItem({ id: 'item_1', text: 'new text', status: 'incomplete' }));
    const result = await updateItemHandler(asClient(m), 'L1', 'item_1', 'new text', undefined);
    expect(m.updateItemText).toHaveBeenCalledOnce();
    expect(m.updateItemText).toHaveBeenCalledWith('L1', 'item_1', 'new text');
    expect(m.markItem).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'item_1', text: 'new text', status: 'incomplete' });
  });

  it('completed only calls markItem', async () => {
    const m = makeMockClient();
    m.markItem.mockResolvedValue(makeItem({ id: 'item_1', text: 'Milk', status: 'complete' }));
    const result = await updateItemHandler(asClient(m), 'L1', 'item_1', undefined, true);
    expect(m.markItem).toHaveBeenCalledOnce();
    expect(m.markItem).toHaveBeenCalledWith('L1', 'item_1', ItemStatus.COMPLETE);
    expect(m.updateItemText).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'item_1', text: 'Milk', status: 'complete' });
  });

  it('both: text first then status, NOT atomic', async () => {
    const m = makeMockClient();
    m.updateItemText.mockResolvedValue(makeItem({ id: 'item_1', text: 'renamed', status: 'incomplete' }));
    m.markItem.mockResolvedValue(makeItem({ id: 'item_1', text: 'renamed', status: 'complete' }));
    const result = await updateItemHandler(asClient(m), 'L1', 'item_1', 'renamed', true);
    expect(m.updateItemText).toHaveBeenCalledWith('L1', 'item_1', 'renamed');
    expect(m.markItem).toHaveBeenCalledWith('L1', 'item_1', ItemStatus.COMPLETE);
    expect(result).toEqual({ id: 'item_1', text: 'renamed', status: 'complete' });
  });

  it('neither raises', async () => {
    const m = makeMockClient();
    await expect(updateItemHandler(asClient(m), 'L1', 'i1', undefined, undefined)).rejects.toThrow(
      /at least one of/,
    );
  });

  it('completed=false passes INCOMPLETE', async () => {
    const m = makeMockClient();
    m.markItem.mockResolvedValue(makeItem({ id: 'item_1', status: 'incomplete' }));
    await updateItemHandler(asClient(m), 'L1', 'item_1', undefined, false);
    expect(m.markItem).toHaveBeenCalledWith('L1', 'item_1', ItemStatus.INCOMPLETE);
  });
});

describe('remove_items', () => {
  it('passes through', async () => {
    const m = makeMockClient();
    m.removeItems.mockResolvedValue(true);
    const result = await removeItemsHandler(asClient(m), 'L1', ['a', 'b', 'c']);
    expect(result).toBe(true);
    expect(m.removeItems).toHaveBeenCalledWith('L1', ['a', 'b', 'c']);
  });
});
