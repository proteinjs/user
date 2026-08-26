# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
