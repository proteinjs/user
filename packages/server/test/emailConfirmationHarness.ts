import { SourceRepository } from '@proteinjs/reflection';
import { Session } from '@proteinjs/server-api';
import { userCache } from '../src/authorization/userCache';

type ObjectCache = { objectCache: Record<string, unknown[]> };

/** The confirmation mail as the test's product words it: its subject, and the address that makes its link a full one. */
export const CONFIRMATION_MAIL = { subject: 'Confirm the address', linkBase: 'https://app.test/' };

const RULE = '@proteinjs/user-server/DefaultEmailConfirmationConfigFactory';
const MAIL = '@proteinjs/user-server/DefaultEmailConfirmationLinkEmailConfigFactory';

/**
 * Whether a product asks for the mandatory email confirmation: its registration
 * (`DefaultEmailConfirmationConfigFactory`) with its own words for the confirmation mail
 * (`DefaultEmailConfirmationLinkEmailConfigFactory`), or neither. The suites load src, never the
 * generated source graph, so the lookups are seeded here.
 */
export const productAsksForConfirmation = (asks: boolean): void => {
  const registered = (SourceRepository.get() as unknown as ObjectCache).objectCache;
  registered[RULE] = asks ? [{ getConfig: () => ({ isRequired: true }) }] : [];
  registered[MAIL] = asks
    ? [
        {
          getConfig: () => ({
            subject: CONFIRMATION_MAIL.subject,
            getEmailContent: (link: string) => ({ text: `Confirm: ${CONFIRMATION_MAIL.linkBase}${link}` }),
          }),
        },
      ]
    : [];
};

/** A product that asks for the confirmation and words no mail of its own: the library's plain mail goes. */
export const productWordsNoConfirmationMail = (): void => {
  (SourceRepository.get() as unknown as ObjectCache).objectCache[MAIL] = [];
};

/**
 * One request as the server seeds it (proteinjs/server loadRoutes): the session's address, and who the
 * request is by the one function that answers it (`userCache`). `undefined` is a visitor's request.
 */
export const requestFrom = async (address: string | undefined): Promise<void> => {
  Session.setData({ sessionId: 'a-session', user: address, data: {} });
  Session.setDataByKey(userCache.key, await userCache.create('a-session', address as string));
};
