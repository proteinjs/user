import { DateTimeColumn, ObjectColumn, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { Moment } from 'moment';

/** What a challenge is for: a passkey's registration or a passkey's sign-in assertion. */
export const AUTH_CHALLENGE_KINDS = ['webauthn_register', 'webauthn_login'] as const;
export type AuthChallengeKind = (typeof AUTH_CHALLENGE_KINDS)[number];

/**
 * A short-lived, single-use challenge of a sign-in step. The client holds a random token; the row
 * holds only the token's SHA-256 (`tokenHash`), so a read of the table cannot replay one. A claim
 * stamps `consumedAt` once, and only while the row is unexpired and of the kind the claim names;
 * expired rows are swept. What a step needs to remember between its two requests rides in
 * `payload`, never in a new column.
 *
 * A plain record, not a scoped one: a challenge can be minted before any account is signed in, and
 * it outlives nothing — the sweep removes it whatever account it named. No door on either api, the
 * admin included (`query: []` admits nobody, and the other operations of a declared block stay
 * closed): every read and write is the server's own, made as system.
 */
export type AuthChallenge<Payload extends object = object> = Record & {
  kind: AuthChallengeKind;
  /** SHA-256 of the token handed to the client, hex. The token itself is never stored. */
  tokenHash: string;
  /** The account the challenge was minted for, when one is known. */
  userId?: string | null;
  payload: Payload;
  expiresAt: Moment;
  consumedAt?: Moment | null;
};

export class AuthChallengeTable extends Table<AuthChallenge> {
  name = 'auth_challenge';
  auth: Table<AuthChallenge>['auth'] = {
    db: {
      query: [],
    },
    service: {
      query: [],
    },
  };
  indexes = [
    { name: 'auth_challenge_token_hash_unique', columns: ['tokenHash'] as (keyof AuthChallenge)[], unique: true },
    // An account's challenges of one kind: the open ones voided together when the account enrolls
    // its first passkey (user-server `AuthChallenges.voidOthers`), and the ones a session holds for
    // a purpose, replaced when it begins that step again (`AuthChallenges.mintInSession`).
    { name: 'auth_challenge_user_id_kind', columns: ['userId', 'kind'] as (keyof AuthChallenge)[] },
    // The expiry sweep (user-server `AuthChallenges.sweep`, on the session store's interval).
    { name: 'auth_challenge_expires_at', columns: ['expiresAt'] as (keyof AuthChallenge)[] },
  ];
  columns: Table<AuthChallenge>['columns'] = withRecordColumns<AuthChallenge>({
    kind: new StringColumn<AuthChallengeKind>('kind', {}, 32),
    tokenHash: new StringColumn('token_hash', {}, 64),
    userId: new StringColumn('user_id', {}, 36),
    payload: new ObjectColumn<object>('payload'),
    expiresAt: new DateTimeColumn('expires_at'),
    consumedAt: new DateTimeColumn('consumed_at'),
  });
}
