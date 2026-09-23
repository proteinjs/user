export * from './src/AuthenticatedPageContainer';
export * from './src/pageAuth';
export * from './src/presence/UserPresenceReporter';
export * from './src/presence/installUserPresenceReporter';

// The logged-out surface's building blocks, exported so a consumer app's own public pages
// (e.g. a /request-invite page) render with the same auth look instead of forking the styling.
export * from './src/auth/AuthLayout';
export * from './src/auth/AuthTextField';
export * from './src/auth/AuthButton';
export * from './src/auth/AuthFormError';
export * from './src/auth/AuthMessagePanel';
// The form reader the pages above use at submit (uncontrolled fields; the values read from the
// form itself) — exported so a consumer page fixes the same class the same way, not by hand.
export * from './src/auth/AuthFormFields';
export type { AuthFieldErrors } from './src/auth/AuthValidation';
