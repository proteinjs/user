import moment from 'moment';

/**
 * Re-sending an invite (`SignupService.resendInvite`), against the emulator — outcomes on the row
 * and on the transport fake, never call counts alone:
 *
 *  - the token in the earlier email stops resolving, the fresh one resolves to the SAME invite;
 *  - the row count for the address stays one, its expiry re-stamped from the TTL knob, its inviter kept;
 *  - exactly one email goes out for the re-send, to the address, carrying the fresh signup link;
 *  - an address with no standing invite is refused: nothing written, nothing sent;
 *  - an address that already has an account is refused the same way (the invite was used).
 *
 * The email transport is stubbed at the module boundary (the SignupInvite.test.ts pattern) — SMTP
 * is an external transport; the config fake echoes the signup path so the link can be asserted.
 * The service door (`serviceMetadata.auth`) is pinned here too: re-send rides the 'users' permission
 * exactly like send and revoke — the earlier gap that left invite minting public must not reopen.
 */

const sendEmail = jest.fn();
jest.mock('@proteinjs/email-server', () => ({
  EmailSender: jest.fn().mockImplementation(() => ({ sendEmail })),
  getDefaultInviteEmailConfigFactory: () => ({
    getConfig: () => ({
      options: { subject: 'Your invite' },
      getEmailContent: (signupPathWithToken: string) => ({
        text: `Accept: /${signupPathWithToken}`,
        html: `<a href="/${signupPathWithToken}">Accept</a>`,
      }),
    }),
  }),
  getDefaultSignupConfirmationEmailConfigFactory: () => ({
    getConfig: () => ({ getNewUserEmailContent: () => ({ text: 'welcome', html: '<p>welcome</p>' }) }),
  }),
}));

import { getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { tables, UserAuth, USER_PERMISSIONS, type Invite, type User } from '@proteinjs/user';
import { INVITE_TOKEN_TTL_DAYS, Signup } from '../src/services/Signup';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';

const TIMEOUT = 60_000;

/** Tolerance for the clock advancing between the stamp and the assertion. */
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

const inviteRows = async (email: string): Promise<Invite[]> =>
  (await getDbAsSystem().query(tables.Invite, { email })) as Invite[];

/** The re-send's own transport call: the one addressed to `email` after the earlier `before` calls. */
const emailsTo = (email: string) =>
  sendEmail.mock.calls.map(([message]) => message).filter((message) => message.to === email);

describe('SignupService.resendInvite — against the emulator', () => {
  const env = new UserServerTestEnvironment();
  let inviter: User;

  beforeAll(async () => {
    await env.beforeAll();
    // The invite-mode factory the token lookup consults (`initializeSignup`) — seeded like the
    // environment seeds its own loadables (the suites load src, never the generated source
    // graph, so an unseeded lookup has no graph to walk); invite-optional, the library default.
    (SourceRepository.get() as unknown as { objectCache: Record<string, unknown[]> }).objectCache[
      '@proteinjs/user-server/DefaultInviteConfigFactory'
    ] = [{ getConfig: () => ({ isInviteOnly: false }) }];
    inviter = await env.createUser({ name: 'Inviter', email: 'inviter@example.com', roles: ['admin'] });
    env.actAs(inviter);
  }, TIMEOUT);

  afterAll(async () => {
    await env.afterAll();
  }, TIMEOUT);

  beforeEach(() => {
    sendEmail.mockClear();
  });

  it(
    'retires the earlier token, mints a fresh one on the SAME row, and emails the fresh link exactly once',
    async () => {
      const email = 'guest@example.com';
      const sent = await new Signup().sendInvite(email);
      expect(sent).toEqual({ sent: true });
      const [standing] = await inviteRows(email);
      const earlierToken = standing.token as string;
      const earlierExpiry = moment(standing.tokenExpiresAt);
      expect(emailsTo(email)).toHaveLength(1);

      const resent = await new Signup().resendInvite('Guest@Example.com');
      expect(resent).toEqual({ sent: true });

      // One row — the same record, a fresh token, the inviter kept.
      const rows = await inviteRows(email);
      expect(rows).toHaveLength(1);
      const [refreshed] = rows;
      expect(refreshed.id).toBe(standing.id);
      expect(refreshed.token).not.toBe(earlierToken);
      expect(refreshed.invitedBy?._id).toBe(inviter.id);
      // The expiry is re-stamped from the knob (fresh window), never left at the earlier stamp.
      expect(moment(refreshed.tokenExpiresAt).isSameOrAfter(earlierExpiry)).toBe(true);
      expect(
        Math.abs(moment(refreshed.tokenExpiresAt).diff(moment().add(INVITE_TOKEN_TTL_DAYS, 'days'), 'seconds'))
      ).toBeLessThan(CLOCK_SKEW_TOLERANCE_SECONDS);

      // The earlier link is dead; the fresh one opens signup for this invite.
      const earlier = await new Signup().initializeSignup(earlierToken);
      expect(earlier.isReady).toBe(false);
      expect(earlier.error).toMatch(/no longer valid/i);
      const fresh = await new Signup().initializeSignup(refreshed.token as string);
      expect(fresh.isReady).toBe(true);
      expect(fresh.invite?.email).toBe(email);

      // Exactly one more email, to the address, carrying the fresh token and none of the earlier one.
      const messages = emailsTo(email);
      expect(messages).toHaveLength(2);
      const resend = messages[1];
      expect(resend.subject).toBe('Your invite');
      expect(resend.text).toContain(`signup?token=${refreshed.token}`);
      expect(resend.html).toContain(`signup?token=${refreshed.token}`);
      expect(resend.text).not.toContain(earlierToken);
    },
    TIMEOUT
  );

  it(
    'refuses an address with no standing invite — nothing written, nothing sent',
    async () => {
      const email = 'nobody@example.com';
      const response = await new Signup().resendInvite(email);
      expect(response.sent).toBe(false);
      expect(response.error).toMatch(/no invite/i);
      expect(await inviteRows(email)).toHaveLength(0);
      expect(emailsTo(email)).toHaveLength(0);
    },
    TIMEOUT
  );

  it(
    'refuses an address that already has an account — the invite was used',
    async () => {
      const email = 'member@example.com';
      await env.createUser({ name: 'Member', email });
      const response = await new Signup().resendInvite(email);
      expect(response.sent).toBe(false);
      expect(response.error).toMatch(/already exists/i);
      expect(emailsTo(email)).toHaveLength(0);
    },
    TIMEOUT
  );

  it('rides the users-permission door like send and revoke (never public)', () => {
    const hasPermission = jest.spyOn(UserAuth, 'hasPermission');
    try {
      hasPermission.mockReturnValue(false);
      expect(new Signup().serviceMetadata.auth.canAccess('resendInvite', ['x@example.com'])).toBe(false);
      hasPermission.mockReturnValue(true);
      expect(new Signup().serviceMetadata.auth.canAccess('resendInvite', ['x@example.com'])).toBe(true);
      expect(hasPermission).toHaveBeenCalledWith(USER_PERMISSIONS.users);
    } finally {
      hasPermission.mockRestore();
    }
  });
});
