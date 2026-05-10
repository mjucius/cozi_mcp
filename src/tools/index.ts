import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CoziClient } from '../cozi/index.js';
import { registerCalendarTools } from './calendar.js';
import { registerFamilyMembersTool } from './family.js';
import { registerItemTools } from './items.js';
import { registerListTools } from './lists.js';

export function registerCoziTools(
  server: McpServer,
  getClient: () => Promise<CoziClient>,
): void {
  registerFamilyMembersTool(server, getClient);
  registerListTools(server, getClient);
  registerItemTools(server, getClient);
  registerCalendarTools(server, getClient);
}

export const TOOL_NAMES = [
  'family_members',
  'get_lists',
  'get_list_items',
  'create_list',
  'delete_list',
  'add_item',
  'update_item',
  'remove_items',
  'get_calendar',
  'create_appointment',
  'update_appointment',
  'delete_appointment',
] as const;
