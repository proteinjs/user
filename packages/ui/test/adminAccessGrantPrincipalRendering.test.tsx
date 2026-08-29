/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 *
 * The admin AccessGrants table renders `principal` as the referenced USER's name, linked to
 * their record form — the same ReferenceCellValue surface the Users/Invites tables use for
 * `invitedBy`. What this suite binds is the REAL AccessGrantTable declaration reaching it:
 * rows are built the way the db layer builds them — `deserialize` stamps the COLUMN
 * DECLARATION's reference-table name onto every read-back Reference — so a declaration naming
 * the class (`'UserTable'`) instead of the table (`'user'`) fails these assertions (the
 * resolver finds no such table; the link would point at `?table=UserTable`).
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { StaticTableLoader } from '@proteinjs/ui';

// ReferenceCellValue resolves through Reference.get(); the fake resolves the principal to a
// named user record so the enrichment path is observable without a db. Note the fake only
// answers for the real table name 'user' — a declaration-corrupted table name gets nothing.
jest.mock('@proteinjs/db', () => {
  const actual = jest.requireActual('@proteinjs/db');
  class FakeReference {
    constructor(
      public _table: string,
      public _id?: string
    ) {}
    async get() {
      if (this._table === 'user' && this._id === 'principal-1') {
        return { id: 'principal-1', name: 'Priya Principal' };
      }
      throw new Error('not visible');
    }
  }
  return { ...actual, Reference: FakeReference };
});

import { Reference, ReferenceColumn } from '@proteinjs/db';
import { RecordTable, clearReferenceNameCache } from '@proteinjs/db-ui';
import { tables, AccessGrant, User } from '@proteinjs/user';

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

/**
 * The principal reference exactly as the db layer would hand it to the table: the reference's
 * table name comes from the COLUMN DECLARATION (ReferenceColumn.deserialize stamps
 * `this.referenceTable`), never from stored data — stored cells are bare ids.
 */
const principalReference = () => {
  const principalColumn = tables.AccessGrant.columns.principal as unknown as ReferenceColumn<User>;
  return new Reference<User>(principalColumn.referenceTable, 'principal-1');
};

const grantRow = {
  id: 'grant-1',
  principal: principalReference(),
  resource: new Reference('thought', 'thought-1'),
  resourceTable: 'thought',
  accessLevel: 'read',
} as unknown as AccessGrant;

describe('the admin AccessGrants table renders principal as the linked user', () => {
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

  const mount = async (rows: AccessGrant[]) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <RecordTable
              table={tables.AccessGrant}
              tableLoader={
                new StaticTableLoader(rows, { dataKey: `grant-principal-${Math.random()}`, dataQueryKey: 'all' })
              }
              hideButtons
              columns={['accessLevel', 'principal'] as any}
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

  const principalCell = () => container.querySelectorAll('tbody td')[1] as HTMLElement;

  it('links the principal by name to their user record', async () => {
    await mount([grantRow]);
    const link = principalCell().querySelector('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/record/form?table=user&record=principal-1');
    expect(principalCell().textContent).toBe('Priya Principal');
  });
});
