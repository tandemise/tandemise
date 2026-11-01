# Changelog

## [0.12.3](https://github.com/tandemise/tandemise/compare/v0.12.2...v0.12.3) (2026-11-01)


### Bug Fixes

* bound ci rounds and check them against ci as it is now ([#207](https://github.com/tandemise/tandemise/issues/207)) ([3893229](https://github.com/tandemise/tandemise/commit/38932291d3a08150370aafe15fa8a075c32eca8e))
* classify a failing ci check before acting on it ([#203](https://github.com/tandemise/tandemise/issues/203)) ([47ba5f2](https://github.com/tandemise/tandemise/commit/47ba5f20da17d1cce60ffbfc8e1b4abc06acc67a))

## [0.12.2](https://github.com/tandemise/tandemise/compare/v0.12.1...v0.12.2) (2026-11-01)


### Bug Fixes

* judge main by its own ci after a merge, and never offer revert first ([#188](https://github.com/tandemise/tandemise/issues/188)) ([933fb18](https://github.com/tandemise/tandemise/commit/933fb18d6318a9fc79e1549ba56f00b278427264))
* keep each review step's verdict its own and block a step whose output write was refused ([#199](https://github.com/tandemise/tandemise/issues/199)) ([625693c](https://github.com/tandemise/tandemise/commit/625693c8af424771db129ae63c3e73da0263913a))
* set youtrack fields as data so multi-word states move ([#195](https://github.com/tandemise/tandemise/issues/195)) ([f23bb19](https://github.com/tandemise/tandemise/commit/f23bb19a7ab46e313fa06018a013a0b4942827e0))
* start task worktrees from the remote's current default branch ([#169](https://github.com/tandemise/tandemise/issues/169)) ([5726853](https://github.com/tandemise/tandemise/commit/572685361c2810f1b3b8f75f6458c9e03655c164))

## [0.12.1](https://github.com/tandemise/tandemise/compare/v0.12.0...v0.12.1) (2026-11-01)


### Bug Fixes

* count only the latest run of each check, and stop repeating an identical ci round ([#198](https://github.com/tandemise/tandemise/issues/198)) ([0767675](https://github.com/tandemise/tandemise/commit/0767675c4f6ff8d0598e5b38cfe9b72fe2404760))
* keep agents off the person's window devtools port ([#171](https://github.com/tandemise/tandemise/issues/171)) ([d363adb](https://github.com/tandemise/tandemise/commit/d363adbc459ad08a1ca05a20d7f7070772e9b6ce))
* only add to a refined item's description when marking it ready ([#190](https://github.com/tandemise/tandemise/issues/190)) ([2d4721d](https://github.com/tandemise/tandemise/commit/2d4721db2bd30e71a9f4b44cbfdbb0b7a6c059fa))
* record a notification only when the system takes it, and say why it does not show ([#182](https://github.com/tandemise/tandemise/issues/182)) ([e7a92a2](https://github.com/tandemise/tandemise/commit/e7a92a26b6f2938993fbe2db7318c0c397798a1f))
* title the pull request with the change's real commit type ([#172](https://github.com/tandemise/tandemise/issues/172)) ([2b6b30d](https://github.com/tandemise/tandemise/commit/2b6b30db715152c71dfbc59dfa945f2c8a210cad))


### Documentation

* report on dogfooding the factory on 0.11.0 ([#168](https://github.com/tandemise/tandemise/issues/168)) ([17fa791](https://github.com/tandemise/tandemise/commit/17fa79177d99938a1e49dc3debd3ff5f8a5d4d53))

## [0.12.0](https://github.com/tandemise/tandemise/compare/v0.11.0...v0.12.0) (2026-11-01)


### Features

* find claude code plugin, project and grouped skills ([#160](https://github.com/tandemise/tandemise/issues/160)) ([2bf48b4](https://github.com/tandemise/tandemise/commit/2bf48b4cda1c9d656cf9b027741725301224304a))
* refine a tracker draft from the board and write it back as ready ([#161](https://github.com/tandemise/tandemise/issues/161)) ([4620ce8](https://github.com/tandemise/tandemise/commit/4620ce877e233628c8db66c429a5ed9661b2838b))
* run a team's own claude code skills as factory steps ([#164](https://github.com/tandemise/tandemise/issues/164)) ([aa48f26](https://github.com/tandemise/tandemise/commit/aa48f2694916810df554d33f7de2520b56e2bc3c))


### Bug Fixes

* keep mission header actions on the title row and step card meta in full ([#166](https://github.com/tandemise/tandemise/issues/166)) ([15c5467](https://github.com/tandemise/tandemise/commit/15c5467118b88f515c98e990160dcf4ed6bc3c92))
* keep the brain's tracker after a daemon restart ([#170](https://github.com/tandemise/tandemise/issues/170)) ([cd8bba5](https://github.com/tandemise/tandemise/commit/cd8bba575506c6390393bd1d684e7fcef7230638))
* read the board again when the tracker token is saved ([#158](https://github.com/tandemise/tandemise/issues/158)) ([c3ee811](https://github.com/tandemise/tandemise/commit/c3ee81154fad7afda58c141c1796545be02e6a88))
* read the first valid json object in the planner tiebreak reply ([#156](https://github.com/tandemise/tandemise/issues/156)) ([14f939e](https://github.com/tandemise/tandemise/commit/14f939ebbe4c346e798400054e40ff9adcf28e44))
* read the repository's auto-merge setting through the rest api ([#183](https://github.com/tandemise/tandemise/issues/183)) ([778c458](https://github.com/tandemise/tandemise/commit/778c4588552b4171577d218490d98e0587ab8431))

## [0.11.0](https://github.com/tandemise/tandemise/compare/v0.10.0...v0.11.0) (2026-11-01)


### Features

* a readable mission header and a pull request that says what changed ([#124](https://github.com/tandemise/tandemise/issues/124)) ([deb11a7](https://github.com/tandemise/tandemise/commit/deb11a7f049b506bbda07e63970a0d2fa9cd080c))
* give agent runs their own home and, when asked, a display ([#126](https://github.com/tandemise/tandemise/issues/126)) ([83aae66](https://github.com/tandemise/tandemise/commit/83aae665877a395acad291edbf9a03d908e555d2))
* size work from what the item says, and show which signal set it ([#123](https://github.com/tandemise/tandemise/issues/123)) ([61c9851](https://github.com/tandemise/tandemise/commit/61c98512b6629190dcb90cdbcce76d651c238add))


### Bug Fixes

* bind a step's approval to the calls it names and park runs waiting on a tool card ([#146](https://github.com/tandemise/tandemise/issues/146)) ([ffc3d25](https://github.com/tandemise/tandemise/commit/ffc3d2531d4c56d4fa218e870f1f7fdd78a2f60f))
* decide a ci wait by its pull request and say when it stalls ([#148](https://github.com/tandemise/tandemise/issues/148)) ([1327177](https://github.com/tandemise/tandemise/commit/1327177869e799f16daa17ebf8d635d4621d7df1))
* free the window port from the daemon and smooth the first setup ([#125](https://github.com/tandemise/tandemise/issues/125)) ([f7bfadd](https://github.com/tandemise/tandemise/commit/f7bfaddd7dbad7e4bde8760ed3d6202e4d0ebd5a))
* keep the person's github credentials out of a worker's shell ([#149](https://github.com/tandemise/tandemise/issues/149)) ([c47c8d1](https://github.com/tandemise/tandemise/commit/c47c8d1dd0a9b7ffbd218256bd6d50f10e434824))
* make the factory loop fast and self-unblocking ([#133](https://github.com/tandemise/tandemise/issues/133)) ([67905a3](https://github.com/tandemise/tandemise/commit/67905a39db773043e08b4f2d5442c5fa86534749))
* open a held session without the bypass warning and answer trust in one click ([#122](https://github.com/tandemise/tandemise/issues/122)) ([9d49b49](https://github.com/tandemise/tandemise/commit/9d49b49370aef2521510d6b5075adbd547a35e50))
* run redone review and qa steps on the upstream step's new work ([#140](https://github.com/tandemise/tandemise/issues/140)) ([674e476](https://github.com/tandemise/tandemise/commit/674e47602e126931cf07eb8be85bd4af326e7dde))
* share a brain into an existing empty repository ([#115](https://github.com/tandemise/tandemise/issues/115)) ([145ce99](https://github.com/tandemise/tandemise/commit/145ce99a524715315920c5c2871a3dbd508c6a08))
* tell a retry which check failed and why ([#114](https://github.com/tandemise/tandemise/issues/114)) ([31a1b51](https://github.com/tandemise/tandemise/commit/31a1b514d25451e455637827fa922e9949f41a42))
* wait for every check on the pull request, not only required ones ([#144](https://github.com/tandemise/tandemise/issues/144)) ([07086e4](https://github.com/tandemise/tandemise/commit/07086e4483e35b37033b84b9a3c0260d1a25a8f1))


### Documentation

* describe building tandemise with tandemise ([#98](https://github.com/tandemise/tandemise/issues/98)) ([3585d31](https://github.com/tandemise/tandemise/commit/3585d317b0d00347c572ca311e58424c65e673be))
* report on dogfooding tandemise as its own factory ([#119](https://github.com/tandemise/tandemise/issues/119)) ([629871a](https://github.com/tandemise/tandemise/commit/629871ab6426e19c696fc62f4777cc897964fd76))
* say runtimes are added with Discover in the quickstart ([#110](https://github.com/tandemise/tandemise/issues/110)) ([380ac82](https://github.com/tandemise/tandemise/commit/380ac82c9b1a00199ac3a7376241b74f3d2049f9))

## [0.10.0](https://github.com/tandemise/tandemise/compare/v0.9.0...v0.10.0) (2026-10-31)


### Features

* a storybook for the design system ([#82](https://github.com/tandemise/tandemise/issues/82)) ([a8546cc](https://github.com/tandemise/tandemise/commit/a8546ccae6299416372febe1a00b901db2a09e5e))
* accessible sizes, tooltips, tokens and components for the design system ([#89](https://github.com/tandemise/tandemise/issues/89)) ([63e6246](https://github.com/tandemise/tandemise/commit/63e6246ae654897871f31b3dcd1c653880a9912b))
* extend the design system with tokens, react components and a gallery ([#79](https://github.com/tandemise/tandemise/issues/79)) ([f9fae59](https://github.com/tandemise/tandemise/commit/f9fae59a1a4543981ccf5a28f0677ebdb5032e5b))


### Bug Fixes

* give each offline check its own TMPDIR and remove it on success ([#94](https://github.com/tandemise/tandemise/issues/94)) ([f7b7a13](https://github.com/tandemise/tandemise/commit/f7b7a138e868dbe353ece971eab47bdd39ed2333))
* make the desktop app meet wcag 2.1 aa ([#93](https://github.com/tandemise/tandemise/issues/93)) ([7374ee0](https://github.com/tandemise/tandemise/commit/7374ee064d176a4929bbd0492bc8a932bb3ac9c3))
* readable status colours in light mode and dialog autofocus ([#84](https://github.com/tandemise/tandemise/issues/84)) ([69af84e](https://github.com/tandemise/tandemise/commit/69af84e4f2a8fadffef05fac918bbd2c8e74408c))
* the demo-data seed writes today's artifact shape ([#86](https://github.com/tandemise/tandemise/issues/86)) ([0cfe61f](https://github.com/tandemise/tandemise/commit/0cfe61f32d7cd7d22b17a1bec6951e5efc459def))


### Documentation

* refresh the readme and docs after the pivot ([#92](https://github.com/tandemise/tandemise/issues/92)) ([84d7886](https://github.com/tandemise/tandemise/commit/84d7886a6c73f696af67b25ba326f5945d8d65b6))

## [0.9.0](https://github.com/tandemise/tandemise/compare/v0.8.0...v0.9.0) (2026-10-31)


### Features

* a brain repo per project for memory and the factory ([#70](https://github.com/tandemise/tandemise/issues/70)) ([b8e88b3](https://github.com/tandemise/tandemise/commit/b8e88b332a35c4b4987f5ab6f6042bc0ee3dbbe6))
* a step can say the plan no longer fits, and the steps after it wait for you ([#38](https://github.com/tandemise/tandemise/issues/38)) ([9f7ee03](https://github.com/tandemise/tandemise/commit/9f7ee031a3c5c8e2ea189c9b35b2e4263c39a6fc))
* an optional, slim, self-hosted relay ([#69](https://github.com/tandemise/tandemise/issues/69)) ([9392dd7](https://github.com/tandemise/tandemise/commit/9392dd7b6fbce787af950649c119ec1c7680e71f))
* hold a task and work with its agent in the terminal ([#72](https://github.com/tandemise/tandemise/issues/72)) ([d87bb2c](https://github.com/tandemise/tandemise/commit/d87bb2c2037e092a691b7aa016cd39b89958aea0))
* intake from any source into the primary tracker ([#73](https://github.com/tandemise/tandemise/issues/73)) ([654c06e](https://github.com/tandemise/tandemise/commit/654c06e862318c26ee3da7757c7d6a70a3ebccfe))
* plan each task's steps, models and gates, and merge by risk ([#71](https://github.com/tandemise/tandemise/issues/71)) ([de9631b](https://github.com/tandemise/tandemise/commit/de9631ba7ba2a74f696461b818cc60dc08add4ac))
* plan the rest of a mission again, keeping what is done ([#45](https://github.com/tandemise/tandemise/issues/45)) ([3bdb837](https://github.com/tandemise/tandemise/commit/3bdb8370d3efe6af6a9720f9941ab97a25d5ea5c))
* the tandemise design system as its own package ([#75](https://github.com/tandemise/tandemise/issues/75)) ([0526630](https://github.com/tandemise/tandemise/commit/0526630913ae0e75c19824660afadd3ee587f0eb))


### Bug Fixes

* a person's step shows what came in, and questions are asked in the app ([#37](https://github.com/tandemise/tandemise/issues/37)) ([0aeda64](https://github.com/tandemise/tandemise/commit/0aeda64d54b245310839725d781e3ffedb777f78))
* a quick change verifies what done means ([#43](https://github.com/tandemise/tandemise/issues/43)) ([388bc69](https://github.com/tandemise/tandemise/commit/388bc696a2975096b1c8a22f002008112556fda3))
* default the claude config directory to ~/.claude ([#76](https://github.com/tandemise/tandemise/issues/76)) ([c81bc67](https://github.com/tandemise/tandemise/commit/c81bc67921d9822cdacfb9e40a191439d705d2c4))
* review and qa can run commands on claude code ([#42](https://github.com/tandemise/tandemise/issues/42)) ([a433e6f](https://github.com/tandemise/tandemise/commit/a433e6fad71587ff761e3d6bdd8d5034941a19ee))
* what a first real run shows reads like it was meant ([#44](https://github.com/tandemise/tandemise/issues/44)) ([0de07e7](https://github.com/tandemise/tandemise/commit/0de07e712daa15950b31f3f7f4177a9a356e7073))


### Documentation

* design hold and interact ([#59](https://github.com/tandemise/tandemise/issues/59)) ([12d583a](https://github.com/tandemise/tandemise/commit/12d583a9565e186236525274220a619a48c0a852))
* design intake into the primary tracker ([#62](https://github.com/tandemise/tandemise/issues/62)) ([c9ae4ed](https://github.com/tandemise/tandemise/commit/c9ae4eda8b494fcec721488cba55686243bbb452))
* design the brain repo ([#63](https://github.com/tandemise/tandemise/issues/63)) ([9b3eae7](https://github.com/tandemise/tandemise/commit/9b3eae7edb8ce0cfda2f83ae2b522763fea02eb6))
* design the optional relay ([#61](https://github.com/tandemise/tandemise/issues/61)) ([e76536e](https://github.com/tandemise/tandemise/commit/e76536e95205f4d29bf1c1e587dca1b7e0c7503a))
* design the planner and risk-based merge ([#67](https://github.com/tandemise/tandemise/issues/67)) ([f2ef4ab](https://github.com/tandemise/tandemise/commit/f2ef4ab32baa7444426e65bf1288ba11484bd92f))
* notes for the tandemise pivot ([#49](https://github.com/tandemise/tandemise/issues/49)) ([27dcf0c](https://github.com/tandemise/tandemise/commit/27dcf0cb8fe1b2c5724bdb8b6d8f8fa833dd9e4f))
* plan hold and interact ([#60](https://github.com/tandemise/tandemise/issues/60)) ([df098b1](https://github.com/tandemise/tandemise/commit/df098b171b4dfdd9e02cb78836b56de766b068e0))
* plan the planner and risk-based merge ([#68](https://github.com/tandemise/tandemise/issues/68)) ([cf96f75](https://github.com/tandemise/tandemise/commit/cf96f75f7632ad19ba8cd5d2e4a243041f0ca078))

## [0.8.0](https://github.com/demogar/tandemise/compare/v0.7.0...v0.8.0) (2026-09-28)


### Features

* score every run and try a setup on evals before it goes live ([#34](https://github.com/demogar/tandemise/issues/34)) ([8636a3c](https://github.com/demogar/tandemise/commit/8636a3c263c47eb95ad5b0f084a855ce5eea2bde))

## [0.7.0](https://github.com/demogar/tandemise/compare/v0.6.0...v0.7.0) (2026-09-28)


### Features

* hand work in and back, pinned as a snapshot ([#32](https://github.com/demogar/tandemise/issues/32)) ([25242c0](https://github.com/demogar/tandemise/commit/25242c05d25100e7dc9682956efa001ce8572978))

## [0.6.0](https://github.com/demogar/tandemise/compare/v0.5.0...v0.6.0) (2026-09-27)


### Features

* a native notification when something new needs you ([#24](https://github.com/demogar/tandemise/issues/24)) ([2b9ed5e](https://github.com/demogar/tandemise/commit/2b9ed5e26149d9fd83f58f8f31aaf4877c9b3029))
* an about section with versions, data folder and copyable diagnostics ([#25](https://github.com/demogar/tandemise/issues/25)) ([f19de23](https://github.com/demogar/tandemise/commit/f19de23d0109a4921feddfc62eb176f52beff06a))
* bring your own skills and pin them to the roles that use them ([#28](https://github.com/demogar/tandemise/issues/28)) ([911a18c](https://github.com/demogar/tandemise/commit/911a18c22bd0b3a1d1f1d93545eabf0fab29f9ca))
* keep your setup in the repo and reject gates that can never pass ([#29](https://github.com/demogar/tandemise/issues/29)) ([22fa04f](https://github.com/demogar/tandemise/commit/22fa04f8927d7366beeb01b0af2d11e667d55d41))
* route each step to the right model and escalate on retry ([#18](https://github.com/demogar/tandemise/issues/18)) ([85fa05d](https://github.com/demogar/tandemise/commit/85fa05d30863344e8f4da92fd8472988e58e7025))
* turn labelled github issues into missions and report back on them ([#30](https://github.com/demogar/tandemise/issues/30)) ([5ac2b8d](https://github.com/demogar/tandemise/commit/5ac2b8d2294ab275e960bd9006ce6a064f7314fa))


### Bug Fixes

* name refinement notes after their mission and retire the stale screenshot pass ([#21](https://github.com/demogar/tandemise/issues/21)) ([563f0e6](https://github.com/demogar/tandemise/commit/563f0e61a647857b16f1aa277beb1014098959aa))
* notes given in the same millisecond reached the agent out of order, and a mission could complete before its review escalated ([#19](https://github.com/demogar/tandemise/issues/19)) ([ed6f917](https://github.com/demogar/tandemise/commit/ed6f917f87408ccfad0171de76695bbad86fe73c))
* retry starts the daemon with a node that can open the database ([#27](https://github.com/demogar/tandemise/issues/27)) ([5344e15](https://github.com/demogar/tandemise/commit/5344e15e10c5cf68d636857cd67a15934db10e18))
* the development app shows as tandemise in the dock, not electron ([#23](https://github.com/demogar/tandemise/issues/23)) ([044fb92](https://github.com/demogar/tandemise/commit/044fb92cd1868171a8a97874525fd315bfc6a6a8))


### Documentation

* credit tandemise's origins and inspirations ([#26](https://github.com/demogar/tandemise/issues/26)) ([73280cc](https://github.com/demogar/tandemise/commit/73280cc5e67fc4784d2fc2b93d4975e708717ac5))
* guides and screenshots for the product-owner loop ([#16](https://github.com/demogar/tandemise/issues/16)) ([92f0f03](https://github.com/demogar/tandemise/commit/92f0f0381b7b58003213d2f4e3cb905f3bc5ebe3))
* recapture every screenshot from the current app ([#20](https://github.com/demogar/tandemise/issues/20)) ([c0f0f9d](https://github.com/demogar/tandemise/commit/c0f0f9d0880b499b9f306c4a6ef040a78b158450))

## [0.5.0](https://github.com/demogar/tandemise/compare/v0.4.0...v0.5.0) (2026-09-26)


### Features

* an owner's desk and a status report written from facts ([#13](https://github.com/demogar/tandemise/issues/13)) ([034a423](https://github.com/demogar/tandemise/commit/034a4238b3c5d28d59e57143b51fbacaaaf18b44))
* rank a backlog and pull the next ready mission within a wip limit ([#9](https://github.com/demogar/tandemise/issues/9)) ([76753bc](https://github.com/demogar/tandemise/commit/76753bcaabc4a47458628ec45dd723ea27835b30))
* routines that queue standing work on a schedule ([#15](https://github.com/demogar/tandemise/issues/15)) ([9879ae4](https://github.com/demogar/tandemise/commit/9879ae4e92c1c4f123c9aed26e698c35ae39322d))
* stop work at a spend or time limit and ask before going further ([#10](https://github.com/demogar/tandemise/issues/10)) ([9d78d5c](https://github.com/demogar/tandemise/commit/9d78d5cdd8bd4cfd2c51fdf92c00b351076daa39))
* trace every done-when criterion from request to qa ([#7](https://github.com/demogar/tandemise/issues/7)) ([7a2547b](https://github.com/demogar/tandemise/commit/7a2547bf48e19478d68330cca45d6d48e7fcb1a4))


### Bug Fixes

* a release step passes only when it produced its release candidate ([#14](https://github.com/demogar/tandemise/issues/14)) ([0cd45e9](https://github.com/demogar/tandemise/commit/0cd45e93a8f8542d16d087fa8010c7d6a207f180))
* unmeasured checks never pass a preset gate ([#6](https://github.com/demogar/tandemise/issues/6)) ([f49fd4d](https://github.com/demogar/tandemise/commit/f49fd4d50aca12d3ab0ef0fc86fba9eda4147242))

## [0.4.0](https://github.com/demogar/tandemise/compare/v0.3.1...v0.4.0) (2026-09-16)


### Features

* focus the team on you + your agents, and plan P3 outside contributions ([75245c2](https://github.com/demogar/tandemise/commit/75245c268154eedea4532c878961c263f7c9f31a))

## [0.3.1](https://github.com/demogar/tandemise/compare/v0.3.0...v0.3.1) (2026-09-16)


### Bug Fixes

* a completion gate reads the current state, not every measurement ever taken ([a2a64d4](https://github.com/demogar/tandemise/commit/a2a64d43dbdc533090faeb5194be81d1d5f761ab))

## [0.3.0](https://github.com/demogar/tandemise/compare/v0.2.0...v0.3.0) (2026-09-15)


### Features

* feedback rounds, a handoff feed, and a responsible person behind every task ([4e5e96f](https://github.com/demogar/tandemise/commit/4e5e96fb288a0e914e560731a6461b82789d3305))

## [0.2.0](https://github.com/demogar/tandemise/compare/v0.1.0...v0.2.0) (2026-09-13)


### Features

* a mission may span a project's repositories ([d1dec9b](https://github.com/demogar/tandemise/commit/d1dec9b43fa1a018776ccdc04d3ba81edc920ea7))
* **api,roles:** daemon API contract, built-in roles, workflow presets ([4967943](https://github.com/demogar/tandemise/commit/4967943c071b8b485c6da1db89e49c0cb5391312))
* **api:** let the user declare a runtime's capabilities; document limitations ([d35faac](https://github.com/demogar/tandemise/commit/d35faac12446b9c2a0be6bf206a1b43669bf8acf))
* **application:** mission engine complete; whole monorepo builds ([9ef1f9b](https://github.com/demogar/tandemise/commit/9ef1f9b1ed28218035935c575f2125f21e7bc29f))
* **application:** service facade definition ([a67c2fc](https://github.com/demogar/tandemise/commit/a67c2fc16c57a52f30d30e1a86b6b5a35793fcb1))
* **approvals:** accept a result whose gate cannot be met ([e69a501](https://github.com/demogar/tandemise/commit/e69a501a904aa35717317e9e3a6b560ecc9a9d52))
* **approvals:** allow a tool for the rest of a task; trust a server's read-only labels ([28696e4](https://github.com/demogar/tandemise/commit/28696e43260ba764e03c098752f06df4a6d89510))
* compose the run-scoped MCP gateway so workers can invoke tools ([ac1be13](https://github.com/demogar/tandemise/commit/ac1be1374eab088ee2278d0e1ff02f9aca3e79fa))
* **core:** shared, kernel, and domain contracts ([e9deaa1](https://github.com/demogar/tandemise/commit/e9deaa1419b180f832913328c0e86dff0a5fa019))
* **daemon:** bind platform ports in the composition root ([1a40609](https://github.com/demogar/tandemise/commit/1a40609595e2771188221c52e70a45d19adeafbb))
* **daemon:** composition root, buses, entry point ([3ec516a](https://github.com/demogar/tandemise/commit/3ec516a59d7bde140ab526ef055ed0a4b8816de2))
* **daemon:** coordinated shutdown handling ([f8405ce](https://github.com/demogar/tandemise/commit/f8405cedf61e58c308c6b3e9f94323ba776080fa))
* **daemon:** HTTP transport, auth, instance lock, event stream ([6fe4bdf](https://github.com/demogar/tandemise/commit/6fe4bdfeeb90c787391c9e6849a3d0a97a6cac79))
* **daemon:** macOS Keychain secret store ([8d2d16e](https://github.com/demogar/tandemise/commit/8d2d16eb276ad6d48a10034951b749137a5c0fc6))
* **daemon:** route table and config ([51649b0](https://github.com/demogar/tandemise/commit/51649b099769ec48795336f1fb2507dfe79df494))
* **desktop:** brand palette as an enforced design system, with a matching logo ([83d79b7](https://github.com/demogar/tandemise/commit/83d79b76f3520cc91dd63143529f6c68f808f303))
* **desktop:** every mission, task, plan, approval, run and artifact shows its id ([2ba3f48](https://github.com/demogar/tandemise/commit/2ba3f483135d471601f08de3f8af264d8e05c92a))
* **desktop:** give the app its own name and mark ([1e0de77](https://github.com/demogar/tandemise/commit/1e0de7772394273c96ac22a18cee3a09d1c74a6b))
* **desktop:** projects, and a way to be in one ([b12a35c](https://github.com/demogar/tandemise/commit/b12a35c093017a4dafa1c072a78e90874268e237))
* everything belongs to a project ([55855c8](https://github.com/demogar/tandemise/commit/55855c86f1bcda8a716e68b974fb439963376758))
* **integrations:** add an MCP server that runs as a local command ([c20da55](https://github.com/demogar/tandemise/commit/c20da55f4859aa51efa206c8c506df2c9bbdf632))
* **integrations:** connect apps by signing in, the way OAuth apps work ([03118ae](https://github.com/demogar/tandemise/commit/03118ae58f1d14db5aabb9c92b264a842de62472))
* **integrations:** speak MCP as a client, so any server is an integration ([23fa731](https://github.com/demogar/tandemise/commit/23fa7319a5af3bee03f4d5f4ec42b294abf2967a))
* **integrations:** tool broker, run-scoped MCP gateway, GitHub, browser ([93a4d34](https://github.com/demogar/tandemise/commit/93a4d3430f5cfbb19f9e4db3b20a2a23d4ecab0f))
* **loops:** workers ask you questions, and your feedback becomes the revision ([50efe95](https://github.com/demogar/tandemise/commit/50efe95945d57555668eeae3f90edda90eeeacc4))
* persistence, policy, artifacts, context, evaluation verified ([0b2e326](https://github.com/demogar/tandemise/commit/0b2e32668bc4d465e75024eec1c8150a4680016e))
* **planning:** a task using an asynchronous app waits for its result ([794e24c](https://github.com/demogar/tandemise/commit/794e24cbbbd4071fa269e78d8c1101f07987f024))
* **planning:** planner prompt and plan extraction ([21e0ccd](https://github.com/demogar/tandemise/commit/21e0ccdf6234cfebecc67b02b6b4f98ab3188540))
* **planning:** the planner knows which apps are connected ([fe641ff](https://github.com/demogar/tandemise/commit/fe641ff251fdedc28010327cb13594805a0afb24))
* run a workflow from the app, and wait on the world outside ([f6c3731](https://github.com/demogar/tandemise/commit/f6c37318efdfe7219b27b139c09ed81abdce2f44))
* runtime adapters, execution layer, policy, persistence, artifacts, context ([d855728](https://github.com/demogar/tandemise/commit/d855728d1a34ee56bc52ec1f0ef7e249703e305f))
* **runtime-codex:** Codex CLI adapter ([e9a1f91](https://github.com/demogar/tandemise/commit/e9a1f911cebaf6ec0fa869ab3230f62ec58afc5d))
* **runtimes:** per-profile config directory, and a settings form that adapters define ([f7112ab](https://github.com/demogar/tandemise/commit/f7112ab97ac7281c52361b5ef01a6c71fbb2fcc0))
* **tasks:** retry a task with more access ([cc3ccc2](https://github.com/demogar/tandemise/commit/cc3ccc2c5dbdacfc3b15dbbd5a86285e655d78b9))
* workflows a team writes, and steps a person does ([43a1352](https://github.com/demogar/tandemise/commit/43a1352123daaa9b6e554be3a1c4f57a31ee9a16))


### Bug Fixes

* **application:** give reviewers and testers the actual change ([66206ca](https://github.com/demogar/tandemise/commit/66206caa20ba9314fcec8396889dbfbe88951abc))
* **approvals:** 'Retry once more' on an exhausted task did nothing ([1ba6262](https://github.com/demogar/tandemise/commit/1ba62627e3b916dd2678aa8117e32ebf1d717dfb))
* **artifacts:** a decision record following its own template was refused ([423a469](https://github.com/demogar/tandemise/commit/423a469b19c7211e763cb1f13e1c60237014754a))
* **artifacts:** parallel research silently replaced each other's briefs ([1372792](https://github.com/demogar/tandemise/commit/1372792be1bbdfdc5880664cf9c57eba22f68f8c))
* **build:** tighten boundary import detection; declare kernel in browser and github ([5c2bb09](https://github.com/demogar/tandemise/commit/5c2bb09059a2c3a324b50876293bd7f3008fe3b9))
* **daemon:** connected MCP servers published no tools after a restart ([2dcfee9](https://github.com/demogar/tandemise/commit/2dcfee95077630dbbe181e359edba0ab07b04c4a))
* **daemon:** let the desktop renderer read its responses ([ec4791d](https://github.com/demogar/tandemise/commit/ec4791db46926514b45d9e9efbde366fab881d82))
* **daemon:** Plan mission never left the form ([76407ed](https://github.com/demogar/tandemise/commit/76407ed5ffc07277829f5a827b26229b56d9480f))
* **daemon:** seed a workspace on first start ([69ac2ed](https://github.com/demogar/tandemise/commit/69ac2ed95f02c3650a52b948b43e7d98de43d296))
* **daemon:** start the scheduler, and bind execution-core's own tokens ([58bb64b](https://github.com/demogar/tandemise/commit/58bb64b60fbfa7dddb23bf8a630df571b306575b))
* **daemon:** stop requiring a workspace the desktop has not chosen yet ([f8d8e95](https://github.com/demogar/tandemise/commit/f8d8e95544039f88696374f807bdd118805af34c))
* **desktop:** survive a daemon of a different vintage, and stop selecting chrome ([f398b1e](https://github.com/demogar/tandemise/commit/f398b1ecf3a624cd360a630e212614143ccd5238))
* **desktop:** the approval card blanked the app with a value import from domain ([7dc90b2](https://github.com/demogar/tandemise/commit/7dc90b2e9edd2b637ec9aa88eeb239c1deb84a97))
* **engine:** a forgotten session no longer strands a task ([7b467c9](https://github.com/demogar/tandemise/commit/7b467c997a21eb670fa6c84bffd3dcde32ec4c58))
* **engine:** a forgotten session no longer strands a task ([4bffc38](https://github.com/demogar/tandemise/commit/4bffc38a36298e66b3322f6205dd95542cb70440))
* **execution:** concurrent mkdirs in a shared checkout no longer fail with EEXIST ([84ca685](https://github.com/demogar/tandemise/commit/84ca685c4aedf8ee3287f6c7c304dcc7b8ffe74a))
* **execution:** prevent worktree collisions and unsafe detached-HEAD reuse ([ead93ba](https://github.com/demogar/tandemise/commit/ead93ba7d557a1f99a4043c86653c751168c5837))
* **executor:** a restart spent the task's retry budget ([e98b79d](https://github.com/demogar/tandemise/commit/e98b79d70aa9c1a90d6faace9077ac5295e1f05f))
* **executor:** a resumed run collided with the attempt it continues ([ede4482](https://github.com/demogar/tandemise/commit/ede44823a75a28038e44f6631be6ec62411ebe48))
* **executor:** a task could push its branch but never open its pull request ([0315685](https://github.com/demogar/tandemise/commit/03156859fc28607c102d1b5c1180ccc5ffac4475))
* **executor:** an evaluator that found problems was re-run instead of fixed ([9659628](https://github.com/demogar/tandemise/commit/9659628131723d034374d42b4c06ac4237662740))
* **executor:** stopping a run to retry it cancelled the retry ([7a2ed6d](https://github.com/demogar/tandemise/commit/7a2ed6d191f88a19f060334f9a15ab00b5c5f7d3))
* **git:** end option parsing before caller-supplied refs ([fa1cd11](https://github.com/demogar/tandemise/commit/fa1cd11ecd414cef36eeabe12499daa70a329e64))
* **github:** checks.list failed on every call with older gh ([bb0e5ae](https://github.com/demogar/tandemise/commit/bb0e5aedcffaec8fde81211646d69a8287094abf))
* keep the desktop icon sources out of the build ignore ([d657109](https://github.com/demogar/tandemise/commit/d65710915e6934a100ba0b5b15197167ae172490))
* **missions:** retrying a task left its dependents running on the old result ([2e40f78](https://github.com/demogar/tandemise/commit/2e40f78397806f3f3eedf061240f02f23e934fb6))
* **missions:** skipping a task left its approval cards open ([df374a2](https://github.com/demogar/tandemise/commit/df374a28b31a59bb6c1f2f8e6090bac912387c39))
* nine defects from the persistence/daemon review ([6e993ed](https://github.com/demogar/tandemise/commit/6e993ed3733c859b848407c26f38121e5696b024))
* **persistence:** let a task actually record that it is parked ([d9b8736](https://github.com/demogar/tandemise/commit/d9b873630aed78e39cf673914013dcab760355be))
* **planning:** a detailed plan was cut off and thrown away ([22cc612](https://github.com/demogar/tandemise/commit/22cc612e778ebd5925808c6ebe5fd700077d0fe9))
* **policy:** a connected-app grant covered no app ([065d543](https://github.com/demogar/tandemise/commit/065d543b45af3dbff3b4a8ec5634206c348a3f28))
* **policy:** close three fail-open paths in the permission engine ([fe0f32c](https://github.com/demogar/tandemise/commit/fe0f32c73144350c083eba8460ab6e2fc123efe6))
* **policy:** gate the default external-writes dial on plan approval ([d8442ef](https://github.com/demogar/tandemise/commit/d8442ef7e9cca9657a8098ed4ed4afb7e600f6cb))
* **policy:** neutralize fence sentinels in labels, not only bodies ([7ecbb83](https://github.com/demogar/tandemise/commit/7ecbb8341fa90331c72d2153676dc42929551dde))
* **recovery:** a task could be stranded RUNNING with nothing running ([e45b26c](https://github.com/demogar/tandemise/commit/e45b26cbc20b3c0bd55a5aa9e13160915a573f3f))
* **recovery:** reopen a completed mission that still has work queued ([33b0820](https://github.com/demogar/tandemise/commit/33b0820dc3b346451057f4c4512076408216b444))
* **roles:** projects seeded before the timestamp fix still upgrade ([539d7de](https://github.com/demogar/tandemise/commit/539d7de743c36b308b5b5964020e36153616bef6))
* **roles:** shipped role upgrades never reached an existing install ([8f5eadc](https://github.com/demogar/tandemise/commit/8f5eadcfd06ba2bba340f30a07f961cb20cc5d9c))
* **runtime-claude:** no worker could call a connected app's tools ([1e67d9e](https://github.com/demogar/tandemise/commit/1e67d9e03abe089148b6b3b4847bf95574e27dad))
* **runtime-claude:** workers ran the user's personal hooks, plugins and skills ([ddfda4f](https://github.com/demogar/tandemise/commit/ddfda4fd60dd4c1a03f9b3b1c9643c66985fe6fa))
* **runtime:** a signed-out runtime makes work wait instead of blocking it ([9576607](https://github.com/demogar/tandemise/commit/9576607bb8745accade08247e0413b6efc87c172))
* **runtimes:** claim the concurrency slot at start, not on first read ([def82a5](https://github.com/demogar/tandemise/commit/def82a5c00632c81303d98b3005e7c71fac03733))
* **runtimes:** MultiEdit file changes, relative path probing, line recovery ([ef1b5f9](https://github.com/demogar/tandemise/commit/ef1b5f9d8da9ca1348b639034b7f13d3ceda3592))
* **runtimes:** withhold unrelated credentials from worker processes ([842f3c6](https://github.com/demogar/tandemise/commit/842f3c68413f8208894d61e4764d446019e56b0b))
* **scheduler:** a mission with a cancelled task was marked complete ([00b622c](https://github.com/demogar/tandemise/commit/00b622ca82c8ced2a6c17086e96597dcf02f4ec4))
* **scheduler:** restarting the daemon cancelled the work it was doing ([37a4afc](https://github.com/demogar/tandemise/commit/37a4afce0f71a009563784d313251d57cd70fa60))
* **scheduler:** retrying a dead task left its dependents blocked forever ([349ddd9](https://github.com/demogar/tandemise/commit/349ddd96cc3ea6229a49517746e02b57831c89cf))
* schemaless artifacts could never pass, and waiting looked like stuck ([2f06530](https://github.com/demogar/tandemise/commit/2f06530d66352fb6fec2b5cf713cc1b1b8d441cd))
* **security:** close symlink sandbox escape in ScopedFileSystem ([743a946](https://github.com/demogar/tandemise/commit/743a946241a87ba86e2b9e0e23b0cb730aaba243))
* **security:** workers inherited the user's own MCP servers ([97cfdde](https://github.com/demogar/tandemise/commit/97cfddefdc995d370ff65b2d0c5e4613d55f92a8))
* what running real missions through the app broke ([134e758](https://github.com/demogar/tandemise/commit/134e75884c49ce05fa6b6877a8e1b04a1cb99234))
* **workflows:** a step inherits its role's isolation ([dbb0889](https://github.com/demogar/tandemise/commit/dbb0889c0ef0b96c78725ebcc3328a1cdc98d514))


### Performance

* **execution:** seed installed dependencies into fresh worktrees ([4eb2776](https://github.com/demogar/tandemise/commit/4eb2776b5549d42cad0e8505121a4275d9e8786a))
* **scheduler:** read-only tasks in one checkout no longer take turns ([d178778](https://github.com/demogar/tandemise/commit/d178778649051524135c6075a5a4a53bfad6cc21))


### Refactoring

* **domain:** drop unused parameter in gate failure explanation ([a4724ae](https://github.com/demogar/tandemise/commit/a4724ae7487b750da4e1db8bc32a87159ddad0d6))
* **roles:** code-host grants in their own table; seeded roles read as unedited ([3658034](https://github.com/demogar/tandemise/commit/3658034cd36032a6d02dbb91114dca4a2cb2cc8e))


### Documentation

* acceptance criteria evidence tracker ([48f88ca](https://github.com/demogar/tandemise/commit/48f88ca468dad5164c7273ad47e72517d797eb12))
* application layer design ([b3ba168](https://github.com/demogar/tandemise/commit/b3ba1686c9f7263c9c521ba038dc0f3eaec8ad27))
* architecture decision records ([33c6ba8](https://github.com/demogar/tandemise/commit/33c6ba8c24ea14cae1a763d0a784823ac7011473))
* final acceptance record ([4772c73](https://github.com/demogar/tandemise/commit/4772c730818e3b92d38133d05b7ef860aca246a7))
* quickstart ([fb390bf](https://github.com/demogar/tandemise/commit/fb390bf6c1fa69010073b911533892a99e72fe05))
* README ([a2b9995](https://github.com/demogar/tandemise/commit/a2b9995c427bb802ad6d619c90a169ef73ada706))
* record the acceptance criteria now demonstrated end to end ([cec46c0](https://github.com/demogar/tandemise/commit/cec46c0442c3f4e7b5c96868c357d1dd522c3d8c))
* record the second review pass ([12105f1](https://github.com/demogar/tandemise/commit/12105f109d7c2e8f47d8502444cb92253702273f))
* record verified acceptance criteria ([261508b](https://github.com/demogar/tandemise/commit/261508bcd1ccf8e6b1640928378f0fe327eda69c))
* record verified criteria and the security fixes from review ([e20218d](https://github.com/demogar/tandemise/commit/e20218d19215858dd5f83e285dcb962a2fa40792))
