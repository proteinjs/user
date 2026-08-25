export { createAuthentication } from './src/authentication/authenticate';
export * from './src/authentication/DbSessionStore';
// The Signup CLASS exports so consumer-app server code can drive the invite domain in-process
// (e.g. n3xa's invite-request resolution minting a real invite through sendInvite) — the same
// single owner the RPC door dispatches to, never a parallel invite-write path.
export { InviteConfig, DefaultInviteConfigFactory, Signup } from './src/services/Signup';
export { AccessInvite } from './src/services/AccessInvite';
export { AccountDeletion } from './src/services/AccountDeletion';
export * from './src/emails/AccountDeletionEmailConfigs';
export { AccountDeletionEmails } from './src/emails/AccountDeletionEmails';
