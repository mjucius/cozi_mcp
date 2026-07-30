import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CoziClient, type CoziItem, ItemStatus } from '../cozi/index.js';
import { ID_RE } from '../cozi/client.js';
import { toolResult } from './untrusted.js';
import type { ToolAccessMode } from './index.js';

export async function addItemHandler(
  client: CoziClient,
  listId: string,
  text: string,
  position: number,
): Promise<{ id: string; text: string }> {
  const item = await client.addItem(listId, text, position);
  return { id: item.id ?? '', text: item.text };
}

export async function updateItemHandler(
  client: CoziClient,
  listId: string,
  itemId: string,
  text?: string,
  completed?: boolean,
): Promise<{ id: string; text: string; status: string }> {
  if (text === undefined && completed === undefined) {
    throw new Error('Must provide at least one of `text` or `completed`');
  }
  let item: CoziItem | null = null;
  if (text !== undefined) {
    item = await client.updateItemText(listId, itemId, text);
  }
  if (completed !== undefined) {
    const status = completed ? ItemStatus.COMPLETE : ItemStatus.INCOMPLETE;
    item = await client.markItem(listId, itemId, status);
  }
  if (!item) throw new Error('Update produced no result');
  return { id: item.id ?? '', text: item.text, status: item.status };
}

export async function removeItemsHandler(
  client: CoziClient,
  listId: string,
  itemIds: string[],
): Promise<boolean> {
  return client.removeItems(listId, itemIds);
}

export function registerItemTools(
  server: McpServer,
  getClient: () => Promise<CoziClient>,
  accessMode: ToolAccessMode = 'read-write',
): void {
  // Every item tool is a write — unlike lists.ts/calendar.ts there is no
  // read-only-safe tool to register first, so the gate is the whole function.
  if (accessMode === 'read-only') {
    return;
  }

  server.registerTool(
    'add_item',
    {
      title: 'Add an item to a list',
      description: 'Add an item to a list. Returns: {id, text}.',
      inputSchema: {
        list_id: z.string().regex(ID_RE, 'Invalid id format'),
        text: z.string(),
        position: z.number().int().optional(),
      },
    },
    async ({ list_id, text, position }) => {
      const result = await addItemHandler(await getClient(), list_id, text, position ?? 0);
      return toolResult(result);
    },
  );

  server.registerTool(
    'update_item',
    {
      title: "Update an item's text and/or completion",
      description:
        "Update an item's text and/or completion status. Pass `text`, `completed`, or both. " +
        'When both are provided the text is updated first then status is updated as a separate ' +
        'request — these are NOT atomic. Returns: {id, text, status}.',
      inputSchema: {
        list_id: z.string().regex(ID_RE, 'Invalid id format'),
        item_id: z.string().regex(ID_RE, 'Invalid id format'),
        text: z.string().optional(),
        completed: z.boolean().optional(),
      },
    },
    async ({ list_id, item_id, text, completed }) => {
      const result = await updateItemHandler(await getClient(), list_id, item_id, text, completed);
      return toolResult(result);
    },
  );

  server.registerTool(
    'remove_items',
    {
      title: 'Remove items from a list',
      description: 'Remove items from a list. Returns true on success.',
      inputSchema: {
        list_id: z.string().regex(ID_RE, 'Invalid id format'),
        item_ids: z.array(z.string().regex(ID_RE, 'Invalid id format')),
      },
    },
    async ({ list_id, item_ids }) => {
      const result = await removeItemsHandler(await getClient(), list_id, item_ids);
      return toolResult(result);
    },
  );
}
