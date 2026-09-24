import { UserAuth } from '@proteinjs/user-auth';
import { TableAuth, TableServiceAuth } from '@proteinjs/db';
import { tables } from '../src/tables/tables';

/**
 * The audit trails keep their rows (`Table.durable`): no caller deletes a role grant or a status
 * change — break-glass admin included — and the refusal is the 403 that names the table. The
 * record surfaces read the same verdict (no delete act, no Delete on the form).
 */

type UserAuthInternals = { userRepo?: { getUser: () => { email: string; roles: string[] } } };

const refusalOf = (act: () => unknown) => {
  try {
    act();
  } catch (error: any) {
    return { name: error?.name, status: error?.status, message: error?.message };
  }
  return undefined;
};

describe('the audit trails are durable', () => {
  beforeEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = {
      getUser: () => ({ email: 'admin@test.local', roles: ['admin'] }),
    };
  });

  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  });

  for (const table of [tables.RoleGrantEvent, tables.UserStatusEvent]) {
    it(`${table.name}: every caller's delete is refused on both doors, admin included`, () => {
      for (const api of ['db', 'service'] as const) {
        expect(refusalOf(() => new TableAuth().canDelete(table, api))).toEqual({
          name: 'ServiceRefusal',
          status: 403,
          message: `Table ${table.name} is durable: its rows are never deleted`,
        });
        expect(new TableAuth().canPerform(table, 'delete', api)).toBe(false);
      }
      expect(refusalOf(() => new TableServiceAuth().canAccess('delete', [table, { id: 'event-1' }]))?.status).toBe(403);
    });
  }
});
