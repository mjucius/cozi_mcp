import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CoziClient, ResourceNotFoundError } from '../cozi/index.js';
import { parseListType } from './parsers.js';
import {
  slimItem,
  slimListSummary,
  type SlimItem,
  type SlimListSummary,
} from './projections.js';

export async function getListsHandler(
  client: CoziClient,
  listType?: string,
): Promise<SlimListSummary[]> {
  const wanted = listType !== undefined ? parseListType(listType) : undefined;
  const all = await client.getLists();
  const filtered = wanted !== undefined ? all.filter((l) => l.listType === wanted) : all;
  return filtered.map(slimListSummary);
}

export async function getListItemsHandler(
  client: CoziClient,
  listId: string,
  includeCompleted: boolean,
): Promise<SlimItem[]> {
  const lists = await client.getLists();
  const target = lists.find((l) => l.id === listId);
  if (!target) throw new ResourceNotFoundError(`List not found: ${listId}`);
  const items = includeCompleted ? target.items : target.items.filter((i) => i.status === 'incomplete');
  return items.map(slimItem);
}

export async function createListHandler(
  client: CoziClient,
  name: string,
  listType: string,
): Promise<{ id: string; title: string; type: string }> {
  const lst = await client.createList(name, parseListType(listType));
  return { id: lst.id ?? '', title: lst.title, type: lst.listType };
}

export async function deleteListHandler(client: CoziClient, listId: string): Promise<boolean> {
  return client.deleteList(listId);
}

export function registerListTools(
  server: McpServer,
  getClient: () => Promise<CoziClient>,
): void {
  server.registerTool(
    'get_lists',
    {
      title: 'Summarize all lists',
      description:
        "Summarize all lists (no items). Optionally filter by 'shopping' or 'todo'. " +
        'Returns: [{id, title, type, item_count, completed_count}].',
      inputSchema: { list_type: z.string().optional() },
    },
    async ({ list_type }) => {
      const result = await getListsHandler(await getClient(), list_type);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'get_list_items',
    {
      title: 'Get items in a list',
      description:
        'Items in one list. Excludes completed items by default. Returns: [{id, text, status, position?}].',
      inputSchema: {
        list_id: z.string(),
        include_completed: z.boolean().optional(),
      },
    },
    async ({ list_id, include_completed }) => {
      const result = await getListItemsHandler(await getClient(), list_id, include_completed ?? false);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'create_list',
    {
      title: 'Create a list',
      description: "Create a list ('shopping' or 'todo'). Returns: {id, title, type}.",
      inputSchema: { name: z.string(), list_type: z.string() },
    },
    async ({ name, list_type }) => {
      const result = await createListHandler(await getClient(), name, list_type);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'delete_list',
    {
      title: 'Delete a list',
      description: 'Delete a list. Returns true on success.',
      inputSchema: { list_id: z.string() },
    },
    async ({ list_id }) => {
      const result = await deleteListHandler(await getClient(), list_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );
}
