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
// The product's part in the Log in and Sign up pages (its closed state's words), registered by the product.
export * from './src/auth/AuthPageProduct';
export type { AuthFieldErrors } from './src/auth/AuthValidation';
// What a navigation to the login page may carry (`{ message }`, the page's message seat).
export type { LoginLocationState } from './src/pages/Login';
