/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 *
 * The admin payoff of `invitedBy` being a REFERENCE column: the generic admin record tables
 * (Users, Invites) render the inviter as the referenced user's NAME, linked to their record
 * form — not a raw uuid. The rendering machinery is @proteinjs/db-ui's (ReferenceCellValue,
 * covered generically there); what these assertions bind is that THE REAL user/invite table
 * declarations reach it — i.e. `invitedBy` is a reference column on both tables, through the
 * exact RecordTable surface the admin pages mount.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { StaticTableLoader } from '@proteinjs/ui';

// ReferenceCellValue resolves through Reference.get(); the fake resolves the inviter to a named
// record so the enrichment path is observable without a db.
jest.mock('@proteinjs/db', () => {
  const actual = jest.requireActual('@proteinjs/db');
  class FakeReference {
    constructor(
      public _table: string,
      public _id?: string
    ) {}
    async get() {
      if (this._table === 'user' && this._id === 'inviter-1') {
        return { id: 'inviter-1', name: 'Ada Inviter' };
      }
      throw new Error('not visible');
    }
  }
  return { ...actual, Reference: FakeReference };
});

import { Reference } from '@proteinjs/db';
import { RecordTable, clearReferenceNameCache } from '@proteinjs/db-ui';
import { tables, Invite, User } from '@proteinjs/user';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).IntersectionObserver = StubIntersectionObserver;

const inviterReference = () => new Reference<User>(tables.User.name, 'inviter-1');

const userRow = {
  id: 'user-2',
  name: 'Invited Person',
  email: 'invited@test.local',
  password: 'irrelevant',
  emailVerified: true,
  roles: [],
  invitedBy: inviterReference(),
} as unknown as User;

const inviteRow = {
  id: 'invite-1',
  email: 'invitee@test.local',
  token: 'tok',
  tokenExpiresAt: null,
  invitedBy: inviterReference(),
} as unknown as Invite;

describe('admin tables render invitedBy as the linked inviter', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    clearReferenceNameCache();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const mount = async (table: any, rows: any[], columns: string[]) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <RecordTable
              table={table}
              tableLoader={new StaticTableLoader(rows, { dataKey: `invited-by-${Math.random()}`, dataQueryKey: 'all' })}
              hideButtons
              columns={columns as any}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    // one macrotask for the name resolution to land
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const invitedByCell = () => container.querySelectorAll('tbody td')[1] as HTMLElement;

  it('the Users table links the inviter by name to their user record', async () => {
    await mount(tables.User, [userRow], ['name', 'invitedBy']);
    const link = invitedByCell().querySelector('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/record/form?table=user&record=inviter-1');
    expect(invitedByCell().textContent).toBe('Ada Inviter');
  });

  it('the Invites table links the inviter by name to their user record', async () => {
    await mount(tables.Invite, [inviteRow], ['email', 'invitedBy']);
    const link = invitedByCell().querySelector('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/record/form?table=user&record=inviter-1');
    expect(invitedByCell().textContent).toBe('Ada Inviter');
  });
});
