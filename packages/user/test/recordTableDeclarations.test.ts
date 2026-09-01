import { InviteTable } from '../src/tables/InviteTable';
import { SessionTable } from '../src/tables/SessionTable';

/**
 * The admin row-scan declarations (founder admin review, v1.22): what the generic record table
 * renders for invites and sessions is DECLARED here (Table.ui.recordTable.columns — db-ui
 * renders what tables declare). Two pins with teeth:
 *  - the invite row scan never carries the redeemable `token` (auth material; hygiene) — it
 *    stays on the record form;
 *  - the session row scan never carries the serialized session blob (cookie material).
 * Every declared name must be a real column property, so a schema rename cannot silently
 * strand the declaration.
 */
describe('admin row-scan declarations', () => {
  it('invite rows: who, by whom, until when — never the token', () => {
    const table = new InviteTable();
    const declared = table.ui?.recordTable?.columns;
    expect(declared).toEqual(['email', 'invitedBy', 'tokenExpiresAt']);
    expect(declared).not.toContain('token');
    for (const column of declared!) {
      expect((table.columns as any)[column]).toBeDefined();
    }
  });

  it('session rows: whose, when it dies, which one — never the serialized session', () => {
    const table = new SessionTable();
    const declared = table.ui?.recordTable?.columns;
    expect(declared).toEqual(['userEmail', 'expires', 'sessionId']);
    expect(declared).not.toContain('session');
    for (const column of declared!) {
      expect((table.columns as any)[column]).toBeDefined();
    }
  });
});
