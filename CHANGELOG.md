# Changelog

All notable changes to this project will be documented in this file.

## [0.7.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.6.0...servicebay-v0.7.0) (2026-01-13)


### Features

* **config:** persist selected release channel in local config ([10e8fa9](https://github.com/mdopp/servicebay/commit/10e8fa99c6009606673975c4b890d5f27398c53b))
* **release:** add dev/test release channels and installer selection ([eb24d48](https://github.com/mdopp/servicebay/commit/eb24d4843d40f24f4a2fda34de5dd608ad73cda8))
* **settings:** add release channel selector to UI ([47207a4](https://github.com/mdopp/servicebay/commit/47207a4f53db5e47892d5c3527383b14c4f2f347))


### Bug Fixes

* **agent:** inject XDG_RUNTIME_DIR for local agent spawn to support systemctl ([6781629](https://github.com/mdopp/servicebay/commit/678162910e41fcf459adc15c0496661bfbccd348))
* **docker:** install missing runtime dependencies (iproute2, procps, systemd) ([578a07b](https://github.com/mdopp/servicebay/commit/578a07bd64d5d45421a46da65c7bdad4768f37e7))
* **nodes:** disable auto-migration and fix circular dependency ([d1a8e02](https://github.com/mdopp/servicebay/commit/d1a8e02adc2ce82a05670ba6b7207b965e7e7db1))
* **ssh:** provide descriptive error message on authentication failure ([5509425](https://github.com/mdopp/servicebay/commit/5509425984b2d940b81109f2484365aee74064fc))
* **updater:** harden version parsing and add beta channel to release workflow ([25cfb9e](https://github.com/mdopp/servicebay/commit/25cfb9eb5479aec419cbf030bc5f588abf976107))
* **updater:** robust error handling for update checks and better UI feedback ([697b70d](https://github.com/mdopp/servicebay/commit/697b70d14b1ae63f4ba5d491bedf4edec1cbfa3d))

## [0.6.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.5.1...servicebay-v0.6.0) (2026-01-13)


### Features

* **settings:** add node status diagnostics and edit capability ([8764c4a](https://github.com/mdopp/servicebay/commit/8764c4ae5ae3d00b09273ee56e9b7c0fe7daa01d))


### Bug Fixes

* **ui:** ensure update check notification always displays result or error ([a86db79](https://github.com/mdopp/servicebay/commit/a86db79b7d13c671465019567008c6d06bc32923))

## [0.5.1](https://github.com/mdopp/servicebay/compare/servicebay-v0.5.0...servicebay-v0.5.1) (2026-01-12)


### Bug Fixes

* **ci:** trigger release workflow on push and manual dispatch ([40c9ec6](https://github.com/mdopp/servicebay/commit/40c9ec6b4a5c6a24467cc8eb42794734a1f407cb))
* **docker:** copy package.json to runtime image for version detection ([c56cdcb](https://github.com/mdopp/servicebay/commit/c56cdcbc4509311ee97d3246b99831bb042217ae))
* **updater:** remove specific service argument from podman auto-update ([6f89ccb](https://github.com/mdopp/servicebay/commit/6f89ccbca0babb647201ff1ca322d17d6c347271))

## [0.5.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.4.0...servicebay-v0.5.0) (2026-01-12)


### Features

* add edit button for managed services and gateway, show node source info ([86cc63e](https://github.com/mdopp/servicebay/commit/86cc63e6df600cbaa10fb8204e61de6b5c4e1f48))
* add edit capability to network map sidebar ([bf3c7b7](https://github.com/mdopp/servicebay/commit/bf3c7b7116b2a28d9f3c341413e4969e853b9b02))
* add FritzBox internet connection check (TR-064) ([17ab8a2](https://github.com/mdopp/servicebay/commit/17ab8a24b8d748b1ac6aad3bed72196251780b58))
* add help system with markdown support for all plugins ([80365e5](https://github.com/mdopp/servicebay/commit/80365e557fcdcc3f9b4f784f98b18fc92907950a))
* add internet gateway and reverse proxy creation flows ([05c5912](https://github.com/mdopp/servicebay/commit/05c591242a2e094209631ec1485fb65719282b80))
* add managed services and external links to network map ([e748986](https://github.com/mdopp/servicebay/commit/e74898634a59b62186c624a1f59fd84f1fb9cb43))
* add manual check for updates button ([16df537](https://github.com/mdopp/servicebay/commit/16df537aa50e8b211fb1cf2ee51a1dc50853caf2))
* add onboarding wizard for initial setup ([e85d5b7](https://github.com/mdopp/servicebay/commit/e85d5b7e0b1d52bdc08d0bd0bf15216784f79827))
* add uninstall script to clean up legacy installations ([e34ebf5](https://github.com/mdopp/servicebay/commit/e34ebf569dd58ad01336130da721eb28393d9578))
* add update progress tracking ([1711ac2](https://github.com/mdopp/servicebay/commit/1711ac2a6c6ea384e05f8ea82b0a59c68f8d6752))
* Allow manual editing of service descriptions ([08aa897](https://github.com/mdopp/servicebay/commit/08aa8976e1f1f8b31844f656ee00479333147f4a))
* **architecture:** implement V4 Phase 1 (SSH Pool & Ephemeral Agent) ([19a3ff7](https://github.com/mdopp/servicebay/commit/19a3ff7772459a594dcc0ddcb2a5c9ecc3cfa063))
* CPU hardware info and Shell/SSH robustness fixes ([1ba87d5](https://github.com/mdopp/servicebay/commit/1ba87d5d0f45f32027bee1aa0066d4a2b353d81f))
* display target version during installation ([f89724b](https://github.com/mdopp/servicebay/commit/f89724b3abe8531ecac2e99dffa391346c4faef9))
* enhance installer with ip detection and improve ssh error troubleshooting ([46cc882](https://github.com/mdopp/servicebay/commit/46cc88266a3794476244d0e246c85c0cbe3f031c))
* Enhance Network Graph visualization and unify node display ([71d03c5](https://github.com/mdopp/servicebay/commit/71d03c5de9bc8332f9e04f1961f9eca4f2c74854))
* Enhance service list with editable links, unified status dots, and clickable ports ([8bca352](https://github.com/mdopp/servicebay/commit/8bca352d6e7f4ae07c1112c06e19c3029117e3e7))
* enhance UX with loading toasts and refactor registry ([ba79c5f](https://github.com/mdopp/servicebay/commit/ba79c5f5763b08f85cedde994782dbf117ad9851))
* ensure servicebay and gateway always appear, add gateway monitoring ([01972e3](https://github.com/mdopp/servicebay/commit/01972e3489ed7abe595ff0957d732bb1c4eaddee))
* FCOS installer, Template Settings, and Agent V4 stability improvements ([65b367e](https://github.com/mdopp/servicebay/commit/65b367e4ad2fcd62abb7112bb3d2edbdd9631f6e))
* FCOS installer, Template Settings, and Agent V4 stability improvements ([2984844](https://github.com/mdopp/servicebay/commit/29848447d3e4938a320d35d0a3d655434586618f))
* group containers by pod using podman ps --pod ([3b3e1b6](https://github.com/mdopp/servicebay/commit/3b3e1b60efb8c3f9f9b84f80ca223b1c8e9cd346))
* group containers by pod/project ([1da7a0e](https://github.com/mdopp/servicebay/commit/1da7a0e022aebe6451738f8044c9013c371208c9))
* implement backend robustness, add test coverage, and update architecture docs ([ee0a85d](https://github.com/mdopp/servicebay/commit/ee0a85dba69ad59fc392bf0e73b4e9d23a1d96f0))
* implement DNS verification, network graph improvements, and link editing overlay ([cfe5ed0](https://github.com/mdopp/servicebay/commit/cfe5ed0c259386ec6a8d33be6a5273414a201acb))
* implement env-based auth for container support ([0427411](https://github.com/mdopp/servicebay/commit/042741176fc2f06cf882cf1a561bed58ca750d10))
* Implement Login Bypass, fix Backend Config Loading, and snapshot V4 Migration ([eed7ac6](https://github.com/mdopp/servicebay/commit/eed7ac621d1defb722be04b2b62672cd1989f1f3))
* implement manual network connections and improve FritzBox integration ([524bff2](https://github.com/mdopp/servicebay/commit/524bff241978927d0597bacb0ec2556677abdf3e))
* implement multi-node support via SSH executor ([f127a19](https://github.com/mdopp/servicebay/commit/f127a19af27bad578c56e977c256c6093288b669))
* Implement multiple registries support and optimize install script ([49acf4c](https://github.com/mdopp/servicebay/commit/49acf4c9eaa38ed3b096e6f780a63cea5dd0c678))
* Implement proactive monitoring with email notifications and settings UI (Closes [#3](https://github.com/mdopp/servicebay/issues/3)) ([5303171](https://github.com/mdopp/servicebay/commit/5303171c0b2194a833f44ad01d2a555259b7636b))
* implement safe migration with backups and dry-run ([66152b2](https://github.com/mdopp/servicebay/commit/66152b227a9db9ca6748a4d0e4ab98c8ffd2b3b1))
* implement self-update system and date-based release workflow ([69878c3](https://github.com/mdopp/servicebay/commit/69878c3822f3a904d6bb0bbfeed529cfdd46e7c4))
* implement service discovery and migration, enhance container details ([2cdec81](https://github.com/mdopp/servicebay/commit/2cdec813419410a7d5264d69892e0cdad9133036))
* Implement service merging, host network detection, and update docs ([8eb7ec0](https://github.com/mdopp/servicebay/commit/8eb7ec029b3f75e5d5f0dcebe477587ca593c285))
* improve network map layout spacing and add status tooltips ([6c11428](https://github.com/mdopp/servicebay/commit/6c11428aa8d05713c4e8fec15bc25f88909bd915))
* improve network sidebar details and hide system containers ([40a458f](https://github.com/mdopp/servicebay/commit/40a458f1bdae0494e8ef1988b23e41d68ea0fcf6))
* **installer:** Add version selection prompt ([3b91bc2](https://github.com/mdopp/servicebay/commit/3b91bc28a2972be110719cf9c464ee78b32d62a9))
* Integrate external services hub into services list and unify creation flow (Closes [#5](https://github.com/mdopp/servicebay/issues/5)) ([10ae420](https://github.com/mdopp/servicebay/commit/10ae42052c87e6fc21f28a89f941ab308e21de8d))
* introduce base image for faster builds ([7c30e29](https://github.com/mdopp/servicebay/commit/7c30e29367951a9cec414eef939d054003e24e32))
* merge nginx managed service with nginx config node ([d6efcd9](https://github.com/mdopp/servicebay/commit/d6efcd92ab82639ea4fd0d07cdff975b8342d1c7))
* merge update logic into install.sh ([6288146](https://github.com/mdopp/servicebay/commit/62881469b3cc68e7cdf58c94373c5a21c48c0dc8))
* mobile navigation, monitoring UI improvements, and updates refactor ([89a2c9d](https://github.com/mdopp/servicebay/commit/89a2c9da3bf90a881204e9b94b08531855f711e1))
* **network:** implement dual-state visualization for Services and Pods ([edb168e](https://github.com/mdopp/servicebay/commit/edb168ecad4e8e066fc6f19f726e96bfd6dcc6d1))
* **network:** optimize graph generation and handle missing nodes ([835ee4c](https://github.com/mdopp/servicebay/commit/835ee4cd2c9402ed9efbf88c8e7c12a0d29486e4))
* optimize install script to use separate deps bundle ([a0f6999](https://github.com/mdopp/servicebay/commit/a0f6999cdecc0f6a23ac1265742d873a59328612))
* optimized update bundle ([039d61c](https://github.com/mdopp/servicebay/commit/039d61ccd2d9c2ba79bc3092818c73af92e1e054))
* persist ssh keys in data volume and auto-configure host remote access ([28c7742](https://github.com/mdopp/servicebay/commit/28c7742284e1e880cac49dc92254acf1c7d4a563))
* prompt for port during installation ([9c5c5d8](https://github.com/mdopp/servicebay/commit/9c5c5d8dbdee155966836e5e3e71465ddb1da243))
* real-time monitoring, live logs, history system, and deployment fixes ([f2711f0](https://github.com/mdopp/servicebay/commit/f2711f0959ec3436b7ad9843395f9e8278204239))
* rebrand to ServiceBay, add auth, setup CI/CD ([1d19632](https://github.com/mdopp/servicebay/commit/1d1963258ebad8f24c94ff0df55145b59b7836e0))
* replace browser confirm dialogs with custom ConfirmModal ([b0f5c45](https://github.com/mdopp/servicebay/commit/b0f5c45443468916c592292f167b698bfa2c37ca))
* **security:** Implement configuration encryption and automatic migration ([821db55](https://github.com/mdopp/servicebay/commit/821db55c50dfa7602d7af29b57a5e5f9ba030212))
* **service-form:** add copy-all, scrollbar and replace alerts with toasts ([15d1ba4](https://github.com/mdopp/servicebay/commit/15d1ba4dc4e850f9bbaeaf9ca7e2af14d26e392b))
* **service-form:** add responsive mobile layout for volume helper ([4f1fdfa](https://github.com/mdopp/servicebay/commit/4f1fdfa938f799dc0b8f2673737c6ec1ba5574b0))
* **service-form:** moved volume helpers to sidebar layout ([811056b](https://github.com/mdopp/servicebay/commit/811056b656cabbdd07aa46da7fd87f3a1ac3c73c))
* **settings:** add system connections management ([58c0017](https://github.com/mdopp/servicebay/commit/58c0017502b3b436c9a44525d56c919c41f87beb))
* show hostname in external link nodes ([dfeed3c](https://github.com/mdopp/servicebay/commit/dfeed3cb60a0e3d9993297afca0cfe2f17bfa7d6))
* split base image into prod and dev variants ([034f558](https://github.com/mdopp/servicebay/commit/034f558d97056b8704cd68fa1aeb999fd0bd3c20))
* standardise data fetching with cache provider and notifications ([6924aa7](https://github.com/mdopp/servicebay/commit/6924aa75da7df394d921043789de3fe098bf1da9))
* support .container files and fix gateway visibility ([6e102ae](https://github.com/mdopp/servicebay/commit/6e102ae3862a890a66e3aad8e18f04c0a9685e77))
* support axel for accelerated downloads in install script ([d6f09de](https://github.com/mdopp/servicebay/commit/d6f09dee5c594c05d3d613cbd08b027a6b61a53f))
* **ui:** standardize headers, improve mobile layout, and add network search ([9e0ae00](https://github.com/mdopp/servicebay/commit/9e0ae00a03aaaf549064aede46c1a46a10177614))
* unified view for containers and services across all servers ([731b410](https://github.com/mdopp/servicebay/commit/731b410dc0f71d27fb2b181d9222ca52b6afcab6))
* update network graph layout, monitoring, and system discovery ([e82312e](https://github.com/mdopp/servicebay/commit/e82312ea1528c0abc972a6499acb62160566daad))
* Update service list UI to show clickable URLs and descriptions for all services ([c4ad771](https://github.com/mdopp/servicebay/commit/c4ad7715b9aad37d024b2b21c2e832a749a09bbf))
* v3 network map with nginx and fritzbox integration ([214743a](https://github.com/mdopp/servicebay/commit/214743a5748eb0ab3585a6bea7470fa0f5806b64))
* **v4.1:** finalize reactive digital twin architecture ([728135d](https://github.com/mdopp/servicebay/commit/728135d735738e97892d294a42cdda3cf1b6071a))
* visualize verified domains on target nodes in network graph ([8dba3bd](https://github.com/mdopp/servicebay/commit/8dba3bdf8b5edcf5f7cf95bb04b0fb390337555e))
* visualize verified domains on target nodes instead of edge labels ([0404e7d](https://github.com/mdopp/servicebay/commit/0404e7d8a5dbab0f693aa604f6266e31ea4b08c5))
* **volumes:** filter anonymous/system volumes ([5901e61](https://github.com/mdopp/servicebay/commit/5901e61c54ba67a3d65bf7cf47ba307419f3d9ac))
* **volumes:** multi-node volume list, usage tracking and UI improvements ([ce613c9](https://github.com/mdopp/servicebay/commit/ce613c9aab40eb4afe99d2f98588e92cfc18e6e2))


### Bug Fixes

* add build tools check and error handling for native modules ([06d149a](https://github.com/mdopp/servicebay/commit/06d149a1d57630e308d9120f490f76e864f9303e))
* add isManual property to NetworkEdge type definition ([9f62bbd](https://github.com/mdopp/servicebay/commit/9f62bbd713adb6006b0db28afb39bf5943036c32))
* add network map to sidebar ([8e50533](https://github.com/mdopp/servicebay/commit/8e505334217b2bc2d93eb383c2460bf6beb3ac6c))
* add packages:write permission to release workflow ([119a233](https://github.com/mdopp/servicebay/commit/119a233d281768388854318b3a1ae86ab6e07614))
* add podman to base image and resolve peer deps ([651999c](https://github.com/mdopp/servicebay/commit/651999c7cd4251c56d63f45dbe125245b3271313))
* add write permissions to release workflow ([dcc6bbb](https://github.com/mdopp/servicebay/commit/dcc6bbb71c4d355964cb413d35a975c049cda1fa))
* **agent:** correctly assign inherited ports to service object ([78d3336](https://github.com/mdopp/servicebay/commit/78d33362d610c893466b659de8b16c44a6600844))
* **agent:** properly terminate podman events subprocess on shutdown to prevent leaks ([f7d21f7](https://github.com/mdopp/servicebay/commit/f7d21f74c3bf5e2bb6f3e8c8b5beb667a32d7065))
* allow husky to fail in production builds ([6097b00](https://github.com/mdopp/servicebay/commit/6097b00819e140ed4462b39f6227cd06da35a13c))
* allow user input in curl-pipe-bash installation ([3da0e97](https://github.com/mdopp/servicebay/commit/3da0e97b779cd38f8cf3cb544d81231fc66072f3))
* **build:** remove unused ts directive and fix services api logic ([e40eb31](https://github.com/mdopp/servicebay/commit/e40eb3197d93973c5b3031f3f87f5a7bb262be34))
* bundle dependencies in release to avoid compilation on host ([99b1035](https://github.com/mdopp/servicebay/commit/99b103546fc80529019f21a14ddeec9367f1add8))
* bundle server.ts with esbuild to include local dependencies ([210947f](https://github.com/mdopp/servicebay/commit/210947ff0fc61cc6666df04b54961419d4a14aa5))
* **cache:** ensure getCache is stable and reads latest state to prevent unnecessary re-fetching ([83b376d](https://github.com/mdopp/servicebay/commit/83b376d85ec2496055a4ed347663556c2e3e428e))
* **ci:** Remove redundant 'run' argument from test command ([83c89a8](https://github.com/mdopp/servicebay/commit/83c89a853398dd5b4fdd42e089ea9dc91db9e217))
* **containers:** deduplicate containers when local machine is also configured as remote node ([1b0c8c2](https://github.com/mdopp/servicebay/commit/1b0c8c267b47bf74595c7a6710f545091071a84f))
* **discovery:** prevent managed .container Quadlets from appearing as unmanaged ([bd0fac3](https://github.com/mdopp/servicebay/commit/bd0fac3f0b3e0898eaf0ea682c9ceeb099ef2cd8))
* display correct port in install success message during updates ([1ff8735](https://github.com/mdopp/servicebay/commit/1ff8735b67fac2634cd73266fcbaf85c6ce4be9f))
* **docker:** explicitly install openssh-keygen to ensure availability ([40ccf60](https://github.com/mdopp/servicebay/commit/40ccf60b5a40a5538d6b7f7d19be4de761949163))
* **docker:** install openssh-client to provide ssh-keygen in runner image ([7a65799](https://github.com/mdopp/servicebay/commit/7a65799a9cd6f245a6e046415c7e3fd1bbafcc8c))
* **docker:** install podman cli to enable self-update and host management ([8468f43](https://github.com/mdopp/servicebay/commit/8468f431935f116b594d6c61ebd1f18110c31240))
* ensure deps tarball is created correctly in release workflow ([2e14cbc](https://github.com/mdopp/servicebay/commit/2e14cbc9dc74a12d84eb26942a15d7af1ba02a90))
* ensure logs loading state is cleared if response body is null ([e117d9f](https://github.com/mdopp/servicebay/commit/e117d9f14d09d7ffc432658d513d98ac73ed8294))
* Ensure service description is fetched even if service is inactive ([49c4efd](https://github.com/mdopp/servicebay/commit/49c4efdfd4ef3a4859f3c16fd99546f259dfa2df))
* exclude .next directory from vitest ([0821201](https://github.com/mdopp/servicebay/commit/08212013798a1cbb88092b9fd87429dedf2e8cca))
* explicit node handling in network graph generation ([fe76b30](https://github.com/mdopp/servicebay/commit/fe76b3052802c47421d8cc856e02e3112eac3fec))
* FCOS installer - added intermediate directory entries to ensure correct user ownership of ~/.config ([d4af79d](https://github.com/mdopp/servicebay/commit/d4af79d69bc1e87a8da543beae2950621a28f0b1))
* FCOS installer - added podman.socket enablement and restart policy ([2419278](https://github.com/mdopp/servicebay/commit/2419278ddbfa211f307832ad995f89e810ad5f38))
* **frontend:** enable Service Monitor to display Gateway network data ([8c07355](https://github.com/mdopp/servicebay/commit/8c07355ed7d6dc2920864815ebcf150e09ef2d1f))
* **frontend:** ensure reverse proxy and servicebay cards appear for agent v4 services ([e6bbc4d](https://github.com/mdopp/servicebay/commit/e6bbc4d34e2cb52b85fdaf3931696e4b55b4bc5f))
* **frontend:** ensure reverse proxy card appears for agent v4 services ([a07f0cc](https://github.com/mdopp/servicebay/commit/a07f0cc9c1ea56448e490cf25b87089f0b9545d2))
* **frontend:** improve Gateway and Proxy node details ([37a7778](https://github.com/mdopp/servicebay/commit/37a7778a1feb400424882a162d9b099e923561af))
* **frontend:** improve Network Graph visibility in dark mode ([943d4fd](https://github.com/mdopp/servicebay/commit/943d4fd07c5351d3dd5a2fb9d15e8eb1b6f1a1c9))
* **frontend:** resolve aliasing for Nginx managed status and fix broken test ([030bec3](https://github.com/mdopp/servicebay/commit/030bec30a783ddec68339c82ed8678a00b69d577))
* **frontend:** update Network Graph styles for Gateway node ([f0083db](https://github.com/mdopp/servicebay/commit/f0083dbf7449a3a190858719dfc0dcd210ac1107))
* handle multi-doc yaml and localized auth prompts ([856c0b1](https://github.com/mdopp/servicebay/commit/856c0b1195aa7f070a0fee89091dac261c2e698b))
* handle systemctl enable failure for transient units in install script ([d564e86](https://github.com/mdopp/servicebay/commit/d564e86e5b17350070a16fef08d68155bbdd13e7))
* hostname, login debug, install config backup ([6833b32](https://github.com/mdopp/servicebay/commit/6833b32ce30ae73a195a8d46ead2279e75680697))
* improve dependency check robustness and clarity ([09c287f](https://github.com/mdopp/servicebay/commit/09c287fd253a715b303b6346e7504aa8c1785ab3))
* improve network map colors for dark mode ([96e228d](https://github.com/mdopp/servicebay/commit/96e228d9a273a0e71efc8bb12bcd86bb6eaad572))
* include next.config.ts and typescript in release bundle ([2e340a6](https://github.com/mdopp/servicebay/commit/2e340a67340dc0704c309a600b64fce39daa2f22))
* include package-lock.json in release commit ([b1d9865](https://github.com/mdopp/servicebay/commit/b1d98659003510bfdecc06d44982df58ec29d0a0))
* include package.json in release and run npm install ([15514a3](https://github.com/mdopp/servicebay/commit/15514a3ae1b5a6d000d29ea557608cc120e0efd9))
* include socket.io and node-pty in standalone build ([b74cf49](https://github.com/mdopp/servicebay/commit/b74cf498cf8b7b1f4ef8b9776a39c924d5b9e6a3))
* inject type into rawData for containers and services, improve system container filter ([1b7d92c](https://github.com/mdopp/servicebay/commit/1b7d92ca97fd1e0dee605a6f8fdc1c105f347812))
* install typescript in runner and fix permissions ([7ba8925](https://github.com/mdopp/servicebay/commit/7ba89258e5a46c4c79f200654ba85b9d37879f5a))
* **install:** display command to reveal hidden password ([6c50e77](https://github.com/mdopp/servicebay/commit/6c50e77b405853bdac013dee618f62077733c5fe))
* monitor podman.socket instead of podman.service ([8fa7685](https://github.com/mdopp/servicebay/commit/8fa7685e3fcf83a4166a184676bd27950a90de99))
* **network:** enforce strict localhost routing and improve port mapping logic ([3550e37](https://github.com/mdopp/servicebay/commit/3550e37f759ca4180b711a03bdd84530e1448b44))
* **network:** fallback to Quadlet definition for graph discovery ([5e07df3](https://github.com/mdopp/servicebay/commit/5e07df33b41c11dfa521a36f2fbd7f1ad634a962))
* **network:** handle Nginx targets by Name/Label and improve raw data robustness ([c999242](https://github.com/mdopp/servicebay/commit/c999242e99174cc5cfe5aebe26f1c7d1ca22f520))
* **network:** improve graph layout, grouping and styling ([2b0b7c1](https://github.com/mdopp/servicebay/commit/2b0b7c19cdddaf6bde4d92578e8726fc8217cc30))
* **network:** improve Nginx target resolution and localhost visualization ([b11aafe](https://github.com/mdopp/servicebay/commit/b11aafed03e806e576b9fdc6b52c98714e615602))
* **network:** resolve duplicated code block in service.ts caused by merge error ([6d1832d](https://github.com/mdopp/servicebay/commit/6d1832d2679be7c443bf79e9bd2a7b504d04ebf0))
* **network:** resolve incorrect network graph layout and edges ([5106fb2](https://github.com/mdopp/servicebay/commit/5106fb2972602b6492f3c8ee07143fd18ad88216))
* **network:** resolve missing raw data for Gateway node ([f04c600](https://github.com/mdopp/servicebay/commit/f04c600c37b897f6de751a86c79b2d9837dc00b4))
* optimize curl download with retries and compression ([1ae681e](https://github.com/mdopp/servicebay/commit/1ae681e63a61b2331f4b28e74fbe7daeb52449f2))
* overwrite installation instead of delete-and-restore to preserve node_modules safely ([b204b81](https://github.com/mdopp/servicebay/commit/b204b81c33d0443cb47c39460308d855f0102b8e))
* populate rawData for external links and show details in network sidebar ([da07c59](https://github.com/mdopp/servicebay/commit/da07c5934a0980918a01ce57a7be6f1b24c0b923))
* read from /dev/tty in install script to support curl | bash ([316d69a](https://github.com/mdopp/servicebay/commit/316d69ac610ddafb419f8c7636c95f46760169f4))
* read from /dev/tty in uninstall script to support curl | bash ([e5cdff1](https://github.com/mdopp/servicebay/commit/e5cdff1effe0c5d88b2adc1e81419ea75703d50d))
* remove deleted UpdatesPlugin from registry ([b8671e4](https://github.com/mdopp/servicebay/commit/b8671e4214155a0ce74c9e2789496e60e1f3f13e))
* remove implicit local node handling from network graph ([20c083f](https://github.com/mdopp/servicebay/commit/20c083f53b83d93267376343c9cccf970b46378d))
* remove prepare script before npm install in installer ([79b395f](https://github.com/mdopp/servicebay/commit/79b395fbb8cc194e5d3ef3b65d4b5f3ddd7c2b48))
* remove stray command from release script ([220c8fd](https://github.com/mdopp/servicebay/commit/220c8fdb6424c4bc0d4116c96dfdcef040923181))
* remove unused config fetch causing build error ([570b9bc](https://github.com/mdopp/servicebay/commit/570b9bc0bd635232e08c3ad2493f3a83f17bfb57))
* resolve indentation issues in agent.py linking logic ([69c068b](https://github.com/mdopp/servicebay/commit/69c068b290b34acb260625f7e4252bf8f918d772))
* resolve linter errors and suppress explicit any ([948407e](https://github.com/mdopp/servicebay/commit/948407ebbe5e465db2732204bf61216a651c377c))
* resolve missing Reverse Proxy ports and linting errors ([2da19c4](https://github.com/mdopp/servicebay/commit/2da19c4d56d266dff51cea4c201f3ea3d4264893))
* resolve syntax error in agent.py and remove deprecated husky config ([4db57fd](https://github.com/mdopp/servicebay/commit/4db57fd880c7bd80e4851e9e52f31b152408801b))
* resolve type error in service injection ([59fe75f](https://github.com/mdopp/servicebay/commit/59fe75f93d7e063f62ae43ec05816bc125016ace))
* resolve typescript error in executor error handling ([fd93239](https://github.com/mdopp/servicebay/commit/fd93239c6cfb95f507d9ec082e739074c87d0ed1))
* resolve updater process hang and local hostname lookup issues ([3c4c266](https://github.com/mdopp/servicebay/commit/3c4c266f397aa5483a723a37c87e3ca2c649a5c6))
* restore local node support in graph generation ([e3764d2](https://github.com/mdopp/servicebay/commit/e3764d2c0c4d22f60354241dc11505e5cbd5648b))
* revert curl progress bar to show download details ([b19857e](https://github.com/mdopp/servicebay/commit/b19857e2625948b0d56fcd121ebb10ef08be455a))
* robust install script and updater hidden files ([51b4e39](https://github.com/mdopp/servicebay/commit/51b4e39a9f5140eb0aeb719d275f0f25f16a627f))
* run container as root to fix volume permission issues with bind mounts ([563944d](https://github.com/mdopp/servicebay/commit/563944dd5e3db61be88f76ba52915d380dcd581c))
* **services:** deduplicate service aliases and add gateway ports ([4dda151](https://github.com/mdopp/servicebay/commit/4dda15165475db75fe512104dd5e5ee8189b9337))
* **services:** resolve missing ports for stopped and proxy services ([719e568](https://github.com/mdopp/servicebay/commit/719e5684f9ee4e35f8149d4967732d93451bb8cb))
* **ui:** consolidate terminal headers ([484dbeb](https://github.com/mdopp/servicebay/commit/484dbeb1b050d17b9bd8d7d2b867f4a6e3cd0d9e))
* **ui:** prevent network sidebar header overflow ([cbf18ca](https://github.com/mdopp/servicebay/commit/cbf18cab2c100796bac330eaae00ae8e2a5a3e06))
* update Dockerfile to run custom server.ts with tsx ([abcb896](https://github.com/mdopp/servicebay/commit/abcb896556d65e0d501f1aaf6b4c9451efffa867))
* use global variable for Socket.IO instance in updater to support Next.js bundling ([91ac382](https://github.com/mdopp/servicebay/commit/91ac3821690e23dbf345a8a0ceed281c82645724))


### Performance Improvements

* Implement detailed network progress reporting and fix double-fetch issues ([3947816](https://github.com/mdopp/servicebay/commit/3947816c08b623fd699b11e314f0e2ffcdf62f5e))
* skip auto-refresh of services list if cache exists ([d8ab4f0](https://github.com/mdopp/servicebay/commit/d8ab4f09de3086dc96fdaef902e4919dc7d7b075))

## [Unreleased]

## [2026.1.70] - 2026-01-12
- **Installer**: Added interactive version selection to `install.sh` and `install-fedora-coreos.sh`, allowing users to install specific versions of ServiceBay (defaults to `latest`).
- **Security**: Sensitive data (passwords, tokens) in `config.json` is now automatically encrypted using AES-256-GCM.
- **Fixed**: Resolved a crash in `ssh-copy-id` (used during "Setup SSH Keys") by forcing creation of `~/.ssh` inside the container before execution. This fixes the `mktemp` error on minimal environments like Fedora CoreOS.
- **Fixed**: Resolved `execvp(3)` failure in Host Terminal sessions by ensuring a valid Shell path (from ENV) and a valid Working Directory (fallback to root if HOME is missing).
- **Fixed**: Resolved an issue where stopped services would show no ports in the configuration view. The system now correctly parses the configuration files to display expected ports even when the service is offline.
- **Fixed**: Fixed an issue where secondary listening ports (e.g., Nginx :81) were sometimes missing from the Service Monitor and Network Graph.
- **Fixed**: Improved accuracy of "Raw Data" views by strictly adhering to the configured Single Source of Truth, eliminating discrepancies between the graph and the details panel.
- Fixed missing port display in Containers tab due to property name mismatch (snake_case vs camelCase).
- Removed `ports` property from NetworkNode entirely. Frontend now strictly uses `rawData.ports`.
- Improved network graph reliability.
- Fixed missing network data for multi-container services (e.g. immich).
- Improved Network Layout consistency.

### Added
- **System Info**: "Compute Resources" card now displays CPU Model and Core Count for deeper hardware visibility.
- **Installer**: Fixed permissions crash and missing Podman Socket activation in the new Fedora CoreOS installer.
- **Installation**: New generic Fedora CoreOS installer script (`install-fedora-coreos.sh`) for rapid, rootless deployments.
- **Settings**: New "Template Settings" section to configure global stack variables (e.g., `STACKS_DIR`), enabling portable and reusable service templates.
- Added `LOGIN_REQUIRED` configuration option to allow passwordless access in development or trusted environments (Default: true).
- **Logging**: Improved server logging format for better readability and debugging.

### Changed
- **Performance**: Optimized the Node Agent to use passive file watching (Inotify) instead of polling, improving system efficiency.
- **Config**: Moved **Internet Gateway** configuration from the Registry Browser to the main **Settings** page.
- **Gateway**: Internet Gateway configuration is now managed via the central settings file instead of environment variables.
- **Reverse Proxy**: Explicitly identifies "Nginx" as "Reverse Proxy (Nginx)" with status information in the services list.
- Improved error messages when a node agent is disconnected (now shows a helpful toast).
- Internet Gateway and External Links are now visible on your Default/Home server (previously only on Local).
- Unmanaged services list now displays the node/server name where they were discovered.
- Systemd service listing now performs a health check and reports an error if the user session is inaccessible (e.g., DBUS errors).
- **System Info**: The System Information panel now updates in real-time and loads instantly without manual refresh.
- **Services**: The service list now strictly shows only services managed by ServiceBay (Quadlet `.container`, `.kube`, and `.pod` files), hiding unrelated system services.

### Fixed
- **Dashboard**: Improved navigation reliability by enforcing strict name matching for service details pages.
- **Dashboard**: Resolved data inconsistencies where the "Proxy Node" would sometimes display information from the wrong service (inactive duplicate). Now strictly links to the active system Proxy.
- **Dashboard**: Fixed an issue where an inactive proxy service (e.g., `compose-nginx`) was displayed instead of the running instance.
- **Dashboard**: Improved "Network Details" panel in Service Monitor to show Image Name, Systemd State, and Container ID directly.
- **Dashboard**: "Raw Data / Config" for Services now includes full Container details (Image, Runtime Status, Labels).
- **Dashboard**: Added full Service details (Active State, Load State) to the "Raw Data / Config" view for the Nginx Proxy.
- **Dashboard**: Fixed missing "Ports" data in the "Raw Data / Config" view for the Nginx Reverse Proxy service.
- **Dashboard**: Fixed missing Container Logs and empty Container List in Service Monitor.
- **Dashboard**: Fixed an issue where system services like `mpris-proxy` were incorrectly displayed as Reverse Proxies.
- **Dashboard**: Fixed an issue where duplicates of the Reverse Proxy service would appear. Now intelligently merges aliases (e.g., `nginx-web`, `nginx`) into a single card.
- **Dashboard**: The Gateway card (FritzBox) now displays active port mappings (UPnP).
- **Dashboard**: Fixed an issue where the Nginx Reverse Proxy on remote nodes was incorrectly shown as "Unmanaged" (missing YAML/Kube badge) due to a file naming mismatch.
- **Dashboard**: Fixed an issue where the Nginx Reverse Proxy and ServiceBay System cards were missing or mislabeled when using the latest Agent V4.
- **Agent**: Reduced log noise by quieting debug messages related to Nginx route parsing.
- **Stability**: Fixed a bug where the agent would excessively update the server when configuration files were touched but unchanged.
- **Network Graph**: Fixed Nginx Reverse Proxy node appearing detached or missing connections due to container naming mismatches in Podman Kube environments.
- Fixed an issue where the Nginx Reverse Proxy service would incorrectly show as "DOWN" in the Service Monitor despite being active.
- Added detailed "Active State" and "Sub State" fields to the Raw Data view in Service Monitor.
- Fixed internal error when one of the system containers is stopped. 
- Fixed Reverse Proxy service ports not showing up for some configurations. 
- **Fixed**: Fixed an issue where the "Verified Domain" badge was missing for services running on non-standard ports.
- **Fixed**: ServiceBay now correctly identifies the Nginx container even if named `nginx` instead of `nginx-web`.
- **Fixed**: Improved port detection for "Host Network" containers. ServiceBay now correctly detects listening ports bound by child processes (like Nginx workers) instead of just the main process.

## [2026.1.68] - 2026-01-07
### Fixed
- **Dashboard**: Improved navigation reliability by enforcing strict name matching for service details pages.
- **Dashboard**: Resolved data inconsistencies where the "Proxy Node" would sometimes display information from the wrong service (inactive duplicate). Now strictly links to the active system Proxy.
- **Dashboard**: Fixed an issue where an inactive proxy service (e.g., `compose-nginx`) was displayed instead of the running instance.
- **Dashboard**: Improved "Network Details" panel in Service Monitor to show Image Name, Systemd State, and Container ID directly.
- **Dashboard**: "Raw Data / Config" for Services now includes full Container details (Image, Runtime Status, Labels).
- **Dashboard**: Added full Service details (Active State, Load State) to the "Raw Data / Config" view for the Nginx Proxy.
- **Dashboard**: Fixed missing "Ports" data in the "Raw Data / Config" view for the Nginx Reverse Proxy service.
- **Dashboard**: Fixed missing Container Logs and empty Container List in Service Monitor.
- **Dashboard**: Fixed an issue where system services like `mpris-proxy` were incorrectly displayed as Reverse Proxies.
- Type error in `executor.ts` causing build failure.
- Container running as root (UserNS=keep-id) to fix volume permission issues.
- Missing `npm run build` verification before release in instructions.

## [2026.1.66] - 2026-01-07
### Added
- Installer prompts for Host IP address.
- SSH troubleshooting hints in UI logs.
### Changed
- `install.sh` sets specific permissions on generated SSH keys.

## [2026.1.65] - 2026-01-07
### Added
- Persistent SSH key storage in `/app/data/ssh`.
- Auto-configuration of "Host" node in `install.sh`.
