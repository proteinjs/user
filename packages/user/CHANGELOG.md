# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
