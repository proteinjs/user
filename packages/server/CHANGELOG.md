# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.13.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.12.0...@proteinjs/user-server@1.13.0) (2026-08-31)


### Features

* last activity = HUMAN PRESENCE, with one owner — the user_activity stamp (founder finding 2026-08-31: a user's routine runs read as their activity on the admin usage surface; 'last activity' must mean a person was HERE, and machinery acting on their behalf must be structurally unable to move it). New scoped table user_activity (one row per user, scope-unique index user_activity_scope_unique; reads ride the 'users' people-management door, writes are system-only so record surfaces cannot fabricate presence; no retain policy — presence purges with the account) + UserActivityStamp in user-server, invoked from userCache.create: the once-per-session-cookie-request session-cache build IS the interactive-transport seam, so background/seeded contexts (runInUserScope seeds session data directly and never passes through) can never stamp, categorically — no per-feature carve-outs. Machine accounts (isLoadedFromSource, e.g. the error bridge's per-poll login) are refused by the stamp even though their requests ride real sessions. Write behavior mirrors DbSessionStore.touch: throttled per user (5 min), fail-open (the promise never rejects; a request never waits on its own stamp), first-stamp races resolved by the unique index. Consumed by thought-server's usage report (lastActiveDay cutover rides that landing). Bite checks ran: the userCache call removed reddens the human-stamp outcome test; the machine refusal dropped reddens the machine test — both restored green. New suite UserActivityStamp.integration.test.ts (5): stamp lands through the real seam, one-row-per-user advance, machine refusal, throttle, missing-account guest no-op. Estate green on a dedicated emulator: user 45, user-server 122 (117 pre-existing + 5 new), auth 20, ui 50. ([bc39960](https://github.com/proteinjs/user/commit/bc39960204df9ae535a3c44646a16da05e622247))





# [1.12.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.11.1...@proteinjs/user-server@1.12.0) (2026-08-29)


### Bug Fixes

