# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.17.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.16.0...@proteinjs/user@1.17.0) (2026-09-02)


### Features

* explicit machine column on the user table (founder ruling 2026-09-02) — one owner for 'is this a machine' ([8a09b6e](https://github.com/proteinjs/user/commit/8a09b6ec618646ad96b466385a6f56dd19c04a88))





# [1.16.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.15.0...@proteinjs/user@1.16.0) (2026-09-01)


### Features

* admin row scans declare what a human reads; user.status retires the legacy null ([d748b71](https://github.com/proteinjs/user/commit/d748b714d21ccccb68626fea3895c1112595bd0c))





# [1.15.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.14.0...@proteinjs/user@1.15.0) (2026-08-31)


### Features

* shared-scope encryption key owners — the encryption-sharing MVP (TRUST_AND_COMPLIANCE §4/§4.4): SharedRecord rows key by the SCOPE-ROOT OWNER, and a share grant extends decrypt + blind-index search to the recipient ([6f5d0db](https://github.com/proteinjs/user/commit/6f5d0dbd1e56d2b0bf0236b138af50164b244b3c))





# [1.14.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.13.0...@proteinjs/user@1.14.0) (2026-08-31)


### Features

* last activity = HUMAN PRESENCE, with one owner — the user_activity stamp (founder finding 2026-08-31: a user's routine runs read as their activity on the admin usage surface; 'last activity' must mean a person was HERE, and machinery acting on their behalf must be structurally unable to move it). New scoped table user_activity (one row per user, scope-unique index user_activity_scope_unique; reads ride the 'users' people-management door, writes are system-only so record surfaces cannot fabricate presence; no retain policy — presence purges with the account) + UserActivityStamp in user-server, invoked from userCache.create: the once-per-session-cookie-request session-cache build IS the interactive-transport seam, so background/seeded contexts (runInUserScope seeds session data directly and never passes through) can never stamp, categorically — no per-feature carve-outs. Machine accounts (isLoadedFromSource, e.g. the error bridge's per-poll login) are refused by the stamp even though their requests ride real sessions. Write behavior mirrors DbSessionStore.touch: throttled per user (5 min), fail-open (the promise never rejects; a request never waits on its own stamp), first-stamp races resolved by the unique index. Consumed by thought-server's usage report (lastActiveDay cutover rides that landing). Bite checks ran: the userCache call removed reddens the human-stamp outcome test; the machine refusal dropped reddens the machine test — both restored green. New suite UserActivityStamp.integration.test.ts (5): stamp lands through the real seam, one-row-per-user advance, machine refusal, throttle, missing-account guest no-op. Estate green on a dedicated emulator: user 45, user-server 122 (117 pre-existing + 5 new), auth 20, ui 50. ([bc39960](https://github.com/proteinjs/user/commit/bc39960204df9ae535a3c44646a16da05e622247))





# [1.13.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.12.1...@proteinjs/user@1.13.0) (2026-08-29)


### Bug Fixes

* AccessGrant well-formedness invariant — refuse a grant with no principal or resource id; session-less scope roots mint no grant ([a330784](https://github.com/proteinjs/user/commit/a330784543c3bfa989e86de15f50807260a3e42a))
* avatar photo fidelity — the server pipeline owns the one resize (founder fuzzy-avatar defect) ([27fb3b7](https://github.com/proteinjs/user/commit/27fb3b77361b1c4e3a0e9f1e2286c1ea9284069f))
* MachineAccounts harness meets db >=1.34.4 — getMachineAccounts maps the new {source, loader} declaration pairs; the test seeds namedObjectCache beside objectCache (objectsWithNames reads only the former — user's next CI red without this); the removal case models IN-PACKAGE removal (a surviving sibling declaration) per the ownership law boot([]) now deliberately protects. HONEST RESIDUE: the re-declare-after-removal leg still reds (sync INSERTs the existing machine-test-ops row instead of adopting — the new sync's adopt query vs the deactivated row's stamps; a user+db semantics call for the mint owners, exact repro in this suite) — 10/11 green, was 1/11 at origin/main against db 1.34.4 ([80f49e6](https://github.com/proteinjs/user/commit/80f49e664e7cbc83e19d092e69d42d7933652efe))


### Features

* admin-grant-only roles — a catalog declaration ('adminGrantOnly') the Roles service enforces at grant time: such a role can be granted only by a caller holding 'admin'; the ordinary 'roles' grant is refused, fail-closed, before any write or audit row. Revoke stays open to 'roles' holders (the break-glass de-escalation precedent). Motivated by the consumer compliance data-access grant: a user-admin must not be able to hand out access to encrypted-content decryption. ([5244bac](https://github.com/proteinjs/user/commit/5244bacb08dfc86a07ecc871927daf1efa80c9dc))





## [1.12.1](https://github.com/proteinjs/user/compare/@proteinjs/user@1.12.0...@proteinjs/user@1.12.1) (2026-08-29)


### Bug Fixes

* AccessGrant.principal names its reference table 'user', not the class name — UserTable.name is the class's static JS name ('UserTable'), which deserialize stamped onto every read-back principal, so principal.get() threw (Unable to find table: UserTable) and the admin grant table could never render principals as linked names. Stored cells are bare ids — verified against the live emulator (the raw principal cell is exactly the user id; nothing 'UserTable'-shaped in the row) — so the fix is declaration-only: zero data touched, zero DDL (same STRING(36) column). Tests: user-server emulator suite (stored-bare-id premise, read-back principal resolves the user record, admin/owner insert-gate id-equality pin) + user-ui admin grant-table linked-name rendering bound over the real declaration (the adminInvitedByRendering pattern). Red-before-green: the resolution and rendering legs fail at the pre-fix declaration ('UserTable' stamped on the reference; link at ?table=UserTable). ([037f3ef](https://github.com/proteinjs/user/commit/037f3efd316b56d557c044639f7cd8e044e7d313))





# [1.12.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.11.0...@proteinjs/user@1.12.0) (2026-08-29)


### Features

* invitedBy is a real user reference on the user and invite tables — retyped IN PLACE via ReferenceColumn width adoption (db 1.37.0's maxLength option at the column's original 255 width; a reference stores the same id bytes, so deployed rows read back unchanged and the schema sync sees zero DDL — verified against the emulator in @proteinjs/db-driver-spanner's ReferenceColumnAdoptWidth suite). Writers stamp references: sendInvite mints Reference(user, inviter id), createUser carries the invite's reference onto the new account (devLogin's null unchanged); the purge contract holds — a purged inviter leaves the reference dangling, which IS the pseudonymization. Admin payoff: the generic Users/Invites record tables render the inviter as their linked NAME via db-ui's ReferenceCellValue — bound over the real table declarations by the new user-ui suite. Floors: @proteinjs/db ^1.37.0 (user), @proteinjs/db-ui ^1.13.0 (ui); user-ui's jest config adopts the estate singleton pin user-server carries (CI-inert) ([1c5f32a](https://github.com/proteinjs/user/commit/1c5f32a2603f27c41e39e4cfc07f1c3ff17af827))





# [1.11.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.10.3...@proteinjs/user@1.11.0) (2026-08-28)


### Features

* hide password-reset token columns from the generic record UI — auth-internal state (server write paths only) has no business on the admin user table or form; ui.hidden at the schema like password ([4e61728](https://github.com/proteinjs/user/commit/4e6172866cf291b8e476001cf2c39f933a72b4fb))





## [1.10.3](https://github.com/proteinjs/user/compare/@proteinjs/user@1.10.2...@proteinjs/user@1.10.3) (2026-08-26)


### Bug Fixes

* MachineAccounts harness meets db >=1.34.4 — getMachineAccounts maps the new {source, loader} declaration pairs; the test seeds namedObjectCache beside objectCache (objectsWithNames reads only the former — user's next CI red without this); the removal case models IN-PACKAGE removal (a surviving sibling declaration) per the ownership law boot([]) now deliberately protects. HONEST RESIDUE: the re-declare-after-removal leg still reds (sync INSERTs the existing machine-test-ops row instead of adopting — the new sync's adopt query vs the deactivated row's stamps; a user+db semantics call for the mint owners, exact repro in this suite) — 10/11 green, was 1/11 at origin/main against db 1.34.4 ([895f5fe](https://github.com/proteinjs/user/commit/895f5fedf47064299f184e7a2a14068bd7acbdd0))





## [1.10.2](https://github.com/proteinjs/user/compare/@proteinjs/user@1.10.1...@proteinjs/user@1.10.2) (2026-08-26)


### Bug Fixes

* avatar photo fidelity — the server pipeline owns the one resize (founder fuzzy-avatar defect) ([629f411](https://github.com/proteinjs/user/commit/629f411ac614bfe0a1e5c326a647a6de9f212500))





## [1.10.1](https://github.com/proteinjs/user/compare/@proteinjs/user@1.10.0...@proteinjs/user@1.10.1) (2026-08-23)


### Bug Fixes

* adapt row-injection/zero-row guards to main's skipAccessGrantsEnabled() accessor ([0b5dc21](https://github.com/proteinjs/user/commit/0b5dc213d2de07cafdbb60f6fbd651de0b00cd58))
* browser root creation — pure permissionSource default, owner grant minted server-side post-insert ([a6bd1b8](https://github.com/proteinjs/user/commit/a6bd1b86823244009d4cba0a103d04ed80f27bb7))
* close SharedRecord/AccessGrant capability holes — escalation, row injection, silent refusal ([8343f17](https://github.com/proteinjs/user/commit/8343f17376cfd4063e6f10a2550ccdc5cc2f0eb1))
* close the AccessGrant DELETE door in the owner ceiling ([801009a](https://github.com/proteinjs/user/commit/801009a7c86a6ef1ae7157e19b697fdcb6b0e41f))
* invite links are durable multi-use capabilities — idempotent accept reconciles the grant up to the invite's level; minting requires admin on the resource ([4abb4cc](https://github.com/proteinjs/user/commit/4abb4cc9adacdaa91a499b3ad7134491948b038a))
* owner ceiling on AccessGrant/AccessInvite inserts — only an owner confers owner ([da90956](https://github.com/proteinjs/user/commit/da90956a9cff73a2838bd85c3302bb4416179bbd))





# [1.10.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.9.0...@proteinjs/user@1.10.0) (2026-08-19)


### Bug Fixes

* anchor skip-access-grants state on globalThis (duplicate-module-instance class) ([5faa559](https://github.com/proteinjs/user/commit/5faa5592fbafb27a2193d78f892113ab5aa8940c))


### Features

* auto-login after signup — the signup request now establishes the session ([c505e67](https://github.com/proteinjs/user/commit/c505e6742f9022b6eca23a42c2599e76009f299a))





# [1.9.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.8.0...@proteinjs/user@1.9.0) (2026-08-19)


### Features

* account deletion — deactivation + manifest, cancel-by-login, purge-retention seam, deletion emails ([6a309c3](https://github.com/proteinjs/user/commit/6a309c32211ad66453cdf3f1b5f558f69ddb883d))
* machine accounts as source records — user-table sync wiring, MachineAccount base, deactivation watcher, credential minting ([93deaa4](https://github.com/proteinjs/user/commit/93deaa44715e484fe98162718048913f5226196a))
* password hashing upgraded to argon2id with transparent per-login migration ([a137d6c](https://github.com/proteinjs/user/commit/a137d6c98f5cf750003046a4e0692c766c53f611))
* user account standing — status/deletion columns, deactivation auth gate, admin SetUserStatus service ([ca4d6f2](https://github.com/proteinjs/user/commit/ca4d6f284b1edcce8717f330988215c4507eb768))





# [1.8.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.7.2...@proteinjs/user@1.8.0) (2026-08-14)


### Features

* createScopedIndex passes unique through ([bf0a738](https://github.com/proteinjs/user/commit/bf0a7387540d797ea9ea789acaf921e9af832f6a))
* user avatars — photo/emoji schema, avatar mutations with session-cache refresh, shared /avatar route ([6af0bc5](https://github.com/proteinjs/user/commit/6af0bc5b34cf42fc3cc47706fc200fd8fdaa8d8d))





## [1.7.2](https://github.com/proteinjs/user/compare/@proteinjs/user@1.7.1...@proteinjs/user@1.7.2) (2026-08-14)

**Note:** Version bump only for package @proteinjs/user





## [1.5.11](https://github.com/proteinjs/user/compare/@proteinjs/user@1.5.10...@proteinjs/user@1.5.11) (2026-07-21)

**Note:** Version bump only for package @proteinjs/user





## [1.5.10](https://github.com/proteinjs/user/compare/@proteinjs/user@1.5.9...@proteinjs/user@1.5.10) (2026-07-21)


### Bug Fixes

* scoped queries/writes with no user in context fail loudly at the seam ([f1a00ca](https://github.com/proteinjs/user/commit/f1a00cab599a2b212391edd4d47ba274af453188))





## [1.5.5](https://github.com/proteinjs/user/compare/@proteinjs/user@1.5.4...@proteinjs/user@1.5.5) (2026-04-10)

**Note:** Version bump only for package @proteinjs/user





## [1.5.3](https://github.com/proteinjs/user/compare/@proteinjs/user@1.5.2...@proteinjs/user@1.5.3) (2026-04-08)


### Bug Fixes

* add --passWithNoTests to jest test script ([0f6ae5c](https://github.com/proteinjs/user/commit/0f6ae5c667c9932037448ea4bb6fc4f43c59190d))





# [1.5.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.4.0...@proteinjs/user@1.5.0) (2026-02-17)


### Features

* Added utility `createScopedIndex`. ([ed02520](https://github.com/proteinjs/user/commit/ed0252072786bb3f0d9cd7f158ee15958a443d05))





# [1.4.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.3.15...@proteinjs/user@1.4.0) (2026-01-04)


### Features

* Added `SharedRecordOptions` to enable the consuming table to specify a `permissionSourceTableName` and a `permissionSourceDefaultValue`. ([d627182](https://github.com/proteinjs/user/commit/d6271822ba1c73a7628eee342bfaaa42231d01e0))





## [1.3.12](https://github.com/proteinjs/user/compare/@proteinjs/user@1.3.11...@proteinjs/user@1.3.12) (2025-11-13)

**Note:** Version bump only for package @proteinjs/user





## [1.3.10](https://github.com/proteinjs/user/compare/@proteinjs/user@1.3.9...@proteinjs/user@1.3.10) (2025-10-09)


### Bug Fixes

* **shared-record:** use owner as default accessLevel when creating a record ([#12](https://github.com/proteinjs/user/issues/12)) ([95c8f22](https://github.com/proteinjs/user/commit/95c8f2266137a3bb17bacbf1590b1da33f0152ce))





## [1.3.9](https://github.com/proteinjs/user/compare/@proteinjs/user@1.3.8...@proteinjs/user@1.3.9) (2025-09-28)


### Bug Fixes

* restrict AccessGrant access to principals and resource admins ([#11](https://github.com/proteinjs/user/issues/11)) ([a311388](https://github.com/proteinjs/user/commit/a311388db1f03612e57ba1d85d0b3d70d9524736))





## [1.3.7](https://github.com/proteinjs/user/compare/@proteinjs/user@1.3.6...@proteinjs/user@1.3.7) (2025-09-27)


### Bug Fixes

* remove circular cascade delete ([#10](https://github.com/proteinjs/user/issues/10)) ([0622ac3](https://github.com/proteinjs/user/commit/0622ac307b1641cab8e87d390446f172de6a3eed))
* remove index on AccessGrants ([d3e4576](https://github.com/proteinjs/user/commit/d3e4576b33cde0c321099b7eaadd58dc42974663))





## [1.3.6](https://github.com/proteinjs/user/compare/@proteinjs/user@1.3.5...@proteinjs/user@1.3.6) (2025-09-25)


### Bug Fixes

* export AccessGrant ([3d6038d](https://github.com/proteinjs/user/commit/3d6038d2ca1b06ca09a9dab9bd2b5250f136ce8e))





## [1.3.1](https://github.com/proteinjs/user/compare/@proteinjs/user@1.3.0...@proteinjs/user@1.3.1) (2025-08-27)


### Bug Fixes

* add auth prop to Access tables ([#7](https://github.com/proteinjs/user/issues/7)) ([a93ba88](https://github.com/proteinjs/user/commit/a93ba8834c69ea78ce4e6512df401a197a16915b))





# [1.3.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.2.17...@proteinjs/user@1.3.0) (2025-08-26)


### Features

* SharedRecord column type ([#5](https://github.com/proteinjs/user/issues/5)) [skip ci] ([d320303](https://github.com/proteinjs/user/commit/d320303db6a209bd11f08845edff61b136d09859))
* **user:** invites that create access grants when accepted ([#6](https://github.com/proteinjs/user/issues/6)) ([5ee1965](https://github.com/proteinjs/user/commit/5ee196519ebd08ca215aad75257af3b1fc60f778))





## [1.2.9](https://github.com/proteinjs/user/compare/@proteinjs/user@1.2.6...@proteinjs/user@1.2.9) (2025-02-07)


### Bug Fixes

* add table param to defaultValue, update params for db changes ([#3](https://github.com/proteinjs/user/issues/3)) ([c98e5dc](https://github.com/proteinjs/user/commit/c98e5dcc4a09bf27bfd2cdd877eb0a15b952c56a))





# [1.2.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.1.11...@proteinjs/user@1.2.0) (2024-10-21)


### Features

* added ability to specify globally-accessible scopes for the `scope` column ([b5de6c5](https://github.com/proteinjs/user/commit/b5de6c58f9c4d3dbb0288132699aeaf164b2bf05))





## [1.1.4](https://github.com/proteinjs/user/compare/@proteinjs/user@1.1.3...@proteinjs/user@1.1.4) (2024-08-16)

**Note:** Version bump only for package @proteinjs/user





# [1.1.0](https://github.com/proteinjs/user/compare/@proteinjs/user@1.0.39...@proteinjs/user@1.1.0) (2024-08-06)


### Features

* add invite feature and SignupService ([50545d3](https://github.com/proteinjs/user/commit/50545d39c19238e9e1b3ec67c789c3c161860dc8))





## [1.0.36](https://github.com/proteinjs/user/compare/@proteinjs/user@1.0.35...@proteinjs/user@1.0.36) (2024-07-20)

**Note:** Version bump only for package @proteinjs/user





## [1.0.34](https://github.com/proteinjs/user/compare/@proteinjs/user@1.0.33...@proteinjs/user@1.0.34) (2024-07-12)

**Note:** Version bump only for package @proteinjs/user





## [1.0.27](https://github.com/proteinjs/user/compare/@proteinjs/user@1.0.26...@proteinjs/user@1.0.27) (2024-06-27)


### Bug Fixes

* update test to include get table ([3c6d8f1](https://github.com/proteinjs/user/commit/3c6d8f15c183ccf7171cfcb1975e7cef0a2ee7c0))





## [1.0.14](https://github.com/proteinjs/user/compare/@proteinjs/user@1.0.13...@proteinjs/user@1.0.14) (2024-05-10)


### Bug Fixes

* add .md file type to lint ignore files ([372c51f](https://github.com/proteinjs/user/commit/372c51fdc0a48c8559321862e3b7cebe05e4955d))





## [1.0.13](https://github.com/proteinjs/user/compare/@proteinjs/user@1.0.12...@proteinjs/user@1.0.13) (2024-05-10)

### Bug Fixes

- add linting and lint all files ([71defcd](https://github.com/proteinjs/user/commit/71defcd78dc479d2eef1f624c746c879f4e31daa))

## [1.0.11](https://github.com/proteinjs/user/compare/@proteinjs/user@1.0.10...@proteinjs/user@1.0.11) (2024-05-09)

### Bug Fixes

- do not name a column the same name as a table ([1442a9f](https://github.com/proteinjs/user/commit/1442a9f665f88feafa8ccb83631ef2fb7d741f20))

## 1.0.1 (2024-04-19)

**Note:** Version bump only for package @proteinjs/user
