import { SourceRepository } from '@proteinjs/reflection';
import { Session } from '@proteinjs/server-api';
import { userCache } from '../src/authorization/userCache';

type ObjectCache = { objectCache: Record<string, unknown[]> };

/**
 * Whether a product asks for the mandatory email confirmation: its registration
 * (`DefaultEmailConfirmationConfigFactory`), or none. The suites load src, never the generated source
 * graph, so the lookup is seeded here.
 */
export const productAsksForConfirmation = (asks: boolean): void => {
  (SourceRepository.get() as unknown as ObjectCache).objectCache[
    '@proteinjs/user-server/DefaultEmailConfirmationConfigFactory'
  ] = asks ? [{ getConfig: () => ({ isRequired: true }) }] : [];
};

/**
 * One request as the server seeds it (proteinjs/server loadRoutes): the session's address, and who the
 * request is by the one function that answers it (`userCache`). `undefined` is a visitor's request.
 */
export const requestFrom = async (address: string | undefined): Promise<void> => {
  Session.setData({ sessionId: 'a-session', user: address, data: {} });
  Session.setDataByKey(userCache.key, await userCache.create('a-session', address as string));
};
