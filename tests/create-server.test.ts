import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import createServer, { SERVER_VERSION } from '../src/server.js';
import { READ_ONLY_TOOL_NAMES, TOOL_NAMES, WRITE_TOOL_NAMES } from '../src/tools/index.js';

describe('create_server', () => {
  const registeredToolNames = (server: unknown): string[] => {
    const tools = (server as { _registeredTools?: Record<string, unknown> })._registeredTools;
    return Object.keys(tools ?? {});
  };

  it('registers all 16 expected tools', async () => {
    const server = createServer({ config: { username: 'test', password: 'test' } });
    // McpServer exposes the underlying server which has list-tools handlers, but
    // the easiest path here is to cross-check against TOOL_NAMES (the source of
    // truth used by registerCoziTools) and assert a sample of names appear by
    // reflecting on the registered handler map via a public API. The SDK
    // exposes `server.server` (lower-case Server). For a simple smoke test we
    // assert the constant matches the expected set.
    const expected = new Set([
      'family_members',
      'get_lists',
      'get_list_items',
      'create_list',
      'rename_list',
      'delete_list',
      'add_item',
      'update_item',
      'remove_items',
      'get_calendar',
      'search_calendar',
      'today',
      'server_version',
      'create_appointment',
      'update_appointment',
      'delete_appointment',
    ]);
    expect(new Set(TOOL_NAMES)).toEqual(expected);

    // Server itself constructs without throwing — that confirms the registrar ran.
    expect(server).toBeDefined();
    expect(new Set(registeredToolNames(server))).toEqual(expected);
  });

  it('separates read-only tools from write tools', () => {
    const readOnlyTools = new Set(READ_ONLY_TOOL_NAMES);
    const writeTools = new Set(WRITE_TOOL_NAMES);

    expect(readOnlyTools).toEqual(new Set(['family_members', 'get_lists', 'get_list_items', 'get_calendar', 'search_calendar', 'today', 'server_version']));
    expect(writeTools).toEqual(new Set([
      'create_list',
      'rename_list',
      'delete_list',
      'add_item',
      'update_item',
      'remove_items',
      'create_appointment',
      'update_appointment',
      'delete_appointment',
    ]));
    expect([...readOnlyTools].some((name) => writeTools.has(name))).toBe(false);
  });

  it('server_version reports the running version without contacting Cozi', async () => {
    const server = createServer({
      config: { username: 'test', password: 'test', readOnly: true },
      getClient: () => Promise.reject(new Error('no Cozi call expected')),
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    const result = (await client.callTool({ name: 'server_version', arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain(JSON.stringify({ name: 'cozi-mcp', version: SERVER_VERSION }));
  });

  it('constructs in read-only mode without registering write tools', () => {
    const server = createServer({ config: { username: 'test', password: 'test', readOnly: true } });
    expect(server).toBeDefined();
    expect(new Set(registeredToolNames(server))).toEqual(new Set(READ_ONLY_TOOL_NAMES));
  });
});
