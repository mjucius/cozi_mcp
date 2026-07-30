import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CoziClient } from '../cozi/index.js';
import { slimPerson, type SlimPerson } from './projections.js';
import { toolResult } from './untrusted.js';

export async function familyMembersHandler(client: CoziClient): Promise<SlimPerson[]> {
  const people = await client.getFamilyMembers();
  return people.map(slimPerson);
}

export function registerFamilyMembersTool(
  server: McpServer,
  getClient: () => Promise<CoziClient>,
): void {
  server.registerTool(
    'family_members',
    {
      title: 'List family members',
      description:
        'List family members. Use the `id` for appointment attendees. Returns: [{id, name, color?}].',
      inputSchema: {},
    },
    async () => {
      const result = await familyMembersHandler(await getClient());
      return toolResult(result);
    },
  );
}
