/**
 * THE LOG-IN AND SIGN-UP DOORS READ THEIR BODY AS JSON AND AS NOTHING ELSE (`routes/login.ts`,
 * `routes/signup.ts`). JSON is how the sign-in pages send it (user-ui `AuthApi`), and a browser lets a
 * page send JSON only to the page's own site. A body that says it is anything else, a form's among
 * them, is answered with `REFUSAL_STATUS` before anything of it is read: no account is looked up, made
 * or signed in.
 */
export class JsonBody {
  /** What a door answers a body that was not sent as JSON: 415, unsupported media type. */
  static readonly REFUSAL_STATUS = 415;
  /** The reason a door's log line carries for that answer. */
  static readonly REFUSAL = 'The body was not sent as JSON';

  /** Whether the request says its body is JSON: its content type is `application/json`, whatever parameters follow. */
  static sentBy(request: { headers?: Record<string, unknown> }): boolean {
    const contentType = request.headers?.['content-type'];
    return typeof contentType === 'string' && contentType.split(';')[0].trim().toLowerCase() === 'application/json';
  }
}
