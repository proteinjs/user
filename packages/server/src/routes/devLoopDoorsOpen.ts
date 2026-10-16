/**
 * The dev-loop doors' switch, read in ONE place. A door (`/dev/login` and its kin) is open when either
 * holds; a deployment outside development sets neither name:
 * - `DEVELOPMENT` — the WHOLE dev-server switch (a developer's own server: its local stores, its log
 *   writer, its middleware all ride on it), never set in a deployed image.
 * - `DEV_LOOP_DOORS` — the doors' OWN switch, for a hosted development deployment: it runs the
 *   production shape (real stores, the production middleware) and so can never carry `DEVELOPMENT`,
 *   yet it is where the dev loop's agent-driven proofs sign in, so its doors must open.
 * Either is read the way the doors always read `DEVELOPMENT`: present and non-empty = set. Each door
 * keeps its own second gate (`DEV_AUTO_LOGIN_EMAIL`, the explicit per-launch opt-in) on top.
 */
export const devLoopDoorsOpen = (env: NodeJS.ProcessEnv): boolean => Boolean(env.DEVELOPMENT || env.DEV_LOOP_DOORS);
