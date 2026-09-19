import { EmailSender, MailSink } from '@proteinjs/email-server';
import { devMail, devMailMessage } from '../src/routes/devMail';

/**
 * `GET /dev/mail` and `GET /dev/mail/<id>` — the dev-only door onto the mail sink, gated exactly
 * like `/dev/login`: `DEVELOPMENT` AND `DEV_AUTO_LOGIN_EMAIL`, else 404 as if unregistered. With
 * the gates open, the last invite a development sender recorded is readable — its link off the
 * list, its rendered html off the message — so a lane never needs a real inbox. No database:
 * the sink is the process's own ring.
 */

const ENV_EMAIL = 'dev@test.local';

type Outcome = { status?: number; body?: unknown; type?: string };

const invoke = async (
  route: typeof devMail,
  { query, params }: { query?: Record<string, unknown>; params?: Record<string, string> } = {}
): Promise<Outcome> => {
  const outcome: Outcome = {};
  const response = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    type(kind: string) {
      outcome.type = kind;
      return this;
    },
    send(body?: unknown) {
      outcome.body = body;
    },
    json(body: unknown) {
      outcome.body = body;
    },
  };
  await route.onRequest({ query: query ?? {}, params: params ?? {} } as never, response as never);
  return outcome;
};

const INVITE_LINK = 'http://localhost:7985/auth/signup?token=abc123';
const INVITE_HTML = `<html><body><p>You are invited.</p><a href="${INVITE_LINK}">Accept</a></body></html>`;

/** The product's path onto the sink: a development sender with a real-looking SMTP config, no opt-in. */
const sendInviteThroughSender = async (to: string): Promise<void> => {
  await new EmailSender({
    host: 'smtp.test.local',
    port: 465,
    secure: true,
    auth: { user: 'mailbox@test.local', pass: 'unused' },
    from: '"Example" <hi@example.com>',
  }).sendEmail({ to, subject: "You're invited", text: `Accept your invite: ${INVITE_LINK}`, html: INVITE_HTML });
};

describe('devMail routes', () => {
  const originalEnv = {
    DEVELOPMENT: process.env.DEVELOPMENT,
    DEV_AUTO_LOGIN_EMAIL: process.env.DEV_AUTO_LOGIN_EMAIL,
    EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
    EMAIL_ALLOW_REAL_SEND: process.env.EMAIL_ALLOW_REAL_SEND,
  };

  beforeEach(() => {
    process.env.DEVELOPMENT = 'true';
    process.env.DEV_AUTO_LOGIN_EMAIL = ENV_EMAIL;
    delete process.env.EMAIL_TRANSPORT;
    delete process.env.EMAIL_ALLOW_REAL_SEND;
    MailSink.get().clear();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("lists the last sent messages newest first — the invite's recipient, subject, first link and timestamp — and the message renders its html", async () => {
    await sendInviteThroughSender('earlier@test.local');
    await sendInviteThroughSender('lane-after@test.local');

    const list = await invoke(devMail);
    expect(list.status).toBe(200);
    const { messages } = list.body as { messages: Array<Record<string, unknown>> };
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      to: ['lane-after@test.local'],
      subject: "You're invited",
      link: INVITE_LINK,
      from: 'hi@example.com',
      refused: true,
    });
    expect(typeof messages[0].id).toBe('string');
    expect(Date.parse(String(messages[0].at))).not.toBeNaN();
    expect(messages[0].url).toBe(`/dev/mail/${messages[0].id}`);
    expect(messages[1].to).toEqual(['earlier@test.local']);

    const message = await invoke(devMailMessage, { params: { id: String(messages[0].id) } });
    expect(message.status).toBe(200);
    expect(message.type).toBe('html');
    expect(message.body).toBe(INVITE_HTML);
  });

  it('?n= bounds the list; a text-only message renders as text; an unknown id is 404', async () => {
    process.env.EMAIL_TRANSPORT = 'sink';
    await new EmailSender({ host: 'h', port: 465, secure: true, from: '"Example" <hi@example.com>' }).sendEmail({
      to: 'a@test.local',
      subject: 'Plain',
      text: 'just text',
    });
    await sendInviteThroughSender('b@test.local');

    const one = await invoke(devMail, { query: { n: '1' } });
    expect((one.body as { messages: unknown[] }).messages).toHaveLength(1);
    const all = await invoke(devMail, { query: { n: 'garbage' } });
    const { messages } = all.body as { messages: Array<{ id: string; subject: string; refused: boolean }> };
    expect(messages.map((m) => m.subject)).toEqual(["You're invited", 'Plain']);
    expect(messages[1].refused).toBe(false);

    const plain = await invoke(devMailMessage, { params: { id: messages[1].id } });
    expect(plain.status).toBe(200);
    expect(plain.type).toBe('text');
    expect(plain.body).toBe('just text');

    expect((await invoke(devMailMessage, { params: { id: 'nope' } })).status).toBe(404);
  });

  it('DEVELOPMENT unset → 404 on both paths, even with messages in the sink', async () => {
    await sendInviteThroughSender('lane@test.local');
    const [record] = MailSink.get().list();
    delete process.env.DEVELOPMENT;

    expect((await invoke(devMail)).status).toBe(404);
    expect((await invoke(devMailMessage, { params: { id: record.id } })).status).toBe(404);
  });

  it('DEV_AUTO_LOGIN_EMAIL unset (or blank) → 404 on both paths', async () => {
    await sendInviteThroughSender('lane@test.local');
    const [record] = MailSink.get().list();

    delete process.env.DEV_AUTO_LOGIN_EMAIL;
    expect((await invoke(devMail)).status).toBe(404);
    expect((await invoke(devMailMessage, { params: { id: record.id } })).status).toBe(404);

    process.env.DEV_AUTO_LOGIN_EMAIL = '   ';
    expect((await invoke(devMail)).status).toBe(404);
  });
});
