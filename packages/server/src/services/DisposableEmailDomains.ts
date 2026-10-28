/**
 * The common throwaway-mail domains — inboxes anyone can open or that are minted on demand with
 * nobody behind them — so a sign-up from one is an account whose mail no one reads. A short list
 * in code, no vendor, applied on the no-invite road before the guard: a deliverability check
 * refuses only a domain that takes no mail, and a throwaway on a real domain passes it; this list
 * is the other half. Written 2026-10-28.
 *
 * The rule for adding a domain: it goes on the list when its service describes itself as
 * temporary, disposable or anonymous mail — addresses with no owner, read by whoever asks — and
 * never when people hold their own mailboxes there (a webmail, a school, a company, a forwarding
 * service with an owner behind each alias). Keep it short: the list carries the names that
 * actually show up at the door, and a consumer's guard bounds the rest. Entries are lowercase
 * registrable domains, one per line; a subdomain of a listed domain is refused with it.
 */
export class DisposableEmailDomains {
  /** The one sentence a refused address is told — read by the person, shown in full. */
  static readonly REFUSAL = 'Use an email address you can read mail at.';

  private static readonly DOMAINS: ReadonlySet<string> = new Set([
    '10minemail.com',
    '10minutemail.com',
    '10minutemail.net',
    'anonbox.net',
    'burnermail.io',
    'cool.fr.nf',
    'courriel.fr.nf',
    'crazymailing.com',
    'discard.email',
    'dispostable.com',
    'dropmail.me',
    'emailfake.com',
    'emailondeck.com',
    'fakeinbox.com',
    'fakemail.net',
    'generator.email',
    'getairmail.com',
    'getnada.com',
    'grr.la',
    'guerrillamail.biz',
    'guerrillamail.com',
    'guerrillamail.de',
    'guerrillamail.net',
    'guerrillamail.org',
    'guerrillamailblock.com',
    'harakirimail.com',
    'inboxkitten.com',
    'jetable.fr.nf',
    'jetable.org',
    'mail-temp.com',
    'mail7.io',
    'mailcatch.com',
    'maildrop.cc',
    'mailexpire.com',
    'mailin8r.com',
    'mailinater.com',
    'mailinator.com',
    'mailinator2.com',
    'mailnesia.com',
    'mailpoof.com',
    'mailsac.com',
    'mailtemp.net',
    'mega.zik.dj',
    'meltmail.com',
    'mintemail.com',
    'mohmal.com',
    'moncourrier.fr.nf',
    'monemail.fr.nf',
    'monmail.fr.nf',
    'mytemp.email',
    'nomail.xl.cx',
    'nospam.ze.tc',
    'pokemail.net',
    'sharklasers.com',
    'sogetthis.com',
    'spam4.me',
    'spambox.us',
    'speed.1s.fr',
    'temp-mail.io',
    'temp-mail.org',
    'tempail.com',
    'tempinbox.com',
    'tempmail.com',
    'tempmail.dev',
    'tempmailo.com',
    'tempr.email',
    'throwawaymail.com',
    'trashmail.com',
    'trashmail.me',
    'trashmail.net',
    'yopmail.com',
    'yopmail.fr',
    'yopmail.net',
  ]);

  /** Whether the address's domain is a listed domain or a subdomain of one; the case of the address does not matter. */
  isDisposable(email: string): boolean {
    const domain = this.domainOf(email);
    if (!domain) {
      return false;
    }

    // `mail.mailinator.com` is refused with `mailinator.com`: every suffix at a label boundary
    // is looked up, so a domain that merely ends with a listed name (`notmailinator.com`) is not.
    const labels = domain.split('.');
    for (let start = 0; start < labels.length - 1; start++) {
      if (DisposableEmailDomains.DOMAINS.has(labels.slice(start).join('.'))) {
        return true;
      }
    }
    return false;
  }

  /** The part after the last `@`, trimmed and lowercased; undefined when there is none. */
  private domainOf(email: string): string | undefined {
    const at = email.lastIndexOf('@');
    if (at < 0) {
      return undefined;
    }
    const domain = email
      .slice(at + 1)
      .trim()
      .toLowerCase();
    return domain || undefined;
  }
}
