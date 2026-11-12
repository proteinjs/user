import { createHash } from 'crypto';
import moment, { Moment } from 'moment';
import { getDbAsSystem, QueryBuilderFactory } from '@proteinjs/db';
import { AuthChallenge, AuthChallengeKind, tables } from '@proteinjs/user';
import { MailedTokenValue } from '../MailedTokenValue';

/**
 * What a sign-in step's challenge was made for:
 * - `signin` — the passkey step of a sign-in, for an account that has a passkey;
 * - `first` — the first passkey's registration inside a sign-in, for an account that has none.
 */
export type SignInChallengePurpose = 'signin' | 'first';

/**
 * What a challenge made inside a session was made for:
 * - `confirm-add`, `confirm-remove`, `confirm-reset` — a signed-in person's fresh assertion before
 *   an act on passkeys: adding one, removing one (the challenge names which), resetting another
 *   person's (the challenge names whose);
 * - `add` — a signed-in person's registration of a passkey.
 */
export type SessionChallengePurpose = 'confirm-add' | 'confirm-remove' | 'confirm-reset' | 'add';

/** What a challenge was made for. A challenge made for one purpose is refused for any other. */
export type AuthChallengePurpose = SignInChallengePurpose | SessionChallengePurpose;

/** What a sign-in step's challenge row remembers between the step's two requests (the row's `payload`). */
export type AuthChallengePayload = {
  /** The WebAuthn challenge the authenticator signs, base64url. */
  challenge: string;
  purpose: SignInChallengePurpose;
  /** When the password was proven (ISO 8601): the step's five minutes run from here, however many challenges it takes. */
  passwordProvenAt: string;
  /** Which try of the step this challenge is: 1, then one more for each refusal answered with a new challenge. */
  attempt: number;
};

/** What a challenge made inside a session remembers besides its WebAuthn challenge. */
export type SessionChallengeMemo = {
  /** A confirmation of a removal or a reset: the passkey or the person it was made for. */
  subject?: string;
  /** An add: whether a confirmation was proven when it began — the account had a passkey then. */
  confirmed?: boolean;
};

/** The row's `payload` for a challenge made inside a session. */
type SessionChallengePayload = SessionChallengeMemo & {
  challenge: string;
  purpose: SessionChallengePurpose;
  /** The SHA-256 of the id of the session the challenge was made in, hex: the id itself is a credential and is not kept. */
  session: string;
};

/** Who a challenge made inside a session is for: the account, the session it was made in, and the purpose. */
export type SessionChallengeHolder = { userId: string; sessionId: string; purpose: SessionChallengePurpose };

/** A challenge to mint: its kind, the account it is for, what it remembers, and when it lapses. */
export type AuthChallengeMint = {
  kind: AuthChallengeKind;
  userId: string;
  payload: AuthChallengePayload;
  expiresAt: Moment;
};

/** A challenge a claim took: spent by the claim, whatever happens next. */
export type ClaimedAuthChallenge = { userId: string; payload: AuthChallengePayload; expiresAt: Moment };

/** A challenge made inside a session, as a claim by its holder took it: the WebAuthn challenge and what it remembered. */
export type ClaimedSessionChallenge = SessionChallengeMemo & { challenge: string };

/**
 * The ONE owner of the `auth_challenge` rows: the table has no door on either api, so every read
 * and write of it is made here, as system, and nowhere else in the package.
 *
 * A challenge is handed out as a token — a bearer value of the mailed tokens' shape and form at
 * rest (`MailedTokenValue`: 32 bytes of the platform CSPRNG; the row holds its SHA-256, never the
 * token, so a read of the table yields nothing that can be presented). It is single-use: a claim
 * is ONE conditional update that stamps `consumedAt` where it is empty, the kind is the one named
 * and the row has not lapsed — so two presentations of one token cannot both claim it, and a row a
 * claim took is spent whether the step it opens then passes or fails. A claim answers the row
 * only when it was made for the purpose named; the account a row names is the only account a
 * claimed challenge speaks for.
 *
 * A challenge made INSIDE A SESSION (`mintInSession`) is bound to that session as well: the row
 * remembers the SHA-256 of the session's id, and `claimInSession` answers it only to the same
 * account in the same session, for the same purpose. It lives five minutes from its minting.
 */
