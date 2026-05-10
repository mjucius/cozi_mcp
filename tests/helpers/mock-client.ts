import { vi, type Mock } from 'vitest';
import type { CoziClient } from '../../src/cozi/index.js';

type MockedMethods = {
  [K in keyof CoziClient as CoziClient[K] extends (...args: never[]) => unknown ? K : never]: Mock;
};

export type MockedCoziClient = MockedMethods;

const METHODS = [
  'authenticate',
  'getFamilyMembers',
  'getLists',
  'getListsByType',
  'createList',
  'deleteList',
  'addItem',
  'updateItemText',
  'markItem',
  'removeItems',
  'getCalendar',
  'createAppointment',
  'updateAppointment',
  'deleteAppointment',
] as const;

export function makeMockClient(): MockedCoziClient {
  const obj: Record<string, Mock> = {};
  for (const m of METHODS) obj[m] = vi.fn();
  return obj as unknown as MockedCoziClient;
}

export function asClient(mock: MockedCoziClient): CoziClient {
  return mock as unknown as CoziClient;
}
