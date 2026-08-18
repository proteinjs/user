import { Route } from '@proteinjs/server-api';
import { routes } from '@proteinjs/user';
import { authenticate } from '../authentication/authenticate';
import { AccountDeletion } from '../services/AccountDeletion';

export const login: Route = {
  path: routes.login.path,
  method: routes.login.method,
  onRequest: async (request: any, response): Promise<void> => {
    const credentials: { email: string; password: string } = request.body;
    if (!credentials.email || !credentials.password) {
      const error = `Email and password cannot be blank`;
      console.error(error);
      response.send({ error });
      return;
    }

    const result = await authenticate(credentials.email, credentials.password);
    if (result !== true) {
      console.error(result);
      response.send({ error: result });
      return;
    }

    // Cancel-by-login: a pending-deletion account's successful authentication IS the cancel
    // signal. The restore runs synchronously here, BEFORE request.login, so the first
    // authenticated paint sees the fully restored account (no transient).
    const outcome = await new AccountDeletion().cancelPendingDeletion(credentials.email);
    if (outcome === 'purging') {
      const error = 'This account is being deleted and can no longer be restored.';
      console.error(error);
      response.send({ error });
      return;
    }

    await new Promise((resolve, reject) => {
      request.login(credentials.email, resolve);
    });
    response.send({});
  },
};
