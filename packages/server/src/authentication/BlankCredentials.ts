/**
 * The one sentence a person reads when the email or the password was left blank: on Log in
 * (`routes/login.ts`) and on a sign-up without an invite (`routes/signup.ts`). Kept here so both
 * routes read it and no other place types it.
 */
export class BlankCredentials {
  static readonly REFUSAL = 'Email and password cannot be blank';
}
