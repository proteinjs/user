import moment, { Moment } from 'moment';
import { getDbAsSystem, QueryBuilderFactory } from '@proteinjs/db';
import { AuthChallenge, AuthChallengeKind, tables } from '@proteinjs/user';
import { MailedTokenValue } from '../MailedTokenValue';

/**
 * What a challenge was made for. A challenge made for one purpose is refused for any other:
 * - `signin` — the passkey step of a sign-in, for an account that has a passkey;
 * - `first` — the first passkey's registration inside a sign-in, for an account that has none.
 */
export type AuthChallengePurpose = 'signin' | 'first';

/** What a challenge row remembers between a step's two requests (the row's `payload`). */
export type AuthChallengePayload = {
  /** The WebAuthn challenge the authenticator signs, base64url. */
  challenge: string;
  purpose: AuthChallengePurpose;
  /** When the password was proven (ISO 8601): the step's five minutes run from here, however many challenges it takes. */
  passwordProvenAt: string;
  /** Which try of the step this challenge is: 1, then one more for each refusal answered with a new challenge. */
  attempt: number;
};

/** A challenge to mint: its kind, the account it is for, what it remembers, and when it lapses. */
export type AuthChallengeMint = {
  kind: AuthChallengeKind;
  userId: string;
  payload: AuthChallengePayload;
  expiresAt: Moment;
};

/** A challenge a claim took: spent by the claim, whatever happens next. */
export type ClaimedAuthChallenge = { userId: string; payload: AuthChallengePayload; expiresAt: Moment };

/**
 * The ONE owner of the `auth_challenge` rows: the table has no door on either api, so every read
 * and write of it is made here, as system, and nowhere else in the package.
 *
 * A challenge is handed out as a token — a bearer value of the mailed tokens' shape and form at
 * rest (`MailedTokenValue`: 32 bytes of the platform CSPRNG; the row holds its SHA-256, never the
 * token, so a read of the table yields nothing that can be presented). It is single-use: `claim`
 * is ONE conditional update that stamps `consumedAt` where it is empty, the kind is the one named
 * and the row has not lapsed — so two presentations of one token cannot both claim it, and a row a
 * claim took is spent whether the step it opens then passes or fails. A claim answers the row
 * only when it was made for the purpose named; the account a row names is the only account a
 * claimed challenge speaks for.
 */
export class AuthChallenges {
  /** Mint a challenge; resolves to its token — the only time the token exists on the server. */
  async mint(challenge: AuthChallengeMint): Promise<string> {
    const token = MailedTokenValue.mint();
    await getDbAsSystem().insert(tables.AuthChallenge, {
      kind: challenge.kind,
      tokenHash: MailedTokenValue.digest(token),
      userId: challenge.userId,
      payload: challenge.payload,
      expiresAt: challenge.expiresAt,
    });
    return token;
  }

  /**
   * Claim the challenge `presented` names: of `kind`, unclaimed and unlapsed, made for `purpose`.
   * Resolves to what it remembers, or undefined when there is nothing to claim — a value that is
   * not a token (refused before any lookup), an unknown one, one already claimed, a lapsed one,
   * one of another kind, or one made for another purpose (which the claim has then spent).
   */
  async claim(
    presented: unknown,
    kind: AuthChallengeKind,
    purpose: AuthChallengePurpose
  ): Promise<ClaimedAuthChallenge | undefined> {
    const token = MailedTokenValue.parse(presented);
    if (token === undefined) {
      return undefined;
    }

    const db = getDbAsSystem();
    const tokenHash = MailedTokenValue.digest(token);
    const now = moment();
    const open = this.open()
      .condition({ field: 'tokenHash', operator: '=', value: tokenHash })
      .condition({ field: 'kind', operator: '=', value: kind })
      .condition({ field: 'expiresAt', operator: '>', value: now });
    if ((await db.update(tables.AuthChallenge, { consumedAt: now }, open)) !== 1) {
      return undefined;
    }

    const row = await db.get(tables.AuthChallenge, { tokenHash });
    const payload = row?.payload as AuthChallengePayload | undefined;
    if (!row?.userId || payload?.purpose !== purpose) {
      return undefined;
    }

    return { userId: row.userId, payload, expiresAt: row.expiresAt };
  }

  /**
   * Void every challenge of `kind` still open for the account — the ones a claim has not taken:
   * what an account's first enrollment does to its other register challenges, so one handed out
   * before the account enrolled opens nothing after. Resolves to the number voided.
   */
  async voidOthers(userId: string, kind: AuthChallengeKind): Promise<number> {
    const others = this.open()
      .condition({ field: 'userId', operator: '=', value: userId })
      .condition({ field: 'kind', operator: '=', value: kind });
    return await getDbAsSystem().update(tables.AuthChallenge, { consumedAt: moment() }, others);
  }

  /** Remove the rows that have lapsed, claimed or not; resolves to the number removed. */
  async sweep(): Promise<number> {
    const db = getDbAsSystem();
    if (!(await db.tableExists(tables.AuthChallenge))) {
      return 0;
    }

    const lapsed = new QueryBuilderFactory()
      .getQueryBuilder(tables.AuthChallenge)
      .condition({ field: 'expiresAt', operator: '<=', value: moment() });
    return await db.delete(tables.AuthChallenge, lapsed);
  }

  /** The rows no claim has taken — the start of every conditional write. */
  private open() {
    return new QueryBuilderFactory()
      .getQueryBuilder<AuthChallenge>(tables.AuthChallenge)
      .condition({ field: 'consumedAt', operator: 'IS NULL' });
  }
}
