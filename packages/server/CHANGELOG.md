# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
