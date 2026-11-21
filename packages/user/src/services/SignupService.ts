import { Service, serviceFactory } from '@proteinjs/service';
import { User } from '../tables/UserTable';
import { Invite } from '../tables/InviteTable';

export const getSignupService = serviceFactory<SignupService>('@proteinjs/user/SignupService');

export type SendInviteResponse = {
  sent: boolean;
  error?: string;
};

export type InitializeSignupResponse = {
  isReady: boolean;
  error?: string;
  isInviteOnly?: boolean;
  invite?: Omit<Invite, 'token'>;
};

/**
 * Whether a link that confirms the address went out, and when none did, why not: `tooSoon` (one was
 * mailed within the last few minutes, and it stands), `notSent` (the mail could not be sent) or
 * `alreadyConfirmed` (the address is confirmed: there is nothing to send).
 */
export type ResendEmailVerificationResponse =
  | { sent: true }
  | { sent: false; whyNot: 'tooSoon' | 'notSent' | 'alreadyConfirmed' };

/**
 * Where the session's own account stands with the email confirmation: `waiting` while it is held back
 * until its address is confirmed, `confirmed` once the session answers as its account, `nobody` when the
 * session has no account to answer as (the account is gone or deactivated).
 */
export type EmailConfirmationStateResponse = {
  state: 'waiting' | 'confirmed' | 'nobody';
};

/**
 * The signup route's request body (`routes.signup`). Without an invite token: `email` and `password`;
 * the account is made with an empty name. With an invite token: `name` and `password` (the invite
 * carries the email).
 */
export type UserSignup = Pick<User, 'password'> & {
  email?: User['email'];
  name?: User['name'];
};

/**
 * Account CREATION is not on this interface: signing up establishes a session in the same
 * request (auto-login), and session establishment is a request-level concern services never
 * see — it lives on the `routes.signup` route (user-server `src/routes/signup.ts`), beside
 * login. This service owns the rest of the signup flow: pre-submit initialization and invite
 * management.
 */
export interface SignupService extends Service {
  /** Creates invite record and sends email to the invited user.
   * If invite already exists for the email, it will update the existing record with a new token and send a new email.
   */
  sendInvite(email: string): Promise<SendInviteResponse>;
  /**
   * Re-sends a standing invite: the earlier token stops working, a fresh token and expiry are
   * stamped on the same record, and the invite email is sent again. Refused (`sent: false`, with
   * the reason) when no invite exists for the email or the email already has an account.
   */
  resendInvite(email: string): Promise<SendInviteResponse>;
  /** Deletes invite record associated with the email. */
  revokeInvite(email: string): Promise<void>;
  /**
   * Mails the session's own account a fresh link that confirms its email address: the earlier link
   * stops working. The account is the signed-in one, or, where the product holds an unconfirmed
   * account back, the one that waits in this session. Not sent, with the reason, when the address is
   * already confirmed, when a link was made within the last few minutes, or when the mail could not be
   * sent. For a session that carries an address, never a visitor.
   */
  resendEmailVerification(): Promise<ResendEmailVerificationResponse>;
  /**
   * Whether the session's own account still waits for its address to be confirmed: asked by the
   * confirmation's screen when it comes back to the front (the link may have been opened elsewhere).
   * For a session that carries an address, never a visitor.
   */
  emailConfirmationState(): Promise<EmailConfirmationStateResponse>;
  /**
   * Initializes signup process, validating invite configuration and token if provided.
   * Invite configuration defaults to invite optional.
   * @see `DefaultInviteConfigFactory` for configuring invite setting
   */
  initializeSignup(inviteToken?: string): Promise<InitializeSignupResponse>;
}