* /dev/login rejects a malformed ?email with 400 — an unencoded `+` decoded to a space and minted a stray account ([bdcb724](https://github.com/proteinjs/user/commit/bdcb7244123410f992744c27811761e7d875961f))
* avatar photo fidelity — the server pipeline owns the one resize (founder fuzzy-avatar defect) ([27fb3b7](https://github.com/proteinjs/user/commit/27fb3b77361b1c4e3a0e9f1e2286c1ea9284069f))
* MachineAccounts harness meets db >=1.34.4 — getMachineAccounts maps the new {source, loader} declaration pairs; the test seeds namedObjectCache beside objectCache (objectsWithNames reads only the former — user's next CI red without this); the removal case models IN-PACKAGE removal (a surviving sibling declaration) per the ownership law boot([]) now deliberately protects. HONEST RESIDUE: the re-declare-after-removal leg still reds (sync INSERTs the existing machine-test-ops row instead of adopting — the new sync's adopt query vs the deactivated row's stamps; a user+db semantics call for the mint owners, exact repro in this suite) — 10/11 green, was 1/11 at origin/main against db 1.34.4 ([80f49e6](https://github.com/proteinjs/user/commit/80f49e664e7cbc83e19d092e69d42d7933652efe))
* Roles service refuses to grant break-glass roles — the only path to admin is a manual UPDATE in Spanner Studio ([0c61a40](https://github.com/proteinjs/user/commit/0c61a4041dd0fff6c94715427ad698673026827e))


### Features

* admin-grant-only roles — a catalog declaration ('adminGrantOnly') the Roles service enforces at grant time: such a role can be granted only by a caller holding 'admin'; the ordinary 'roles' grant is refused, fail-closed, before any write or audit row. Revoke stays open to 'roles' holders (the break-glass de-escalation precedent). Motivated by the consumer compliance data-access grant: a user-admin must not be able to hand out access to encrypted-content decryption. ([5244bac](https://github.com/proteinjs/user/commit/5244bacb08dfc86a07ecc871927daf1efa80c9dc))
* export the Signup class from user-server ([37afc7b](https://github.com/proteinjs/user/commit/37afc7be250f0a632c0f1341007d8d2f5c1e5330))
* SweepMalformedAccessGrants — one-shot deploy-gated sweep of access_grant rows with a NULL principal or resource; dangling references reported, never deleted ([59ded5f](https://github.com/proteinjs/user/commit/59ded5f735886cb2800f6402780cd2a7f2b57e08))





## [1.11.1](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.11.0...@proteinjs/user-server@1.11.1) (2026-08-29)


### Bug Fixes

* AccessGrant.principal names its reference table 'user', not the class name — UserTable.name is the class's static JS name ('UserTable'), which deserialize stamped onto every read-back principal, so principal.get() threw (Unable to find table: UserTable) and the admin grant table could never render principals as linked names. Stored cells are bare ids — verified against the live emulator (the raw principal cell is exactly the user id; nothing 'UserTable'-shaped in the row) — so the fix is declaration-only: zero data touched, zero DDL (same STRING(36) column). Tests: user-server emulator suite (stored-bare-id premise, read-back principal resolves the user record, admin/owner insert-gate id-equality pin) + user-ui admin grant-table linked-name rendering bound over the real declaration (the adminInvitedByRendering pattern). Red-before-green: the resolution and rendering legs fail at the pre-fix declaration ('UserTable' stamped on the reference; link at ?table=UserTable). ([037f3ef](https://github.com/proteinjs/user/commit/037f3efd316b56d557c044639f7cd8e044e7d313))





# [1.11.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.10.4...@proteinjs/user-server@1.11.0) (2026-08-29)


### Features

* invitedBy is a real user reference on the user and invite tables — retyped IN PLACE via ReferenceColumn width adoption (db 1.37.0's maxLength option at the column's original 255 width; a reference stores the same id bytes, so deployed rows read back unchanged and the schema sync sees zero DDL — verified against the emulator in @proteinjs/db-driver-spanner's ReferenceColumnAdoptWidth suite). Writers stamp references: sendInvite mints Reference(user, inviter id), createUser carries the invite's reference onto the new account (devLogin's null unchanged); the purge contract holds — a purged inviter leaves the reference dangling, which IS the pseudonymization. Admin payoff: the generic Users/Invites record tables render the inviter as their linked NAME via db-ui's ReferenceCellValue — bound over the real table declarations by the new user-ui suite. Floors: @proteinjs/db ^1.37.0 (user), @proteinjs/db-ui ^1.13.0 (ui); user-ui's jest config adopts the estate singleton pin user-server carries (CI-inert) ([1c5f32a](https://github.com/proteinjs/user/commit/1c5f32a2603f27c41e39e4cfc07f1c3ff17af827))





## [1.10.4](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.10.3...@proteinjs/user-server@1.10.4) (2026-08-28)

**Note:** Version bump only for package @proteinjs/user-server





## [1.10.3](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.10.2...@proteinjs/user-server@1.10.3) (2026-08-28)


### Bug Fixes

* avatar route reads bytes through the driver door — its own access decision, not the gated service read ([0fbf954](https://github.com/proteinjs/user/commit/0fbf95439b11bb4c67ad6109eb7d519d0c8788e1))





## [1.10.2](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.10.1...@proteinjs/user-server@1.10.2) (2026-08-27)


### Bug Fixes

* /dev/login first-hit lands on the login form — diagnosed to runtime passport skew; establishSession now refuses a non-regenerating login instead of silently racing ([a34a85e](https://github.com/proteinjs/user/commit/a34a85e088dcf212d4bb1e79c162b716e8d6a444))





## [1.10.1](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.10.0...@proteinjs/user-server@1.10.1) (2026-08-26)


### Bug Fixes

* MachineAccounts harness meets db >=1.34.4 — getMachineAccounts maps the new {source, loader} declaration pairs; the test seeds namedObjectCache beside objectCache (objectsWithNames reads only the former — user's next CI red without this); the removal case models IN-PACKAGE removal (a surviving sibling declaration) per the ownership law boot([]) now deliberately protects. HONEST RESIDUE: the re-declare-after-removal leg still reds (sync INSERTs the existing machine-test-ops row instead of adopting — the new sync's adopt query vs the deactivated row's stamps; a user+db semantics call for the mint owners, exact repro in this suite) — 10/11 green, was 1/11 at origin/main against db 1.34.4 ([895f5fe](https://github.com/proteinjs/user/commit/895f5fedf47064299f184e7a2a14068bd7acbdd0))





# [1.10.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.9.1...@proteinjs/user-server@1.10.0) (2026-08-26)


### Bug Fixes

* avatar photo fidelity — the server pipeline owns the one resize (founder fuzzy-avatar defect) ([629f411](https://github.com/proteinjs/user/commit/629f411ac614bfe0a1e5c326a647a6de9f212500))


### Features

* export the Signup class from user-server ([117651a](https://github.com/proteinjs/user/commit/117651a920b1d3489bc867e47d010ed5f24e972c))





## [1.9.1](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.9.0...@proteinjs/user-server@1.9.1) (2026-08-23)


### Bug Fixes

* invite links are durable multi-use capabilities — idempotent accept reconciles the grant up to the invite's level; minting requires admin on the resource ([4abb4cc](https://github.com/proteinjs/user/commit/4abb4cc9adacdaa91a499b3ad7134491948b038a))





# [1.9.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.8.0...@proteinjs/user-server@1.9.0) (2026-08-19)


### Bug Fixes

* one owner of session regeneration - passport 0.6's login ([4710711](https://github.com/proteinjs/user/commit/47107112e5903ec52e5a04cb77ba1a4827092c5b))
* regenerate the session id on privilege change (session fixation) ([87c35d9](https://github.com/proteinjs/user/commit/87c35d925f0362ee950f07945df3e4821f8d4ee6))
* the password-reset form renders the account email — password managers had no identifier to update the credential by ([456176a](https://github.com/proteinjs/user/commit/456176accf2960461e1f554e7a20e62ee2d0f08f))


### Features

* auto-login after signup — the signup request now establishes the session ([c505e67](https://github.com/proteinjs/user/commit/c505e6742f9022b6eca23a42c2599e76009f299a))





# [1.8.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.7.0...@proteinjs/user-server@1.8.0) (2026-08-19)


### Bug Fixes

* login response never carries internal error detail — cancel-restore failures answer a generic message and log loudly (no account-state oracle at the login boundary) ([8a60d5f](https://github.com/proteinjs/user/commit/8a60d5f003104821acd5d04c1be0ee003552281a))


### Features

* account deletion — deactivation + manifest, cancel-by-login, purge-retention seam, deletion emails ([6a309c3](https://github.com/proteinjs/user/commit/6a309c32211ad66453cdf3f1b5f558f69ddb883d))
* machine accounts as source records — user-table sync wiring, MachineAccount base, deactivation watcher, credential minting ([93deaa4](https://github.com/proteinjs/user/commit/93deaa44715e484fe98162718048913f5226196a))
* password hashing upgraded to argon2id with transparent per-login migration ([a137d6c](https://github.com/proteinjs/user/commit/a137d6c98f5cf750003046a4e0692c766c53f611))
* user account standing — status/deletion columns, deactivation auth gate, admin SetUserStatus service ([ca4d6f2](https://github.com/proteinjs/user/commit/ca4d6f284b1edcce8717f330988215c4507eb768))





# [1.7.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.6.0...@proteinjs/user-server@1.7.0) (2026-08-15)


### Bug Fixes

* missing-account session resolves to guest instead of downing the process ([711d591](https://github.com/proteinjs/user/commit/711d5917eb4ef034f6fbac24c4b00f6bc9c20d5e))


### Features

* /dev/login?email= — multi-user dev sessions with domain rail and auto-create ([a9b1f73](https://github.com/proteinjs/user/commit/a9b1f733635ab9c7482ee66f05c3ac8f2ac75148))





# [1.6.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.5.4...@proteinjs/user-server@1.6.0) (2026-08-14)


### Bug Fixes

* await session save in devLogin before redirecting ([c7476c8](https://github.com/proteinjs/user/commit/c7476c83a0ad760a9caf55e8d06e2edef9e0f1ac))
* dedupe setupFiles in user-server jest config — merge artifact, both keys named the same setup module ([085a041](https://github.com/proteinjs/user/commit/085a0415397e93354a9aef2d00f24eacf2c13733))


### Features

* user avatars — photo/emoji schema, avatar mutations with session-cache refresh, shared /avatar route ([6af0bc5](https://github.com/proteinjs/user/commit/6af0bc5b34cf42fc3cc47706fc200fd8fdaa8d8d))





## [1.5.4](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.5.3...@proteinjs/user-server@1.5.4) (2026-08-14)

**Note:** Version bump only for package @proteinjs/user-server





## [1.4.5](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.4.3...@proteinjs/user-server@1.4.5) (2026-08-02)


### Bug Fixes

* enforce admin check on sendInvite/revokeInvite (was computed and discarded — both were publicly callable) ([478bde1](https://github.com/proteinjs/user/commit/478bde16edb22646fc24f52896f7e0534ba7e74e))





# [1.4.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.28...@proteinjs/user-server@1.4.0) (2026-07-21)


### Features

* **dev:** GET /dev/login — dev-only session bootstrap for agent-driven testing ([75aa262](https://github.com/proteinjs/user/commit/75aa262a71f639d9c77887e77e1fcabf45ee7120))





## [1.3.28](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.27...@proteinjs/user-server@1.3.28) (2026-07-21)

**Note:** Version bump only for package @proteinjs/user-server





## [1.3.23](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.22...@proteinjs/user-server@1.3.23) (2026-04-10)

**Note:** Version bump only for package @proteinjs/user-server





## [1.3.21](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.20...@proteinjs/user-server@1.3.21) (2026-04-08)

**Note:** Version bump only for package @proteinjs/user-server





## [1.3.18](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.17...@proteinjs/user-server@1.3.18) (2026-02-17)

**Note:** Version bump only for package @proteinjs/user-server





## [1.3.17](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.16...@proteinjs/user-server@1.3.17) (2026-01-04)

**Note:** Version bump only for package @proteinjs/user-server





## [1.3.12](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.11...@proteinjs/user-server@1.3.12) (2025-11-13)

**Note:** Version bump only for package @proteinjs/user-server





## [1.3.10](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.9...@proteinjs/user-server@1.3.10) (2025-10-11)


### Bug Fixes

* use access level from invitation ([#13](https://github.com/proteinjs/user/issues/13)) ([bb3daa3](https://github.com/proteinjs/user/commit/bb3daa32930c1f1191741f49fe904f26e869730a))





## [1.3.9](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.8...@proteinjs/user-server@1.3.9) (2025-10-09)

**Note:** Version bump only for package @proteinjs/user-server





## [1.3.8](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.7...@proteinjs/user-server@1.3.8) (2025-09-28)

**Note:** Version bump only for package @proteinjs/user-server





## [1.3.6](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.5...@proteinjs/user-server@1.3.6) (2025-09-27)

**Note:** Version bump only for package @proteinjs/user-server





## [1.3.5](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.4...@proteinjs/user-server@1.3.5) (2025-09-25)

**Note:** Version bump only for package @proteinjs/user-server





## [1.3.1](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.3.0...@proteinjs/user-server@1.3.1) (2025-08-27)

**Note:** Version bump only for package @proteinjs/user-server





# [1.3.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.2.39...@proteinjs/user-server@1.3.0) (2025-08-26)


### Features

* SharedRecord column type ([#5](https://github.com/proteinjs/user/issues/5)) [skip ci] ([d320303](https://github.com/proteinjs/user/commit/d320303db6a209bd11f08845edff61b136d09859))
* **user:** invites that create access grants when accepted ([#6](https://github.com/proteinjs/user/issues/6)) ([5ee1965](https://github.com/proteinjs/user/commit/5ee196519ebd08ca215aad75257af3b1fc60f778))





## [1.2.34](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.2.33...@proteinjs/user-server@1.2.34) (2025-05-08)


### Bug Fixes

* Email should be case insensitive when managing invites and auth ([9a4179b](https://github.com/proteinjs/user/commit/9a4179b6739dbec144444f5a07beac299df1a1be))





## [1.2.28](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.2.25...@proteinjs/user-server@1.2.28) (2025-02-07)


### Bug Fixes

* add table param to defaultValue, update params for db changes ([#3](https://github.com/proteinjs/user/issues/3)) ([c98e5dc](https://github.com/proteinjs/user/commit/c98e5dcc4a09bf27bfd2cdd877eb0a15b952c56a))





## [1.2.19](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.2.18...@proteinjs/user-server@1.2.19) (2024-10-21)

**Note:** Version bump only for package @proteinjs/user-server





## [1.2.8](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.2.7...@proteinjs/user-server@1.2.8) (2024-08-16)


### Bug Fixes

* `DbSessionStore` needs to bind the sweep method to have access to instance state (like the logger) ([96057f6](https://github.com/proteinjs/user/commit/96057f620f10f0ed9c8de3e6e8202c1e4044eefe))





## [1.2.7](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.2.6...@proteinjs/user-server@1.2.7) (2024-08-16)


### Bug Fixes

* adjust clarity of checking existing pw reset token ([0e7f750](https://github.com/proteinjs/user/commit/0e7f750a2d94fedf051040c7072101f5b97b470b))





## [1.2.6](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.2.5...@proteinjs/user-server@1.2.6) (2024-08-16)


### Bug Fixes

* password reset logic ([a02cab4](https://github.com/proteinjs/user/commit/a02cab41355f0f4484b3351509ec8a113a775317))





## [1.2.4](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.2.3...@proteinjs/user-server@1.2.4) (2024-08-16)


### Bug Fixes

* refactored to implement new @proteinjs/logger/Logger api ([339adf6](https://github.com/proteinjs/user/commit/339adf671db190e157fcaadfb69ac3ba518a2bf1))





# [1.2.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.1.4...@proteinjs/user-server@1.2.0) (2024-08-06)


### Features

* add invite feature and SignupService ([50545d3](https://github.com/proteinjs/user/commit/50545d39c19238e9e1b3ec67c789c3c161860dc8))





# [1.1.0](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.0.35...@proteinjs/user-server@1.1.0) (2024-07-20)


### Features

* added `SocketIOSessionWatcher` to clean up Socket.IO sockets when sessions are destroyed ([37cf6ed](https://github.com/proteinjs/user/commit/37cf6ed3d8d8af20492d4a6ce4d5aa756cf2ab71))





## [1.0.34](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.0.33...@proteinjs/user-server@1.0.34) (2024-07-12)

**Note:** Version bump only for package @proteinjs/user-server





## [1.0.27](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.0.26...@proteinjs/user-server@1.0.27) (2024-06-27)

**Note:** Version bump only for package @proteinjs/user-server





## [1.0.14](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.0.13...@proteinjs/user-server@1.0.14) (2024-05-10)


### Bug Fixes

* add .md file type to lint ignore files ([372c51f](https://github.com/proteinjs/user/commit/372c51fdc0a48c8559321862e3b7cebe05e4955d))





## [1.0.13](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.0.12...@proteinjs/user-server@1.0.13) (2024-05-10)


### Bug Fixes

* `userCache` should not contain the password hash ([90abf84](https://github.com/proteinjs/user/commit/90abf84e75e0ef1cd9bb07a789a65ef43a527e24))





## [1.0.12](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.0.11...@proteinjs/user-server@1.0.12) (2024-05-10)

### Bug Fixes

- add linting and lint all files ([71defcd](https://github.com/proteinjs/user/commit/71defcd78dc479d2eef1f624c746c879f4e31daa))

## [1.0.10](https://github.com/proteinjs/user/compare/@proteinjs/user-server@1.0.9...@proteinjs/user-server@1.0.10) (2024-05-09)

### Bug Fixes

- do not name a column the same name as a table ([1442a9f](https://github.com/proteinjs/user/commit/1442a9f665f88feafa8ccb83631ef2fb7d741f20))

## 1.0.1 (2024-04-19)

**Note:** Version bump only for package @proteinjs/user-server