export class AuthChallenges {
  /** The life of a challenge made inside a session, from its minting. */
  private static readonly SESSION_LIFE_MINUTES = 5;

  /** Mint a challenge; resolves to its token — the only time the token exists on the server. */
  async mint(challenge: AuthChallengeMint): Promise<string> {
    return await this.insert(challenge.kind, challenge.userId, challenge.payload, challenge.expiresAt);
  }

  /**
   * Mint a challenge inside a session, for `holder` alone: `challenge` is the WebAuthn challenge
   * the authenticator signs, `memo` what else the row remembers. Resolves to its token.
   */
  async mintInSession(
    kind: AuthChallengeKind,
    holder: SessionChallengeHolder,
    challenge: string,
    memo: SessionChallengeMemo = {}
  ): Promise<string> {
    const payload: SessionChallengePayload = {
      ...memo,
      challenge,
      purpose: holder.purpose,
      session: this.sessionDigest(holder.sessionId),
    };
    return await this.insert(
      kind,
      holder.userId,
      payload,
      moment().add(AuthChallenges.SESSION_LIFE_MINUTES, 'minutes')
    );
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
    purpose: SignInChallengePurpose
  ): Promise<ClaimedAuthChallenge | undefined> {
    const row = await this.take(presented, kind);
    const payload = row?.payload as AuthChallengePayload | undefined;
    if (!row?.userId || payload?.purpose !== purpose) {
      return undefined;
    }

    return { userId: row.userId, payload, expiresAt: row.expiresAt };
  }

  /**
   * Claim a challenge made inside a session, as `holder`: resolves to what it remembers only when
   * the row was minted for this account, in this session, for this purpose — and to undefined for
   * everything `claim` refuses, for another account's challenge, for one made in another session
   * and for one made for another purpose (each of which the claim has then spent).
   */
  async claimInSession(
    presented: unknown,
    kind: AuthChallengeKind,
    holder: SessionChallengeHolder
  ): Promise<ClaimedSessionChallenge | undefined> {
    const session = this.sessionDigest(holder.sessionId);
    const row = await this.take(presented, kind);
    const payload = row?.payload as SessionChallengePayload | undefined;
    if (
      !row ||
      !payload ||
      row.userId !== holder.userId ||
      payload.purpose !== holder.purpose ||
      payload.session !== session
    ) {
      return undefined;
    }

    return { challenge: payload.challenge, subject: payload.subject, confirmed: payload.confirmed };
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

  /** Write one challenge row; resolves to its token. */
  private async insert(kind: AuthChallengeKind, userId: string, payload: object, expiresAt: Moment): Promise<string> {
    const token = MailedTokenValue.mint();
    await getDbAsSystem().insert(tables.AuthChallenge, {
      kind,
      tokenHash: MailedTokenValue.digest(token),
      userId,
      payload,
      expiresAt,
    });
    return token;
  }

  /**
   * THE claim: one conditional update that spends the row `presented` names when it is of `kind`,
   * unclaimed and unlapsed. Resolves to the spent row, or undefined when the update took none.
   */
  private async take(presented: unknown, kind: AuthChallengeKind): Promise<AuthChallenge | undefined> {
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

    return await db.get(tables.AuthChallenge, { tokenHash });
  }

  /** The rows no claim has taken — the start of every conditional write. */
  private open() {
    return new QueryBuilderFactory()
      .getQueryBuilder<AuthChallenge>(tables.AuthChallenge)
      .condition({ field: 'consumedAt', operator: 'IS NULL' });
  }

  /** The name a row knows its session by: the SHA-256 of the session's id (plain, not the keyed log digest). */
  private sessionDigest(sessionId: string): string {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('A challenge made inside a session names the session it is for: no session id was given');
    }

    return createHash('sha256').update(sessionId).digest('hex');
  }
}
