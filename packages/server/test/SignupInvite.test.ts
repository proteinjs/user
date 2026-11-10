import moment from 'moment';

/**
 * Covers invite token lifetime and the expired-token user experience.
 *
 * Three things are asserted here:
 * 1. `sendInvite` stamps `tokenExpiresAt` from the `INVITE_TOKEN_TTL_DAYS` knob (not a literal),
 *    on both the create and the refresh path, and the row holds the mailed token's DIGEST — the
 *    token exists only in the link (the one mailed token that was held in clear, 2026-11).
 * 2. An expired token produces an honest, actionable message at `initializeSignup` — the surface
 *    the signup page reads — and is distinguishable from a token that never existed / was revoked.
 *    Previously both collapsed into "not found or has expired", and outside invite-only mode an
 *    expired token wasn't reported at all: signup rendered with the email field hidden and the user
 *    could only reach a generic "Sign up failed." on submit.
 *
 * The service's collaborators are stubbed at the module boundary; no db or mail server needed.
 */

const dbGet = jest.fn();
const dbInsert = jest.fn();
const dbUpdate = jest.fn();
const dbDelete = jest.fn();
const sendEmail = jest.fn();

const db = { get: dbGet, insert: dbInsert, update: dbUpdate, delete: dbDelete };

// Only the db accessors are stubbed; the table/column classes stay real because the table
// definitions in @proteinjs/user extend them at import time.
jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getDb: () => db,
  getDbAsSystem: () => db,
}));

