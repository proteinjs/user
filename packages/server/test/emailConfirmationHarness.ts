import { SourceRepository } from '@proteinjs/reflection';

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
