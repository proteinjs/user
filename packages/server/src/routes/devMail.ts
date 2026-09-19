import { Route } from '@proteinjs/server-api';
import { MailSink } from '@proteinjs/email-server';

/**
 * DEV-ONLY mail door: reads the process's mail sink (`@proteinjs/email-server` MailSink — the
 * messages a development sender recorded instead of transporting), so automated dev-loop testing
 * reads an invite or reset link from the sink instead of needing a real inbox, and nothing a dev
 * server composes ever has to reach a real address to be verified.
 *
 *   GET /dev/mail[?n=<count>]  the last n messages (default 20, at most MailSink.CAPACITY), newest
 *                              first: id, at, from, to, subject, the body's first link, refused, url
 *   GET /dev/mail/<id>         the rendered message — its html part, or its text part as text/plain
 *
 * Double-gated exactly like `/dev/login` (devLogin.ts), acting only when BOTH hold; otherwise the
 * paths answer 404 as if unregistered:
 * 1. `process.env.DEVELOPMENT` — the dev-server switch, never set in prod images.
 * 2. `DEV_AUTO_LOGIN_EMAIL` — the explicit per-launch dev opt-in.
 */
const DEFAULT_COUNT = 20;

const gatesOpen = (): boolean =>
  !!process.env.DEVELOPMENT && (process.env.DEV_AUTO_LOGIN_EMAIL ?? '').trim().length > 0;

export const devMail: Route = {
  path: '/dev/mail',
  method: 'get',
  onRequest: async (request, response): Promise<void> => {
    if (!gatesOpen()) {
      response.status(404).send();
      return;
    }
    const requested = Number(request.query?.n);
    const count = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MailSink.CAPACITY) : DEFAULT_COUNT;
    const messages = MailSink.get()
      .list(count)
      .map(({ id, at, from, to, subject, link, refused }) => ({
        id,
        at,
        from,
        to,
        subject,
        link,
        refused,
        url: `/dev/mail/${id}`,
      }));
    response.status(200).json({ messages });
  },
};

export const devMailMessage: Route = {
  path: '/dev/mail/:id',
  method: 'get',
  onRequest: async (request, response): Promise<void> => {
    if (!gatesOpen()) {
      response.status(404).send();
      return;
    }
    const record = MailSink.get().get(String(request.params?.id ?? ''));
    if (!record) {
      response.status(404).send();
      return;
    }
    if (record.html !== undefined) {
      response.status(200).type('html').send(record.html);
      return;
    }
    response
      .status(200)
      .type('text')
      .send(record.text ?? '');
  },
};