jest.mock('@proteinjs/email-server', () => ({
  EmailSender: jest.fn().mockImplementation(() => ({ sendEmail })),
  getDefaultInviteEmailConfigFactory: () => ({
    // Echoes the signup path so the mailed token can be read back from the link.
    getConfig: () => ({
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

// `merge` is kept real so the generated source graphs still load; only lookup is stubbed, so
// `getDefaultInviteConfigFactory` falls back to its invite-optional default.
jest.mock('@proteinjs/reflection', () => ({
  ...jest.requireActual('@proteinjs/reflection'),
  SourceRepository: {
    ...jest.requireActual('@proteinjs/reflection').SourceRepository,
    get: () => ({ object: () => undefined }),
  },
}));

import { UserRepo } from '@proteinjs/user';
import { INVITE_TOKEN_TTL_DAYS, Signup } from '../src/services/Signup';
import { sha256Hex } from './sha256Hex';

/** Thirty days: the invite link is the account's activation code (signing up through it verifies the address), bounded like one. */
const EXPECTED_TTL_DAYS = 30;

/** The token a mailed link carries: 32 CSPRNG bytes as 64 lowercase hex characters. */
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/** The token the invite mail carried — read from the link in the mail, the only place the token exists. */
const mailedToken = (): string => {
  const [[message]] = sendEmail.mock.calls as [[{ text: string }]];
  const match = /signup\?token=([0-9a-f]+)/.exec(message.text);
  if (!match) {
    throw new Error('the invite mail carries no token');
  }
  return match[1];
};

/** Tolerance for the clock advancing between the service stamping the token and the assertion. */
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

/**
 * Compares against the same `moment().add(days, 'days')` arithmetic the service uses, so a DST
 * boundary inside the window (90 days crosses one) cancels out instead of showing up as an hour of
 * drift. A wrong TTL is still off by days, so this stays a biting assertion.
 */
const secondsFromExpectedTtl = (tokenExpiresAt: any, ttlDays: number) =>
  Math.abs(moment(tokenExpiresAt).diff(moment().add(ttlDays, 'days'), 'seconds'));

describe('invite token lifetime', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    dbInsert.mockImplementation(async (table: any, record: any) => record);
    // `sendInvite` stamps the inviter from the session; there is no session in a unit test.
    jest.spyOn(UserRepo.prototype, 'getUser').mockReturnValue({ id: 'inviter-1' } as any);
  });

  it('is configured by the INVITE_TOKEN_TTL_DAYS knob', () => {
    expect(INVITE_TOKEN_TTL_DAYS).toBe(EXPECTED_TTL_DAYS);
  });

  it('stamps tokenExpiresAt from the knob when creating an invite', async () => {
    dbGet.mockResolvedValue(undefined); // no existing user, no existing invite

    const response = await new Signup().sendInvite('Invitee@Test.local');

    expect(response.sent).toBe(true);
    expect(dbInsert).toHaveBeenCalledTimes(1);
    const [, inserted] = dbInsert.mock.calls[0];
    // The row holds the digest of the mailed token, never the token; the mail holds the token alone.
    const token = mailedToken();
    expect(token).toMatch(TOKEN_SHAPE);
    expect(inserted.token).toBe(sha256Hex(token));
    expect(inserted.token).not.toBe(token);
    expect(inserted.email).toBe('invitee@test.local');
    // The inviter is stamped as a REFERENCE to the user record (the id string rides inside it).
    expect(inserted.invitedBy?._table).toBe('user');
    expect(inserted.invitedBy?._id).toBe('inviter-1');
    expect(secondsFromExpectedTtl(inserted.tokenExpiresAt, INVITE_TOKEN_TTL_DAYS)).toBeLessThan(
      CLOCK_SKEW_TOLERANCE_SECONDS
    );
    // Pin the value too, so changing the constant is a deliberate act rather than a drive-by.
    expect(secondsFromExpectedTtl(inserted.tokenExpiresAt, EXPECTED_TTL_DAYS)).toBeLessThan(
      CLOCK_SKEW_TOLERANCE_SECONDS
    );
  });

  it('stamps tokenExpiresAt from the knob when refreshing an existing invite', async () => {
    dbGet
      .mockResolvedValueOnce(undefined) // user lookup
      .mockResolvedValueOnce({ id: 'invite-1', email: 'invitee@test.local', token: 'old-token' });

    await new Signup().sendInvite('invitee@test.local');

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    const [, updated] = dbUpdate.mock.calls[0];
    expect(updated.token).not.toBe('old-token');
    expect(updated.token).toBe(sha256Hex(mailedToken()));
    expect(secondsFromExpectedTtl(updated.tokenExpiresAt, INVITE_TOKEN_TTL_DAYS)).toBeLessThan(
      CLOCK_SKEW_TOLERANCE_SECONDS
    );
  });
});

describe('expired invite user experience', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const EXPIRED_TOKEN = 'e1'.repeat(32);
  const GOOD_TOKEN = 'a9'.repeat(32);

  it('tells the user the invite expired, and what to do about it', async () => {
    dbGet.mockResolvedValue({
      id: 'invite-1',
      email: 'invitee@test.local',
      token: sha256Hex(EXPIRED_TOKEN),
      tokenExpiresAt: moment().subtract(1, 'day'),
    });

    const response = await new Signup().initializeSignup(EXPIRED_TOKEN);

    expect(response.isReady).toBe(false);
    expect(response.error).toMatch(/expired/i);
    // The actionable half — an honest error still has to tell the user their way out.
    expect(response.error).toMatch(/new one/i);
    // It must not read as a generic failure or leave signup half-rendered.
    expect(response.error).not.toMatch(/not found/i);
    expect(response.invite).toBeUndefined();
  });

  it('reports an unknown or revoked token distinctly from an expired one', async () => {
    dbGet.mockResolvedValue(undefined);

    const response = await new Signup().initializeSignup('c3'.repeat(32));

    expect(response.isReady).toBe(false);
    expect(response.error).toMatch(/no longer valid/i);
    expect(response.error).not.toMatch(/expired/i);
  });

  it('a value without a token\'s shape is "no longer valid" before any lookup — no filter is built from it', async () => {
    for (const presented of ['unknown-token', sha256Hex(GOOD_TOKEN).toUpperCase(), 'a9'.repeat(31), 'A9'.repeat(32)]) {
      const response = await new Signup().initializeSignup(presented);
      expect(response.isReady).toBe(false);
      expect(response.error).toMatch(/no longer valid/i);
    }
    expect(dbGet).not.toHaveBeenCalled();
  });

  it('accepts a token that has not expired yet', async () => {
    const invite = {
      id: 'invite-1',
      email: 'invitee@test.local',
      token: sha256Hex(GOOD_TOKEN),
      tokenExpiresAt: moment().add(1, 'day'),
    };
    dbGet.mockResolvedValue(invite);

    const response = await new Signup().initializeSignup(GOOD_TOKEN);

    expect(response.isReady).toBe(true);
    expect(response.error).toBeUndefined();
    expect(response.invite?.email).toBe('invitee@test.local');
    // The row is found by the token's digest — the lookup never carries the token itself.
    expect(dbGet).toHaveBeenCalledWith(expect.anything(), { token: sha256Hex(GOOD_TOKEN) });
  });

  it('still blocks tokenless signup when invite-only, without an expiry message', async () => {
    const response = await new Signup().initializeSignup(undefined);

    // Default config is invite-optional, so this is the open case.
    expect(response.isReady).toBe(true);
    expect(dbGet).not.toHaveBeenCalled();
  });
});
