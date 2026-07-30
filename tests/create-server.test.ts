import { describe, expect, it } from 'vitest';
import createServer from '../src/server.js';
import { READ_ONLY_TOOL_NAMES, TOOL_NAMES, WRITE_TOOL_NAMES } from '../src/tools/index.js';

describe('create_server', () => {
  const registeredToolNames = (server: unknown): string[] => {
    const tools = (server as { _registeredTools?: Record<string, unknown> })._registeredTools;
    return Object.keys(tools ?? {});
  };

  it('registers all 12 expected tools', async () => {
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
      'delete_list',
      'add_item',
      'update_item',
      'remove_items',
      'get_calendar',
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

    expect(readOnlyTools).toEqual(new Set(['family_members', 'get_lists', 'get_list_items', 'get_calendar']));
    expect(writeTools).toEqual(new Set([
      'create_list',
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

  it('constructs in read-only mode without registering write tools', () => {
    const server = createServer({ config: { username: 'test', password: 'test', readOnly: true } });
    expect(server).toBeDefined();
    expect(new Set(registeredToolNames(server))).toEqual(new Set(READ_ONLY_TOOL_NAMES));
  });
});
