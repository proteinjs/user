import { LogCapture } from './LogCapture';

/**
 * The log capture's address reader — what `expect(log.addresses).toEqual([])` stands on. It reads
 * an address in every spelling a log line can carry: bare, inside a name-and-address form, and
 * URL-encoded (`%40` for the `@`, `%2B` for a `+`) as a logged request path carries it. A digest
 * or a bare domain is not an address.
 */
describe('LogCapture.addresses', () => {
  it('reads an address bare, in a name-and-address form, and URL-encoded in a logged path', async () => {
    const log = await LogCapture.during(async () => {
      console.log('Email sent successfully to ada@example.com');
      console.info('Invite from "Grace" <grace.hopper@example.org>');
      console.info('Started /dev/login?email=ada%2Blane%40example.com');
      console.warn('Sign-in refused', { account: '0123456789abcdef', domain: 'example.com' });
    });

    expect(log.addresses).toEqual(['ada@example.com', 'grace.hopper@example.org', 'ada%2Blane%40example.com']);
  });

  it('reads nothing from a log that names people by digest and domain only', async () => {
    const log = await LogCapture.during(async () => {
      console.info('Email sent — 1 recipient (example.com)', { recipients: ['0123456789abcdef'] });
      console.info('Finished /user/login 200');
    });

    expect(log.addresses).toEqual([]);
  });
});
