import { createHash } from 'crypto';
import moment from 'moment';
import { getDbAsSystem } from '@proteinjs/db';
import { EmailSender, MailSink } from '@proteinjs/email-server';
import { SourceRepository } from '@proteinjs/reflection';
import { tables } from '@proteinjs/user';
import { initiatePasswordReset } from '../src/routes/initiatePasswordReset';
import { executePasswordReset } from '../src/routes/executePasswordReset';
import { PasswordHasher } from '../src/authentication/PasswordHasher';
import { PasswordResetToken } from '../src/authentication/PasswordResetToken';
import { UserServerTestEnvironment } from './UserServerTestEnvironment';
import { LogCapture } from './LogCapture';

const testEnv = new UserServerTestEnvironment();

/**
 * `POST /user/initiate-password-reset`, end to end against the Spanner emulator and the mail
 * sink — outcomes only (the mail recorded, the row written):
 * - the token travels in the mailed link and nowhere else: the row stores its SHA-256 digest and
 *   an expiry an hour out, never the token, and the link's token then resets the password;
 * - a send that fails withdraws the token, so asking again straight away mails a link;
 * - a second request inside five minutes is throttled: no new mail, the row unchanged;
 * - an unknown address gets the same response and no mail;
 * - a request with no body, or no usable email: 400, no mail, nothing changes;
 * - no minted token, no leading characters of one and no full digest reach the log — on the
 *   mailed path, the throttled repeat, the unknown address, or the failed send's error line;
 * - ONE answer, whatever happens behind it: an account mailed, no account, too soon, over a
 *   window, a failed send — the same 200 and the same sentence, sent before the account is
 *   looked up (so its timing says nothing either);
 * - per address three requests an hour and per client address ten: past either, nothing is mailed;
 * - every request is one outcome line carrying the account digest and the coarse IP hash, never
 *   the address.
 */

type RouteOutcome = { status: number; body?: any };

/** Each request arrives from its own client address unless the test names one (the dev shape: no proxy). */
let nextAddress = 0;
const fromAddress = (ip?: string) => ({
  headers: {},
  socket: { remoteAddress: ip ?? `10.20.${Math.floor(nextAddress / 250)}.${(nextAddress++ % 250) + 1}` },
  app: { get: () => false },
});

const invoke = async (
  route: typeof initiatePasswordReset,
  request: Record<string, unknown>,
  events?: string[]
): Promise<RouteOutcome> => {
  const outcome: RouteOutcome = { status: 200 };
  const response = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    send(body?: unknown) {
      events?.push('answered');
      outcome.body = body;
    },
  };
  await route.onRequest({ ...fromAddress(), ...request } as never, response as never);
  return outcome;
};

const GENERIC = { message: 'If that address has an account, a reset link is on its way.' };

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

const userRow = async (email: string) => await getDbAsSystem().get(tables.User, { email });

/** Every stored reset token in the table, by email — the whole-table outcome a refused request must leave untouched. */
const tokensByEmail = async (): Promise<Record<string, string | null | undefined>> => {
  const byEmail: Record<string, string | null | undefined> = {};
  for (const user of await getDbAsSystem().query(tables.User, {})) {
    byEmail[user.email] = user.passwordResetToken;
  }
  return byEmail;
};

/** The token in a reset mail's link. */
const tokenInLink = (mailText: string | undefined): string => {
  const token = /[?&]token=([0-9a-f]{64})\b/.exec(mailText ?? '')?.[1];
  if (!token) {
    throw new Error('The mail carries no reset link');
  }
  return token;
};

/** The token in the newest mailed reset link. */
const mailedToken = (): string => tokenInLink(MailSink.get().list(1)[0]?.text);

type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };

/** Moves an account's last mint back past the five-minute gap, so only the windows can refuse. */
const ageLastMint = async (email: string) => {
  const armed = await userRow(email);
  await getDbAsSystem().update(tables.User, {
    id: armed.id,
    passwordResetTokenExpiration: moment().add(54, 'minutes'),
  });
};

/** Log text without terminal colour codes. */
const plain = (text: string) => text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

/** The `field: '<16 hex>'` value on each line containing `marker` ('missing' where absent). */
const fieldsOn = (log: LogCapture, marker: string, field: string): string[] =>
  log.lines
    .map(plain)
    .filter((line) => line.includes(marker))
    .map((line) => new RegExp(`${field}: '([0-9a-f]{16})'`).exec(line)?.[1] ?? 'missing');

