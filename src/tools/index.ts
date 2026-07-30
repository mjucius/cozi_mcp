import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CoziClient } from '../cozi/index.js';
import { registerCalendarTools } from './calendar.js';
import { registerFamilyMembersTool } from './family.js';
import { registerItemTools } from './items.js';
import { registerListTools } from './lists.js';

export type ToolAccessMode = 'read-write' | 'read-only';

export function registerCoziTools(
  server: McpServer,
  getClient: () => Promise<CoziClient>,
  accessMode: ToolAccessMode = 'read-write',
): void {
  registerFamilyMembersTool(server, getClient);
  registerListTools(server, getClient, accessMode);
  registerItemTools(server, getClient, accessMode);
  registerCalendarTools(server, getClient, accessMode);
}

export const READ_ONLY_TOOL_NAMES = [
  'family_members',
  'get_lists',
  'get_list_items',
  'get_calendar',
] as const;

export const WRITE_TOOL_NAMES = [
  'create_list',
  'delete_list',
  'add_item',
  'update_item',
  'remove_items',
  'create_appointment',
  'update_appointment',
  'delete_appointment',
] as const;

export const TOOL_NAMES = [...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES] as const;