describe('initiatePasswordReset route', () => {
  const originalTransport = process.env.EMAIL_TRANSPORT;

  beforeAll(async () => {
    await testEnv.beforeAll();
    process.env.EMAIL_TRANSPORT = 'sink';
    const objectCache = (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
    objectCache['@proteinjs/email-server/DefaultEmailConfigFactory'] = [
      {
        getEmailConfig: () => ({
          host: 'smtp.test.local',
          port: 465,
          secure: true,
          from: '"Example" <hi@example.com>',
        }),
      },
    ];
    objectCache['@proteinjs/email-server/DefaultPasswordResetEmailConfigFactory'] = [
      {
        getConfig: () => ({
          getEmailContent: (resetPathWithToken: string) => ({
            text: `Reset your password: https://app.test.local/${resetPathWithToken}`,
          }),
        }),
      },
    ];
  });

  beforeEach(() => {
    MailSink.get().clear();
  });

  afterAll(async () => {
    if (originalTransport === undefined) {
      delete process.env.EMAIL_TRANSPORT;
    } else {
      process.env.EMAIL_TRANSPORT = originalTransport;
    }
    await testEnv.afterAll();
  });

  it("the token travels only in the mailed link: the row stores its digest and an hour's expiry, and the link's token resets the password", async () => {
    await testEnv.createUser({ name: 'Reset User', email: 'initiate-live@test.local' });

    const outcome = await invoke(initiatePasswordReset, { body: { email: 'Initiate-Live@test.local' } });

    expect(outcome).toEqual({ status: 200, body: GENERIC });
    const [mail] = MailSink.get().list();
    expect(mail.to).toEqual(['initiate-live@test.local']);
    const token = mailedToken();
    const armed = await userRow('initiate-live@test.local');
    expect(armed.passwordResetToken).toBe(sha256Hex(token));
    expect(JSON.stringify(armed)).not.toContain(token);
    const minutesOut = moment(armed.passwordResetTokenExpiration).diff(moment(), 'minutes', true);
    expect(minutesOut).toBeGreaterThan(59);
    expect(minutesOut).toBeLessThanOrEqual(60);

    const reset = await invoke(executePasswordReset, { body: { token, newPassword: 'a new password' } });

    expect(reset.status).toBe(200);
    const row = await userRow('initiate-live@test.local');
    await expect(new PasswordHasher().verify(row.password, 'a new password')).resolves.toBe(true);
    expect(row.passwordResetToken).toBeNull();
  });

  it('a send that fails withdraws the token — asking again straight away mails a link', async () => {
    await testEnv.createUser({ name: 'Reset User', email: 'initiate-send-fails@test.local' });
    const send = jest
      .spyOn(EmailSender.prototype, 'sendEmail')
      .mockRejectedValueOnce(new Error('Failed to send email'));
    try {
      const failed = await invoke(initiatePasswordReset, { body: { email: 'initiate-send-fails@test.local' } });

      expect(failed).toEqual({ status: 200, body: GENERIC });
      const withdrawn = await userRow('initiate-send-fails@test.local');
      expect(withdrawn.passwordResetToken).toBeNull();
      expect(withdrawn.passwordResetTokenExpiration).toBeNull();
    } finally {
      send.mockRestore();
    }

    const again = await invoke(initiatePasswordReset, { body: { email: 'initiate-send-fails@test.local' } });

    expect(again).toEqual({ status: 200, body: GENERIC });
    expect(MailSink.get().list()).toHaveLength(1);
    expect((await userRow('initiate-send-fails@test.local')).passwordResetToken).toBe(sha256Hex(mailedToken()));
  });

  it('a second request inside five minutes is throttled: no new mail, the row unchanged', async () => {
    await testEnv.createUser({ name: 'Reset User', email: 'initiate-throttled@test.local' });
    await invoke(initiatePasswordReset, { body: { email: 'initiate-throttled@test.local' } });
    const armed = await userRow('initiate-throttled@test.local');

    const second = await invoke(initiatePasswordReset, { body: { email: 'initiate-throttled@test.local' } });

    expect(second).toEqual({ status: 200, body: GENERIC });
    expect(MailSink.get().list()).toHaveLength(1);
    expect((await userRow('initiate-throttled@test.local')).passwordResetToken).toBe(armed.passwordResetToken);
  });

  it('a token minted more than five minutes ago is replaced: a new link is mailed and the old token stops working', async () => {
    await testEnv.createUser({ name: 'Reset User', email: 'initiate-replaced@test.local' });
    await invoke(initiatePasswordReset, { body: { email: 'initiate-replaced@test.local' } });
    const first = mailedToken();
    const armed = await userRow('initiate-replaced@test.local');
    await getDbAsSystem().update(tables.User, {
      id: armed.id,
      passwordResetTokenExpiration: moment().add(54, 'minutes'),
    });

    await invoke(initiatePasswordReset, { body: { email: 'initiate-replaced@test.local' } });

    expect(MailSink.get().list()).toHaveLength(2);
    const second = mailedToken();
    expect(second).not.toBe(first);
    expect((await userRow('initiate-replaced@test.local')).passwordResetToken).toBe(sha256Hex(second));
    const stale = await invoke(executePasswordReset, { body: { token: first, newPassword: 'hijacked' } });
    expect(stale.status).toBe(400);
  });

  it('no minted token, no leading characters of one and no full digest reach the log — mailed, throttled, unknown, failed send', async () => {
    await testEnv.createUser({ name: 'Reset User', email: 'initiate-log@test.local' });
    await testEnv.createUser({ name: 'Reset User', email: 'initiate-log-send-fails@test.local' });
    let mailed = '';
    let withdrawn = '';

    const log = await LogCapture.during(async () => {
      await invoke(initiatePasswordReset, { body: { email: 'initiate-log@test.local' } });
      mailed = mailedToken();
      await invoke(initiatePasswordReset, { body: { email: 'initiate-log@test.local' } });
      await invoke(initiatePasswordReset, { body: { email: 'initiate-log-nobody@test.local' } });
      // The send fails after the mail was built: the token it carried is the one withdrawn.
      const send = jest.spyOn(EmailSender.prototype, 'sendEmail').mockImplementationOnce(async (mail) => {
        withdrawn = tokenInLink(mail.text as string);
        throw new Error('Failed to send email');
      });
      try {
        const failed = await invoke(initiatePasswordReset, { body: { email: 'initiate-log-send-fails@test.local' } });
        expect(failed).toEqual({ status: 200, body: GENERIC });
      } finally {
        send.mockRestore();
      }
    });

    // The capture saw the route's lines: the throttle, the unknown address and the failed send logged.
    expect(log.text).toContain('Password reset requested too soon for user');
    expect(log.text).toContain('Password reset requested for non-existent user');
    expect(log.text).toContain('Failed to send password reset email');
    expect(withdrawn).not.toBe(mailed);
    for (const token of [mailed, withdrawn]) {
      log.expectFreeOf(token);
    }
  });

  it('an unknown address gets the same response and no mail', async () => {
    const outcome = await invoke(initiatePasswordReset, { body: { email: 'initiate-nobody@test.local' } });

    expect(outcome).toEqual({ status: 200, body: GENERIC });
    expect(MailSink.get().list()).toHaveLength(0);
  });

  it.each([
    ['no body', {}],
    ['a null body', { body: null }],
    ['no email', { body: {} }],
    ['a blank email', { body: { email: '' } }],
    ['an email that is not a string', { body: { email: { toLowerCase: null } } }],
  ])('a request with %s: 400, no mail, no token minted', async (_label, request) => {
    const tokensBefore = await tokensByEmail();

    const outcome = await invoke(initiatePasswordReset, request);

    expect(outcome.status).toBe(400);
    expect(MailSink.get().list()).toHaveLength(0);
    expect(await tokensByEmail()).toEqual(tokensBefore);
  });

  it('one answer whatever happens behind it: mailed, no account, too soon, over a window, a failed send', async () => {
    await testEnv.createUser({ name: 'Reset User', email: 'one-answer@test.local' });
    await testEnv.createUser({ name: 'Reset User', email: 'one-answer-fails@test.local' });
    const answers: RouteOutcome[] = [];
    const ask = async (email: string, ip?: string) =>
      answers.push(await invoke(initiatePasswordReset, { ...fromAddress(ip), body: { email } }));

    await ask('one-answer@test.local'); // mailed
    await ask('one-answer-nobody@test.local'); // no account
    await ask('one-answer@test.local'); // too soon
    await ask('one-answer@test.local');
    await ask('one-answer@test.local'); // over the address window
    for (let i = 0; i < 11; i++) {
      await ask(`one-answer-sweep-${i}@test.local`, '198.18.0.1'); // the eleventh is over the client window
    }
    const send = jest
      .spyOn(EmailSender.prototype, 'sendEmail')
      .mockRejectedValueOnce(new Error('Failed to send email'));
    try {
      await ask('one-answer-fails@test.local'); // a failed send
    } finally {
      send.mockRestore();
    }

    expect(answers).toHaveLength(17);
    expect(new Set(answers.map((answer) => JSON.stringify(answer)))).toEqual(
      new Set([JSON.stringify({ status: 200, body: GENERIC })])
    );
  });

  it('the answer goes out before the account is looked up, a token minted or a mail sent — its timing says nothing', async () => {
    await testEnv.createUser({ name: 'Reset User', email: 'answer-first@test.local' });
    const events: string[] = [];
    const realMint = PasswordResetToken.prototype.mint;
    const mint = jest.spyOn(PasswordResetToken.prototype, 'mint').mockImplementation(async function (
      this: PasswordResetToken,
      ...args: Parameters<PasswordResetToken['mint']>
    ) {
      events.push('minted');
      return await realMint.apply(this, args);
    });
    const send = jest.spyOn(EmailSender.prototype, 'sendEmail').mockImplementation(async () => {
      events.push('mailed');
    });
    try {
      await invoke(initiatePasswordReset, { body: { email: 'answer-first@test.local' } }, events);
    } finally {
      mint.mockRestore();
      send.mockRestore();
    }

    expect(events).toEqual(['answered', 'minted', 'mailed']);
  });

  it('per address: the fourth request inside the hour mails nothing, even past the five-minute gap', async () => {
    await testEnv.createUser({ name: 'Reset User', email: 'address-window@test.local' });
    for (let i = 0; i < 3; i++) {
      await invoke(initiatePasswordReset, { body: { email: 'Address-Window@test.local' } });
      await ageLastMint('address-window@test.local');
    }
    expect(MailSink.get().list()).toHaveLength(3);
    const armed = await userRow('address-window@test.local');

    const fourth = await invoke(initiatePasswordReset, { body: { email: 'address-window@test.local' } });

    expect(fourth).toEqual({ status: 200, body: GENERIC });
    expect(MailSink.get().list()).toHaveLength(3);
    expect((await userRow('address-window@test.local')).passwordResetToken).toBe(armed.passwordResetToken);
  });

  it('per client address: after ten requests the eleventh mails nothing, even for an account; another address still gets its link', async () => {
    await testEnv.createUser({ name: 'Reset User', email: 'client-window@test.local' });
    for (let i = 0; i < 10; i++) {
      await invoke(initiatePasswordReset, {
        ...fromAddress('198.18.1.1'),
        body: { email: `client-window-${i}@test.local` },
      });
    }

    const eleventh = await invoke(initiatePasswordReset, {
      ...fromAddress('198.18.1.1'),
      body: { email: 'client-window@test.local' },
    });

    expect(eleventh).toEqual({ status: 200, body: GENERIC });
    expect(MailSink.get().list()).toHaveLength(0);

    await invoke(initiatePasswordReset, { ...fromAddress('198.18.1.2'), body: { email: 'client-window@test.local' } });
    expect(
      MailSink.get()
        .list()
        .map((mail) => mail.to)
    ).toEqual([['client-window@test.local']]);
  });

  it('every request is one outcome line with the account digest and the coarse IP hash — never the address', async () => {
    await testEnv.createUser({ name: 'Reset User', email: 'reset.privacy.person@test.local' });

    const log = await LogCapture.during(async () => {
      const ask = (email: string) => invoke(initiatePasswordReset, { ...fromAddress('198.18.2.7'), body: { email } });
      await ask('reset.privacy.person@test.local'); // mailed
      await ask('Reset.Privacy.Person@TEST.local'); // too soon
      await ask('RESET.PRIVACY.PERSON@test.local'); // too soon
      await ask('reset.privacy.person@test.local'); // over the address window
      await ask('reset.privacy.nobody@test.local'); // no account
    });

    const markers = [
      'Password reset link mailed',
      'Password reset requested too soon for user',
      'Password reset throttled',
      'Password reset requested for non-existent user',
    ];
    const accounts = markers.map((marker) => fieldsOn(log, marker, 'account'));
    expect(accounts.map((values) => values.length)).toEqual([1, 2, 1, 1]);
    const person = accounts[0][0];
    expect(person).toMatch(/^[0-9a-f]{16}$/);
    expect([...accounts[1], ...accounts[2]]).toEqual([person, person, person]);
    expect(accounts[3][0]).toMatch(/^[0-9a-f]{16}$/);
    expect(accounts[3][0]).not.toBe(person);

    const ips = ([] as string[]).concat(...markers.map((marker) => fieldsOn(log, marker, 'ip')));
    expect(ips).toHaveLength(5);
    expect(ips[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(ips)).toEqual(new Set([ips[0]]));

    const text = plain(log.text).toLowerCase();
    for (const fragment of ['reset.privacy.person', 'reset.privacy.nobody', 'reset.privacy', '198.18.2.']) {
      expect(text).not.toContain(fragment);
    }
  });
});
