# Changelog

All notable changes to this project will be documented in this file.

## [4.154.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.153.1...servicebay-v4.154.0) (2026-07-12)


### Features

* **assists:** assists-catalog editor backend + config-render escaping and map-merge regression fixes ([5b0ac92](https://github.com/mdopp/servicebay/commit/5b0ac92d53efec0223e8041fe28be881b298407c))
* **assists:** backend REST API for the assists catalog editor ([bbd5656](https://github.com/mdopp/servicebay/commit/bbd5656366cecf924d17eb1f1388458820ae808e)), closes [#2221](https://github.com/mdopp/servicebay/issues/2221)


### Bug Fixes

* **config-render:** escape double-quote in YAML scalars and handle CRLF forward-auth sentinel ([9732920](https://github.com/mdopp/servicebay/commit/9732920cf3e682ecc3056da77b8624baacc1aa8c)), closes [#2224](https://github.com/mdopp/servicebay/issues/2224)
* **dashboards:** merge fresh className/type on in-place map poll ([eb36b12](https://github.com/mdopp/servicebay/commit/eb36b126ad1024ca4c2eb6f22717a4bc61460ec8)), closes [#2225](https://github.com/mdopp/servicebay/issues/2225)

## [4.153.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.153.0...servicebay-v4.153.1) (2026-07-11)


### Bug Fixes

* **install,reverseProxy:** preserve omitted secrets + escape multi-line pod YAML; strip duplicate websocket proxy_http_version ([75d85b5](https://github.com/mdopp/servicebay/commit/75d85b59fc9c36cd8748fb8ea05fd3e7dc9b434c))
* **install:** preserve omitted secrets on partial update; escape newlines in pod YAML ([ecaca27](https://github.com/mdopp/servicebay/commit/ecaca278ac86880e546b828bca1b232f0bae98b7)), closes [#2206](https://github.com/mdopp/servicebay/issues/2206)
* **reverseProxy:** strip duplicate proxy_http_version on websocket routes ([df37d7c](https://github.com/mdopp/servicebay/commit/df37d7cca958a4a14e5b4ee74357337b890509b9)), closes [#2205](https://github.com/mdopp/servicebay/issues/2205)

## [4.153.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.152.1...servicebay-v4.153.0) (2026-07-11)


### Features

* **mcp:** task-assist catalog + list_assists/get_assist ([#2146](https://github.com/mdopp/servicebay/issues/2146), [#2145](https://github.com/mdopp/servicebay/issues/2145)) ([333ca8d](https://github.com/mdopp/servicebay/commit/333ca8df9c90d8ab92ccd64579028b591e913a06))
* **mcp:** task-assist catalog + list_assists/get_assist tools ([#2146](https://github.com/mdopp/servicebay/issues/2146)) ([fe44a5b](https://github.com/mdopp/servicebay/commit/fe44a5be02799c7edd258728e6ba1d5c765d5960))

## [4.152.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.152.0...servicebay-v4.152.1) (2026-07-11)


### Bug Fixes

* **proxy:** authSkipPaths location must not add its own proxy_pass ([#2210](https://github.com/mdopp/servicebay/issues/2210)) ([c216cf1](https://github.com/mdopp/servicebay/commit/c216cf1f91704397d59608f56150ca63999dc93a))
* **proxy:** authSkipPaths location must not add its own proxy_pass ([#2210](https://github.com/mdopp/servicebay/issues/2210)) ([9694bfc](https://github.com/mdopp/servicebay/commit/9694bfcdb2a4b993e289fdef8b9e66e98ad5e31c))

## [4.152.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.151.0...servicebay-v4.152.0) (2026-07-11)


### Features

* **proxy:** per-path forward-auth exceptions via authSkipPaths ([#2210](https://github.com/mdopp/servicebay/issues/2210)) ([974674d](https://github.com/mdopp/servicebay/commit/974674da3d01acdf1c60f963f878c432e0829548))
* **proxy:** per-path forward-auth exceptions via authSkipPaths ([#2210](https://github.com/mdopp/servicebay/issues/2210)) ([34fc2b5](https://github.com/mdopp/servicebay/commit/34fc2b5a7a5d3075df25bc4c8cb6a8c832d01ac8))

## [4.151.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.150.4...servicebay-v4.151.0) (2026-07-11)


### Features

* **home:** surface pending MCP approvals on the Home page ([5cf29d6](https://github.com/mdopp/servicebay/commit/5cf29d6d25c9656e4b23e16678c4dc7f75fc0755))
* **home:** surface pending MCP approvals on the Home page ([32f5d1c](https://github.com/mdopp/servicebay/commit/32f5d1c3ec430aaffea456573f60f1eab470be23))


### Bug Fixes

* **immich:** migrate DB from pgvecto.rs to VectorChord (immich v3) ([dcb8977](https://github.com/mdopp/servicebay/commit/dcb8977b36e2138ec759296e26b30984f9339d29))
* **immich:** migrate DB from pgvecto.rs to VectorChord (immich v3) ([3b94ad3](https://github.com/mdopp/servicebay/commit/3b94ad36a8fd2c5c921f16de4169d8e2e57e7a3f))
* **network:** preserve collapsed/summary/onToggle across mergeInPlace ([#2201](https://github.com/mdopp/servicebay/issues/2201)) ([f76e07c](https://github.com/mdopp/servicebay/commit/f76e07c13ac15323eea96a4232310d8704221e4e))
* **network:** preserve collapsed/summary/onToggle across mergeInPlace ([#2201](https://github.com/mdopp/servicebay/issues/2201)) ([cce5fee](https://github.com/mdopp/servicebay/commit/cce5feef66a250a07f85db37d8c6794f0e1dc590))
* **network:** stop mergeInPlace from stacking collapsed-service containers ([#2201](https://github.com/mdopp/servicebay/issues/2201)) ([129466d](https://github.com/mdopp/servicebay/commit/129466dba62a976a83d563e9c4c4cc6a1a0f10da))
* **network:** stop mergeInPlace stacking collapsed-service containers ([#2201](https://github.com/mdopp/servicebay/issues/2201)) ([de14668](https://github.com/mdopp/servicebay/commit/de14668cceba622f9840c7e3a19d1fc7b3e57b26))
* **ui:** calm the mobile "ServiceBay restarted" reload prompt ([fd9bb5a](https://github.com/mdopp/servicebay/commit/fd9bb5a5fbbbf8df7eecdb823e3cfe97e6dfcf4c))
* **ui:** calm the mobile "ServiceBay restarted" reload prompt ([#2203](https://github.com/mdopp/servicebay/issues/2203)) ([fbea701](https://github.com/mdopp/servicebay/commit/fbea7012670ea939ae2fd7b4cf4fccfd8a8e54ba))

## [4.150.4](https://github.com/mdopp/servicebay/compare/servicebay-v4.150.3...servicebay-v4.150.4) (2026-07-08)


### Bug Fixes

* **map:** resolve cross-hierarchy inferred edges (root INCLUDE_CHILDREN) so containers stop stacking ([08c061d](https://github.com/mdopp/servicebay/commit/08c061dd63482df95c90b664be660ae360d0e5f2))
* **map:** set top-level node width/height for React Flow v12 so containers position inside their group ([56a9e57](https://github.com/mdopp/servicebay/commit/56a9e57e830129921aee3daa91eb4e628dcc9eef))
* **network:** resolve cross-hierarchy ELK edges via root INCLUDE_CHILDREN ([1f57428](https://github.com/mdopp/servicebay/commit/1f574282683b9c3e8dce92b344f3f0a0286e1f74)), closes [#2198](https://github.com/mdopp/servicebay/issues/2198)
* **network:** set top-level node width/height for React Flow v12 ([921c513](https://github.com/mdopp/servicebay/commit/921c5131fe82e84cfcbae4eb4448e2b2cda9e5e7)), closes [#2201](https://github.com/mdopp/servicebay/issues/2201)

## [4.150.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.150.2...servicebay-v4.150.3) (2026-07-08)


### Bug Fixes

* **dashboards:** render service-group children in their ELK slots so they stop stacking ([2370ac3](https://github.com/mdopp/servicebay/commit/2370ac3b374032becec793080521adb76990b1dc)), closes [#2194](https://github.com/mdopp/servicebay/issues/2194)
* **dashboards:** stop the 'Refreshing Network' toast firing on every twin update ([1fa9a35](https://github.com/mdopp/servicebay/commit/1fa9a35b3759349bc45376b147e2be467df3283b)), closes [#2195](https://github.com/mdopp/servicebay/issues/2195)
* **map:** child containers render in their group slot (no stacking) + silence per-poll refresh toast ([00c888b](https://github.com/mdopp/servicebay/commit/00c888bb697bd37b3af9ead6bac12cf971ba4e70))

## [4.150.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.150.1...servicebay-v4.150.2) (2026-07-08)


### Bug Fixes

* **network:** grow service group around its containers (per-node INCLUDE_CHILDREN) ([eee394c](https://github.com/mdopp/servicebay/commit/eee394caeae22cc3ccafb65d26799fd69bdce0c0))
* **network:** grow service group around its containers via per-node INCLUDE_CHILDREN ([2cc68e5](https://github.com/mdopp/servicebay/commit/2cc68e5aaeecfbf82d6c7ca2f672274cbb9568ed)), closes [#2191](https://github.com/mdopp/servicebay/issues/2191)

## [4.150.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.150.0...servicebay-v4.150.1) (2026-07-08)


### Bug Fixes

* **frontend:** add async feedback to regenerate/save buttons + Escape-close rename modal ([fc9c524](https://github.com/mdopp/servicebay/commit/fc9c5249429c284f9f6308b6de19a2eded922a90)), closes [#2186](https://github.com/mdopp/servicebay/issues/2186) [#2187](https://github.com/mdopp/servicebay/issues/2187) [#2188](https://github.com/mdopp/servicebay/issues/2188)
* **frontend:** async button feedback + Escape-close; test: cover reset/authelia/crashloop/backup-collector ([7be0112](https://github.com/mdopp/servicebay/commit/7be0112d198e1ca843881cb340ae105021b6a67d))

## [4.150.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.149.0...servicebay-v4.150.0) (2026-07-08)


### Features

* **network:** infer edges from env + anchor floating service cards ([917c1ee](https://github.com/mdopp/servicebay/commit/917c1ee97b3072f7bf8f736f68d8df84941ad4f1)), closes [#2175](https://github.com/mdopp/servicebay/issues/2175)
* **network:** map edge inference + layout overlap fix; fix(ollama): GPU CDI redeploy; deps ([5fd6152](https://github.com/mdopp/servicebay/commit/5fd6152c64c22a8b10c9d52e8279d92b8bbfddf7))


### Bug Fixes

* **network:** anchor floating map nodes after ubiquitous-dep suppression ([fe80027](https://github.com/mdopp/servicebay/commit/fe80027d97ac750428bdab8037e79b667ad6f32f))
* **network:** anchor floating nodes after ubiquitous-dep suppression ([a295d62](https://github.com/mdopp/servicebay/commit/a295d6226a19442d319f04c5d1ad5c0117375ed1)), closes [#2175](https://github.com/mdopp/servicebay/issues/2175)
* **network:** truthful ELK card heights + component packing to kill map overlap ([8e2d187](https://github.com/mdopp/servicebay/commit/8e2d18728fc7c434b5afcb8fa768ec467930a22b)), closes [#2176](https://github.com/mdopp/servicebay/issues/2176)
* **services:** retire kube-play shadow of the ollama GPU .container on redeploy ([38a4574](https://github.com/mdopp/servicebay/commit/38a45748f87e86862f9406e51d07ec5cc6ab3115)), closes [#2174](https://github.com/mdopp/servicebay/issues/2174)

## [4.149.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.148.1...servicebay-v4.149.0) (2026-07-07)


### Features

* **monitoring:** out-of-band breadcrumb for servicebay self crash-loop ([82f60f3](https://github.com/mdopp/servicebay/commit/82f60f37857457736c25d112a3c34b93e4f2bf88)), closes [#2159](https://github.com/mdopp/servicebay/issues/2159)
* **settings:** typed-confirmation modal for API token revoke ([52a1ec4](https://github.com/mdopp/servicebay/commit/52a1ec409c2c4f467a996bfa70cf306dc1095880)), closes [#2164](https://github.com/mdopp/servicebay/issues/2164)


### Bug Fixes

* **honcho:** re-key Postgres role password on reinstall-over-preserved-pgdata ([3b335f2](https://github.com/mdopp/servicebay/commit/3b335f25c58a40ced5a609560c5842c21dfe493a)), closes [#2165](https://github.com/mdopp/servicebay/issues/2165)
* **test:** use vi.stubEnv for NODE_ENV in prod-redaction lane ([5894e92](https://github.com/mdopp/servicebay/commit/5894e922da47c160a61030ab537f22b212821871))


### Performance Improvements

* **health:** cache HealthStore reads to keep diagnose/health off the sync-IO hot path ([c91098c](https://github.com/mdopp/servicebay/commit/c91098c79e38d8f955b46dd49f8d7065e931234c)), closes [#2163](https://github.com/mdopp/servicebay/issues/2163)

## [4.148.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.148.0...servicebay-v4.148.1) (2026-07-06)


### Bug Fixes

* **backup:** close manifest coverage gaps + add round-trip test + CI contract ([4c23618](https://github.com/mdopp/servicebay/commit/4c2361886480b85a2216b4a0de480120c3c13d24)), closes [#2153](https://github.com/mdopp/servicebay/issues/2153) [#2154](https://github.com/mdopp/servicebay/issues/2154)
* **install:** import EmitResult from capabilities/types not bus ([68e84af](https://github.com/mdopp/servicebay/commit/68e84afc97f22d4486662742dd968cb04ad5b9e2))
* **install:** surface silent install/capability/restore failures ([770f61a](https://github.com/mdopp/servicebay/commit/770f61a444205c9b26b321d103813dcb4d161885)), closes [#2158](https://github.com/mdopp/servicebay/issues/2158) [#2160](https://github.com/mdopp/servicebay/issues/2160) [#2161](https://github.com/mdopp/servicebay/issues/2161)
* **nginx:** stop swallowing reload/nginx_online failures on proxy hosts ([dbb03d3](https://github.com/mdopp/servicebay/commit/dbb03d3e3971e00a833c950c9d2fe45e9a51b056)), closes [#2156](https://github.com/mdopp/servicebay/issues/2156)
* **reverseProxy:** set busy_timeout + WAL on NPM rekey DB open ([d819a1b](https://github.com/mdopp/servicebay/commit/d819a1b9f2ff8330a2128c8a29f0ad49c42f1453)), closes [#2157](https://github.com/mdopp/servicebay/issues/2157)
* surface silent install failures + backup/nginx/npm-wal/release-smoke hardening ([3f30d49](https://github.com/mdopp/servicebay/commit/3f30d495627740c3414a2f7a1180b99cfb1915ed))

## [4.148.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.147.3...servicebay-v4.148.0) (2026-07-06)


### Features

* MCP proxy/install/token tools + forward-auth fixes + lockfile CI gate ([0b2bb45](https://github.com/mdopp/servicebay/commit/0b2bb454050e91e07ffc7674d845ac3931bdff79))
* **mcp:** full proxy-route creation, install_template, jailed write_file ([a2fa2bf](https://github.com/mdopp/servicebay/commit/a2fa2bf7618624f1d3af76fdfafc054ccab44248)), closes [#2140](https://github.com/mdopp/servicebay/issues/2140) [#2141](https://github.com/mdopp/servicebay/issues/2141) [#2142](https://github.com/mdopp/servicebay/issues/2142)
* **mcp:** scoped, admin-approved, self-expiring token request flow ([18c0504](https://github.com/mdopp/servicebay/commit/18c05048566ce049798be6dd671f0945bc8d527f)), closes [#2139](https://github.com/mdopp/servicebay/issues/2139)


### Bug Fixes

* **docker:** copy workspace node_modules in builder stage ([3de87e1](https://github.com/mdopp/servicebay/commit/3de87e196dc72a2758017b048f8f22038544bd57))
* **docker:** copy workspace node_modules in builder stage ([98cd90b](https://github.com/mdopp/servicebay/commit/98cd90ba25cab043e2cbc70908863036c4817ad4))
* **docker:** ship workspace-scoped runtime deps in the runner image ([#2152](https://github.com/mdopp/servicebay/issues/2152)) ([7744090](https://github.com/mdopp/servicebay/commit/774409020efb94a3e5a87aa500e1ad23d2028d9e))
* **install:** forward-auth acme collision + silent subdomain proxy skip ([57cee84](https://github.com/mdopp/servicebay/commit/57cee84e56de8e9223d65643532221775cbc6346)), closes [#2143](https://github.com/mdopp/servicebay/issues/2143) [#2144](https://github.com/mdopp/servicebay/issues/2144)

## [4.147.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.147.2...servicebay-v4.147.3) (2026-06-24)


### Bug Fixes

* **media:** single Jellyfin Media card on the portal ([#2135](https://github.com/mdopp/servicebay/issues/2135)) ([134f31f](https://github.com/mdopp/servicebay/commit/134f31f693406c5493b2217bcb808f489f0adebb))

## [4.147.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.147.1...servicebay-v4.147.2) (2026-06-23)


### Bug Fixes

* **portal:** show registry-installed services on /portal ([#2133](https://github.com/mdopp/servicebay/issues/2133)) ([f5b710f](https://github.com/mdopp/servicebay/commit/f5b710fc2696f60b3bf54f0576bc0e0a76473336))

## [4.147.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.147.0...servicebay-v4.147.1) (2026-06-23)


### Bug Fixes

* **deps:** regenerate package-lock.json to restore npm ci sync ([912692e](https://github.com/mdopp/servicebay/commit/912692e1caec8fe504c111f0e76646e21d7c4042))
* **deps:** regenerate package-lock.json to restore npm ci sync ([f71a2e9](https://github.com/mdopp/servicebay/commit/f71a2e9e86dbeb98d4d3587bc1e5302881c77588))

## [4.147.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.146.1...servicebay-v4.147.0) (2026-06-23)


### Features

* **portal:** redesign /portal as a uniform accented launcher grid ([999b363](https://github.com/mdopp/servicebay/commit/999b3634538edb5989be8a1e7421610aa56775b5))
* **portal:** redesign /portal as a uniform accented launcher grid ([c761e0d](https://github.com/mdopp/servicebay/commit/c761e0d6933b37a71573c6092ad39511da738ce4)), closes [#2126](https://github.com/mdopp/servicebay/issues/2126)

## [4.146.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.146.0...servicebay-v4.146.1) (2026-06-23)


### Bug Fixes

* **portal:** pack bento empty space to bottom + uniform CTA pattern ([28c68a4](https://github.com/mdopp/servicebay/commit/28c68a4e2c1e6d21ffd5550263d3434e5ef0dd0f))
* **portal:** pack bento empty space to bottom + uniform CTA-bottom pattern ([8d2931b](https://github.com/mdopp/servicebay/commit/8d2931b67954262829b5b8a1a452f0b4df13a040)), closes [#2123](https://github.com/mdopp/servicebay/issues/2123)

## [4.146.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.145.1...servicebay-v4.146.0) (2026-06-23)


### Features

* **portal,dashboards:** portal bento grid + Network Map no-reset on poll ([107859f](https://github.com/mdopp/servicebay/commit/107859fd3cb70851bf3f2d3943c95f884171aa0c))
* **portal:** bento/span grid with size-aware service cards ([1a05ddb](https://github.com/mdopp/servicebay/commit/1a05ddb00aad8e80fca1ca277d97c55e4977000b)), closes [#2120](https://github.com/mdopp/servicebay/issues/2120)


### Bug Fixes

* **dashboards:** stop Network Map re-layout + viewport reset on every poll ([8082d74](https://github.com/mdopp/servicebay/commit/8082d7487084f4e09acede1384342bf8284eda7c)), closes [#2119](https://github.com/mdopp/servicebay/issues/2119)

## [4.145.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.145.0...servicebay-v4.145.1) (2026-06-23)


### Bug Fixes

* **portal:** balanced equal-height card grid + collapse Syncthing pairing block ([8287188](https://github.com/mdopp/servicebay/commit/8287188831b44897b7a073aa2af4cb3228771115)), closes [#2116](https://github.com/mdopp/servicebay/issues/2116)
* **portal:** equal-height card grid + collapse Syncthing pairing block ([e8b3a8b](https://github.com/mdopp/servicebay/commit/e8b3a8bcca217cf64f938bc54a2bde470d0e1397))

## [4.145.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.144.1...servicebay-v4.145.0) (2026-06-23)


### Features

* **dashboards:** consistent Home tile headers, System/Data disk split + Last updated, mobile reorder ([ad93080](https://github.com/mdopp/servicebay/commit/ad930805fe604aee9edd20dc3a3e31db13becfae)), closes [#2103](https://github.com/mdopp/servicebay/issues/2103) [#2104](https://github.com/mdopp/servicebay/issues/2104) [#2105](https://github.com/mdopp/servicebay/issues/2105)
* **frontend:** focus a service in the Network Map from the service list ([83c2db2](https://github.com/mdopp/servicebay/commit/83c2db263250513130ea16483079c4d65185aae2)), closes [#2108](https://github.com/mdopp/servicebay/issues/2108)
* **frontend:** Home tiles v2, image-update banner refresh, portal design migration, service focus, settings flatten ([9b3f9fc](https://github.com/mdopp/servicebay/commit/9b3f9fcec693c62de66348023094bd18e15be069))
* **portal:** migrate public /portal to design-system primitives + tokens ([bf5856a](https://github.com/mdopp/servicebay/commit/bf5856ac21774998a808e6482615a4d0d892e594)), closes [#2107](https://github.com/mdopp/servicebay/issues/2107)


### Bug Fixes

* **frontend:** refresh image-update banner after a successful update ([dcbab4e](https://github.com/mdopp/servicebay/commit/dcbab4ea4d0f8e8f1312e7b295da1a31fc5470ce)), closes [#2106](https://github.com/mdopp/servicebay/issues/2106)

## [4.144.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.144.0...servicebay-v4.144.1) (2026-06-23)


### Bug Fixes

* **frontend:** restyle toast notifications on design-system tokens + move to top-right ([fbdb14b](https://github.com/mdopp/servicebay/commit/fbdb14b5d3692e4cd97bab8e5d767261d03ee7ab)), closes [#2099](https://github.com/mdopp/servicebay/issues/2099)

## [4.144.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.143.0...servicebay-v4.144.0) (2026-06-23)


### Features

* **dashboards:** Core services group + align Containers grouping optic ([4776590](https://github.com/mdopp/servicebay/commit/477659032b84affbb6b91416fb2f92e51bdb9de6)), closes [#2094](https://github.com/mdopp/servicebay/issues/2094) [#2095](https://github.com/mdopp/servicebay/issues/2095)


### Bug Fixes

* **updater:** recreate container on channel switch + update, fix false 'still building' ([e6cdba8](https://github.com/mdopp/servicebay/commit/e6cdba81571f69f31db682b6f144fdc6438e1ca6)), closes [#2062](https://github.com/mdopp/servicebay/issues/2062) [#2063](https://github.com/mdopp/servicebay/issues/2063) [#2064](https://github.com/mdopp/servicebay/issues/2064)

## [4.143.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.142.0...servicebay-v4.143.0) (2026-06-23)


### Features

* **dashboards:** group /services by stack + scoped per-stack wipe; drop StacksSection ([0bbf37c](https://github.com/mdopp/servicebay/commit/0bbf37ccd5e29f38dff4672e1716ca31f00760e9)), closes [#2081](https://github.com/mdopp/servicebay/issues/2081)
* **frontend:** group /services by stack with scoped per-stack wipe; Terminal back in sidebar nav ([e2e34be](https://github.com/mdopp/servicebay/commit/e2e34be93053e0253059e389ad1abecd92eb5720))
* **frontend:** return Terminal to sidebar nav; drop Settings ▸ System launch card ([3142834](https://github.com/mdopp/servicebay/commit/314283446e6573f38bf16c1e839915932d04a805)), closes [#2083](https://github.com/mdopp/servicebay/issues/2083)

## [4.142.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.141.0...servicebay-v4.142.0) (2026-06-23)


### Features

* **backup:** collapse NAS snapshot list to newest 5 with show-all expander ([11df214](https://github.com/mdopp/servicebay/commit/11df214f5e59a465f625e8eb22c3a5a3a5a1c2ea)), closes [#2085](https://github.com/mdopp/servicebay/issues/2085)
* **frontend:** design-system migration across visible surfaces + portal-access regroup + NAS snapshot collapse ([72c9528](https://github.com/mdopp/servicebay/commit/72c9528b92e0f278659f3f969ebee44122e1cc9e))
* **settings:** rework user/people-access page onto design-system primitives ([9fd8a33](https://github.com/mdopp/servicebay/commit/9fd8a33718396655ecfde3c5a2c6dc1bf7c86f4f)), closes [#2086](https://github.com/mdopp/servicebay/issues/2086)


### Bug Fixes

* **frontend:** make batch branch tsc-clean (test ServiceType + spread casts) ([edd1a88](https://github.com/mdopp/servicebay/commit/edd1a8857d0fc1981ed53b2462ccd2665b0d622c))

## [4.141.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.140.0...servicebay-v4.141.0) (2026-06-23)


### Features

* **frontend:** canonical PageScroll pattern + fix Operate tab clipping ([36c4298](https://github.com/mdopp/servicebay/commit/36c4298e23cf25d8b8c4ff8c61abe30ecf2f95aa)), closes [#2077](https://github.com/mdopp/servicebay/issues/2077)
* **frontend:** consolidate ServiceBay updater + service image-updates on Home ([5c551d8](https://github.com/mdopp/servicebay/commit/5c551d8c9bc88de292047fb66a82b8526e6e75ed)), closes [#2082](https://github.com/mdopp/servicebay/issues/2082)
* **frontend:** design-system foundation + Operate scroll, health mapping, Home Updates ([0e457a1](https://github.com/mdopp/servicebay/commit/0e457a1f73c7f1ebe81af667d48155c8a277b6c5))
* **frontend:** design-system ui primitives — Button/Card/DataTable/Badge/StatusDot/SectionHeading/Field ([be77875](https://github.com/mdopp/servicebay/commit/be7787580fa945225d622159dc97ee6a8bf6e89c)), closes [#2073](https://github.com/mdopp/servicebay/issues/2073) [#2074](https://github.com/mdopp/servicebay/issues/2074) [#2075](https://github.com/mdopp/servicebay/issues/2075) [#2076](https://github.com/mdopp/servicebay/issues/2076)
* **frontend:** semantic design tokens — surface/border/status/accent/radius/spacing ([8d9c0d1](https://github.com/mdopp/servicebay/commit/8d9c0d19da0661ff396d484226913dbec03c4926)), closes [#2072](https://github.com/mdopp/servicebay/issues/2072)


### Bug Fixes

* **health:** attribute per-service health checks, surface box-wide ones ([ff47abd](https://github.com/mdopp/servicebay/commit/ff47abd337ff58979a98ae69c1605aa6857cbac0)), closes [#2080](https://github.com/mdopp/servicebay/issues/2080)

## [4.140.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.139.0...servicebay-v4.140.0) (2026-06-23)


### Features

* **frontend:** actionable service image updates — Update now button + Home banner ([d48da88](https://github.com/mdopp/servicebay/commit/d48da889fa76e33916d3993165fb03a57940cf5c))
* **frontend:** actionable service image updates (Update-now button + Home banner) ([ea39829](https://github.com/mdopp/servicebay/commit/ea398293499dd1b240e3e869ff5bb7bfa822ebf4))

## [4.139.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.138.0...servicebay-v4.139.0) (2026-06-22)


### Features

* **frontend:** make Home overview cards clickable + restore overview tests ([451c39d](https://github.com/mdopp/servicebay/commit/451c39d4d448ba17e7a5728d1a3945e0614aca32))
* **frontend:** Services overview is a list on desktop, cards on mobile ([0408e6c](https://github.com/mdopp/servicebay/commit/0408e6c4a2ccf513538cb980b4ebef403bd503f4))
* **ux:** Services als Liste/Cards, Home klickbar, Coverage zurück ([ef29d74](https://github.com/mdopp/servicebay/commit/ef29d7404dd7e4019df7ecd2f983c365ca64a0e2))

## [4.138.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.137.0...servicebay-v4.138.0) (2026-06-22)


### Features

* **frontend:** declutter Settings to cross-cutting only ([6756398](https://github.com/mdopp/servicebay/commit/67563989fa9b4b93844c93b7d99ac07ef0a1788c))
* **frontend:** restore Home as a lean, status-led overview ([d50114c](https://github.com/mdopp/servicebay/commit/d50114c4c698d2f5db293eb70e9d831f2da37029))


### Bug Fixes

* **frontend:** compact Services tile — content-height, no empty gap ([77a5536](https://github.com/mdopp/servicebay/commit/77a55362b252be5ae11fa56004713c06207b4594))
* **ux:** kompakte Kacheln, Home zurück (lean), Settings nur Quer-Themen ([5275783](https://github.com/mdopp/servicebay/commit/5275783b69a197cb30efabae00cd6cb067b49961))

## [4.137.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.136.0...servicebay-v4.137.0) (2026-06-22)


### Features

* **auth:** token→session bridge + lean Services tile ([1765c7f](https://github.com/mdopp/servicebay/commit/1765c7f0a533fe1dfb436497edf96cdcf7edd5c1))

## [4.136.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.135.0...servicebay-v4.136.0) (2026-06-22)


### Features

* **navigation:** collapse top nav to four nouns + Network Map (IA slice 2) ([f2d800b](https://github.com/mdopp/servicebay/commit/f2d800b5d84979445d3ef0a848c06f1f101dbe32))
* **navigation:** collapse top nav to the four nouns + Network Map (IA slice 2) ([58cb9a7](https://github.com/mdopp/servicebay/commit/58cb9a75513eddc29c229d4b2699fe04995f0c20)), closes [#2030](https://github.com/mdopp/servicebay/issues/2030)

## [4.135.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.134.0...servicebay-v4.135.0) (2026-06-22)


### Features

* **auth:** lazy cascading revocation in verifyToken (ancestor walk) ([9954fd1](https://github.com/mdopp/servicebay/commit/9954fd1dc0c16137d18e93ed51bfc5e2128b3ab8)), closes [#2049](https://github.com/mdopp/servicebay/issues/2049)
* **auth:** token chain-of-trust — cascading revocation + sb token delegate CLI ([e7285cf](https://github.com/mdopp/servicebay/commit/e7285cf5316f709ff6a2c8243dff7e56f30baed8))
* **sb-cli:** sb token delegate — mint a scoped, short-TTL child from a parent token ([e700127](https://github.com/mdopp/servicebay/commit/e700127f7db33b63f4fb0bab32ed0946279aa13f)), closes [#2051](https://github.com/mdopp/servicebay/issues/2051)


### Bug Fixes

* **auth:** sequence token-store writes so the lastUsedAt stamp can't clobber a mint/revoke ([50623d1](https://github.com/mdopp/servicebay/commit/50623d1098e5fbd6fce268ea633ca956f5e10aa2)), closes [#2049](https://github.com/mdopp/servicebay/issues/2049)

## [4.134.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.133.1...servicebay-v4.134.0) (2026-06-22)


### Features

* **auth:** parentId on ApiToken + subset-enforced delegated child-mint ([e172659](https://github.com/mdopp/servicebay/commit/e17265988a87fe0bff61d2a43048e71ce75fc50f)), closes [#2048](https://github.com/mdopp/servicebay/issues/2048)
* **auth:** token chain-of-trust mint + per-capability scope audit ([5ee5a0b](https://github.com/mdopp/servicebay/commit/5ee5a0bfee57615fca909fe3c6ee94cef067820a))

## [4.133.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.133.0...servicebay-v4.133.1) (2026-06-21)


### Bug Fixes

* approvals service-name jail + disk-import apply status race ([634b799](https://github.com/mdopp/servicebay/commit/634b79947bab7f7a12a6a985c9c5c23cb573ce1b))
* **approvals:** validate service name so the move-action jail can't anchor outside /mnt/data/stacks ([37d50f0](https://github.com/mdopp/servicebay/commit/37d50f0d6a42b3b909b7aa821c457c42bc74815c)), closes [#2043](https://github.com/mdopp/servicebay/issues/2043)
* **disk-import:** drop a late progress write that would clobber the final apply status ([ebbe339](https://github.com/mdopp/servicebay/commit/ebbe33944ca8af1e953f721722358890f42257c0)), closes [#2044](https://github.com/mdopp/servicebay/issues/2044)

## [4.133.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.132.0...servicebay-v4.133.0) (2026-06-21)


### Features

* **diagnose:** on-demand re-sync of Jellyfin library access ([5b0567b](https://github.com/mdopp/servicebay/commit/5b0567b273d4ee2ce109a85a52425510ecf352f8)), closes [#2040](https://github.com/mdopp/servicebay/issues/2040)


### Bug Fixes

* **frontend:** redirect /settings/services/[name] to canonical /services/[name] ([0efe710](https://github.com/mdopp/servicebay/commit/0efe71097248ed18539c197330c69ddc0fc46fc8)), closes [#2039](https://github.com/mdopp/servicebay/issues/2039)
* settings/services redirect + on-demand Jellyfin library re-sync ([1096a04](https://github.com/mdopp/servicebay/commit/1096a0423a419d4f508f9676cf87c15e2efc5d6c))

## [4.132.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.131.0...servicebay-v4.132.0) (2026-06-21)


### Features

* **frontend:** add /status box-wide health route + nav entry ([89e54d8](https://github.com/mdopp/servicebay/commit/89e54d8b7674dbf838483d4868900de8e27c194b)), closes [#2030](https://github.com/mdopp/servicebay/issues/2030)


### Bug Fixes

* **claude-dev:** pin UIDs/GIDs so persisted homes survive image rebuilds ([63163e7](https://github.com/mdopp/servicebay/commit/63163e7a698c8c01c636c60e50c7e504a08e52b5)), closes [#2034](https://github.com/mdopp/servicebay/issues/2034)

## [4.131.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.130.0...servicebay-v4.131.0) (2026-06-21)


### Features

* **disk-import:** refresh worker image in background on startup ([050f637](https://github.com/mdopp/servicebay/commit/050f637de2420ad68e175bbea07351ce3256fb5c)), closes [#1995](https://github.com/mdopp/servicebay/issues/1995)
* **frontend:** per-service Operate page + shared detail, reused in the network-map sidebar ([eab22b5](https://github.com/mdopp/servicebay/commit/eab22b54ccbb5a1468cf94c45fe341605458ee7f)), closes [#2029](https://github.com/mdopp/servicebay/issues/2029)
* **media:** audiobooks → Jellyfin Bookshelf — install plugin + flatten disc layout on import ([93c522b](https://github.com/mdopp/servicebay/commit/93c522b7f28fae73acd52f8a732293aed8200d11)), closes [#2028](https://github.com/mdopp/servicebay/issues/2028)
* mobile nav, disk-import worker refresh, audiobooks→Bookshelf, per-service Operate page ([385e5e4](https://github.com/mdopp/servicebay/commit/385e5e40e6950f9f9ec09056657cd749a4fb9ec2))


### Bug Fixes

* **frontend:** make top-level nav usable on phones, keep Backup reachable ([0f39152](https://github.com/mdopp/servicebay/commit/0f391520a761ec5ef466aa6554d28661bda13d64)), closes [#1992](https://github.com/mdopp/servicebay/issues/1992)

## [4.130.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.129.3...servicebay-v4.130.0) (2026-06-21)


### Features

* **disk-import:** per-folder "base root" strip toggle ([#2006](https://github.com/mdopp/servicebay/issues/2006) follow-up) ([#2015](https://github.com/mdopp/servicebay/issues/2015)) ([d18ffbb](https://github.com/mdopp/servicebay/commit/d18ffbb717ba61add8035db48a3efff2979aecb6))
* **disk-import:** per-folder routing-tree review UI — owner + target pickers, per-owner re-plan ([#2000](https://github.com/mdopp/servicebay/issues/2000)) ([ae2632d](https://github.com/mdopp/servicebay/commit/ae2632d556ad74a633dc7b1485e34a94bb82307b))
* **disk-import:** per-folder routing-tree review UI — owner + target pickers, per-owner re-plan ([#2000](https://github.com/mdopp/servicebay/issues/2000)) ([c9b56bb](https://github.com/mdopp/servicebay/commit/c9b56bb7fb381c2956e6371be7130e2ab85cb1a2))
* **disk-import:** review-tree data layer — folder tree + owners from plan.json ([#1915](https://github.com/mdopp/servicebay/issues/1915)) ([44c7af0](https://github.com/mdopp/servicebay/commit/44c7af0713df26c000c9821a198c9282c2aa7aa5))
* **disk-import:** save & re-run the per-folder routing selection ([#2007](https://github.com/mdopp/servicebay/issues/2007)) ([#2013](https://github.com/mdopp/servicebay/issues/2013)) ([73333ed](https://github.com/mdopp/servicebay/commit/73333ed9031cf47bd819299c1bf243266e1c7a49))
* **install:** prune orphaned installedTemplates entries (the un-removable Hermes ghost) ([#2020](https://github.com/mdopp/servicebay/issues/2020)) ([5af213c](https://github.com/mdopp/servicebay/commit/5af213c1aaf2c7c1d256386d028dab99052b55a6))
* **media+diagnose:** rename Jellyfin subdomain to `media`; verify its LDAP login end-to-end ([#2026](https://github.com/mdopp/servicebay/issues/2026)) ([3967916](https://github.com/mdopp/servicebay/commit/396791660b0bd48589fb23beb2da178f977ce660))
* **media:** auto-provision Jellyfin libraries (public + per-user private) with access ([#2027](https://github.com/mdopp/servicebay/issues/2027)) ([93662d8](https://github.com/mdopp/servicebay/commit/93662d82fbbbb42764c1b38a0dd2fe4ab3ece30c))


### Bug Fixes

* **diagnose:** admin-ACL check asks Authelia directly; ollama is admin-only ([#2022](https://github.com/mdopp/servicebay/issues/2022)) ([8c0de6c](https://github.com/mdopp/servicebay/commit/8c0de6cc9c672cd618e68cd795ed3ca449faaa7d))
* **diagnose:** drop the flaky per-domain HTTP GET from external-reachability (stop the cry-wolf) ([#2024](https://github.com/mdopp/servicebay/issues/2024)) ([a097485](https://github.com/mdopp/servicebay/commit/a097485464a6ac5bd8be8d38959e4f5d2dc6eeb6))
* **diagnose:** SSO consent-redirect is a healthy handshake (not "login broken") ([#2021](https://github.com/mdopp/servicebay/issues/2021)) ([a12ae9d](https://github.com/mdopp/servicebay/commit/a12ae9df4b2eb948645fdbe427772085c5130a50))
* **diagnose:** two self-diagnose false positives (SSO redirect_uri + cumulative restart count) ([#2019](https://github.com/mdopp/servicebay/issues/2019)) ([cd0c3fb](https://github.com/mdopp/servicebay/commit/cd0c3fb994fd8d9db69abfed02a09c50f056268a))
* **disk-import:** apply timeout default was clobbered by `{timeoutMs: undefined}` (re-broke at 30s) ([#2017](https://github.com/mdopp/servicebay/issues/2017)) ([cfb0a88](https://github.com/mdopp/servicebay/commit/cfb0a885350749014da51391fef09953133e03a5))
* **disk-import:** buildFolderTree returns root node on an empty scan (no crash) ([8ae5f77](https://github.com/mdopp/servicebay/commit/8ae5f77a0f527ba700d34f817d86c4fda04fbc00))
* **disk-import:** buildFolderTree returns root node on an empty scan (no crash) ([a35b243](https://github.com/mdopp/servicebay/commit/a35b243584612b76da037f8841a3c37fdc655980))
* **disk-import:** chown the mkdir'd DIRECTORY chain to core, not just the files ([#2025](https://github.com/mdopp/servicebay/issues/2025)) ([b5a2da6](https://github.com/mdopp/servicebay/commit/b5a2da654b5591d10b05f1938ea6118d61403dd8))
* **disk-import:** disable SELinux label confinement on the worker (/out EACCES) ([d67fcc2](https://github.com/mdopp/servicebay/commit/d67fcc2c42e84e519e1dcd119fdd84e10073d737))
* **disk-import:** disable SELinux label confinement on the worker (/out EACCES) ([4c2e73d](https://github.com/mdopp/servicebay/commit/4c2e73d0433e2c03633ecdfa1956246abbd0102d))
* **disk-import:** give the host-apply exec a generous timeout (30s default errored mid-copy) ([#2016](https://github.com/mdopp/servicebay/issues/2016)) ([e527b7c](https://github.com/mdopp/servicebay/commit/e527b7c64515d6f30699367b2bbd66318c61c279))
* **disk-import:** give the re-plan exec a generous timeout (was 30s agent default) ([#2010](https://github.com/mdopp/servicebay/issues/2010)) ([4ebf615](https://github.com/mdopp/servicebay/commit/4ebf6155c39552830e9c5c04dd4af1e4b9c645f7))
* **disk-import:** launchScan starts the worker scan walk (was stuck at 'Starting…') ([b537bc7](https://github.com/mdopp/servicebay/commit/b537bc7e5bbe0e0efe4bc14e351bfc34f21d1322))
* **disk-import:** launchScan starts the worker's scan walk (was stuck at 'Starting…') ([343baa4](https://github.com/mdopp/servicebay/commit/343baa42b015dbeb83c1fd8b47d4c4e7a01ecf99))
* **disk-import:** make re-plan + apply asynchronous ([#2009](https://github.com/mdopp/servicebay/issues/2009)) ([#2012](https://github.com/mdopp/servicebay/issues/2012)) ([7b4cbc8](https://github.com/mdopp/servicebay/commit/7b4cbc813446e679a77b7f2d96cadc8e374f3d6a))
* **disk-import:** per-category layout + dedup identity (preserve folders, dedup right) ([#2006](https://github.com/mdopp/servicebay/issues/2006) redesign) ([#2014](https://github.com/mdopp/servicebay/issues/2014)) ([a4b1110](https://github.com/mdopp/servicebay/commit/a4b11104e3bf6f89ed5924e5e0f452279f20b84a))
* **disk-import:** ReDoS-safe trailing-slash strip in replan/tree (CodeQL js/polynomial-redos) ([637c58b](https://github.com/mdopp/servicebay/commit/637c58be648370b2f82c933ba61a3b979cf0c728))
* **disk-import:** rename in-tree name clashes instead of dropping them ([#2006](https://github.com/mdopp/servicebay/issues/2006)) ([#2011](https://github.com/mdopp/servicebay/issues/2011)) ([d3605f3](https://github.com/mdopp/servicebay/commit/d3605f39623791d2d7ebfb9924e71e05ebe8ceb4))
* **disk-import:** render the plan/routing tree after scan (tile stuck on progress) ([1937528](https://github.com/mdopp/servicebay/commit/19375288d0373fac537f572b116e1986383addc7))
* **disk-import:** replace dead /disk-import-app link with an in-page plan review ([7f22ae0](https://github.com/mdopp/servicebay/commit/7f22ae06d89066efedf5262a3f33346b375c1438))
* **disk-import:** replace dead /disk-import-app link with in-page plan review ([5550a18](https://github.com/mdopp/servicebay/commit/5550a1845ecc3a2af1e8a2afa6b3854c7aebcf26))
* **disk-import:** show the plan/routing tree after scan (tile stuck on progress) ([abfd4be](https://github.com/mdopp/servicebay/commit/abfd4be263736233e80499c501c9e21864b115b6))
* **disk-import:** write replan-request inside the worker container (SELinux EACCES) ([a57713d](https://github.com/mdopp/servicebay/commit/a57713d365ebab85d52de498507ee123c38a6a44))
* **disk-import:** write replan-request INSIDE the worker container (SELinux EACCES) ([a85e36a](https://github.com/mdopp/servicebay/commit/a85e36a77881757c42f48f1939e4fffa1c1d1954))
* **health:** delete on a synthetic self-diagnose check no longer fake-succeeds ([#2018](https://github.com/mdopp/servicebay/issues/2018)) ([c1b6db0](https://github.com/mdopp/servicebay/commit/c1b6db0bef8d482cc4112c4fddf137693770cc44))
* **nginx:** expand the forward-auth sentinel in the proxy-host API (not just the installer) ([#2023](https://github.com/mdopp/servicebay/issues/2023)) ([ce5b2aa](https://github.com/mdopp/servicebay/commit/ce5b2aa08b39e23ff8d3527bb4d89e5bd1d4227f))

## [4.129.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.129.2...servicebay-v4.129.3) (2026-06-18)


### Bug Fixes

* **disk-import:** scan no longer times out — skip redundant image pull, longer mount timeout ([cc79353](https://github.com/mdopp/servicebay/commit/cc79353d0d9abb10e4158bcfca5020f87e77ee3e))
* **disk-import:** scan no longer times out — skip redundant image pull, longer mount timeout ([278948d](https://github.com/mdopp/servicebay/commit/278948df7f61f877c0039f656d546913b170f284))
* **disk-import:** trust the fingerprint for dedup — no full-hash confirm ([5451309](https://github.com/mdopp/servicebay/commit/5451309a9afd9ffe9b0503c59cd320b0fee7b8c5))
* **disk-import:** trust the fingerprint for dedup — no full-hash confirm ([#1995](https://github.com/mdopp/servicebay/issues/1995)) ([656858f](https://github.com/mdopp/servicebay/commit/656858fc3e114925fded722837eff4ab78d16166))
* **disk-import:** two-tier fingerprint dedup + planning progress ([853b3ed](https://github.com/mdopp/servicebay/commit/853b3ed4bdbb97211aa658b1ce3da9538c0ea4f9))
* **disk-import:** two-tier fingerprint dedup + planning progress ([#1995](https://github.com/mdopp/servicebay/issues/1995)) ([c6ed475](https://github.com/mdopp/servicebay/commit/c6ed475378efc9d10c5760a5c908923a3740e3c8))

## [4.129.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.129.1...servicebay-v4.129.2) (2026-06-18)


### Bug Fixes

* **disk-import:** chown imported files to core:&lt;real file-share gid&gt;, not :1024 ([8016a5a](https://github.com/mdopp/servicebay/commit/8016a5aaf6445a287100889a097e34f46e453f25))
* **disk-import:** chown imported files to core:&lt;real file-share gid&gt;, not :1024 ([8fbf6aa](https://github.com/mdopp/servicebay/commit/8fbf6aafa133a3de4510ce9184dcb854dbe06307)), closes [#1985](https://github.com/mdopp/servicebay/issues/1985)

## [4.129.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.129.0...servicebay-v4.129.1) (2026-06-18)


### Bug Fixes

* **disk-import:** adapt dev script to async applyPlan hashOf ([#1983](https://github.com/mdopp/servicebay/issues/1983)) ([2ae576c](https://github.com/mdopp/servicebay/commit/2ae576cbf05390f5c359d7a9f5af89940cb88e40))
* **disk-import:** apply-done UX + auto-unmount source after apply ([577bbb2](https://github.com/mdopp/servicebay/commit/577bbb27ed92cd819d908be54159c8f71b57de31)), closes [#1981](https://github.com/mdopp/servicebay/issues/1981) [#1982](https://github.com/mdopp/servicebay/issues/1982)
* **disk-import:** hash on the host via exec, lazily — host-apply lands zero bytes ([8d705f7](https://github.com/mdopp/servicebay/commit/8d705f7646a09f9f51f410a09dff8df01e0246e7)), closes [#1983](https://github.com/mdopp/servicebay/issues/1983)
* **disk-import:** host-apply lands zero bytes + apply-done UX + auto-unmount ([1a3a326](https://github.com/mdopp/servicebay/commit/1a3a326454c5ccaa77ce29b780a1d5a176245fd8))
* **disk-import:** repair worker runtime — ESM require, SELinux source mount, Immich env ([cbfe2df](https://github.com/mdopp/servicebay/commit/cbfe2dfcfbed90791105bb6b154cff80b85bb34a))
* **disk-import:** repair worker runtime — ESM require, SELinux source mount, Immich env ([4ad2218](https://github.com/mdopp/servicebay/commit/4ad22186822af1ffe86f32804af111bdba0a970e))
* **disk-import:** run APPLY on the host from servicebay, not the sandboxed worker ([6ee7d22](https://github.com/mdopp/servicebay/commit/6ee7d2227858165cb59a9ccebceb74a8c7b9df37))
* **disk-import:** run APPLY on the host from servicebay, not the sandboxed worker ([27fe93c](https://github.com/mdopp/servicebay/commit/27fe93cfddaf0e02b708e062926fb8314335e2de))

## [4.129.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.128.1...servicebay-v4.129.0) (2026-06-18)


### Features

* **settings:** demote disk-import from main nav to Settings → Maintenance ([b5afb4f](https://github.com/mdopp/servicebay/commit/b5afb4f81e7ca978646b9e583e70a9ee12d761f0))
* **settings:** move disk-import from main nav to Settings → Maintenance + searchable ([7735c6a](https://github.com/mdopp/servicebay/commit/7735c6a976131e936e5e1d219db6eb351923aa1e))

## [4.128.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.128.0...servicebay-v4.128.1) (2026-06-18)


### Bug Fixes

* backup-worker direct tar read + disk-import mount idempotency ([2b6ccc6](https://github.com/mdopp/servicebay/commit/2b6ccc638b897707f1bf799ae99a99c0ca25c357))
* **backupWorker:** read produced tars directly off the out volume, not via base64 exec ([ea2899c](https://github.com/mdopp/servicebay/commit/ea2899cc38e91232d868c22837ed30365a36965d)), closes [#1973](https://github.com/mdopp/servicebay/issues/1973)
* **diskImport:** make worker device mount idempotent + sweep stale mounts ([7440cd7](https://github.com/mdopp/servicebay/commit/7440cd77a93251f597eda7a7bbfbcdb148e22275)), closes [#1941](https://github.com/mdopp/servicebay/issues/1941)

## [4.128.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.127.0...servicebay-v4.128.0) (2026-06-18)


### Features

* **backup-worker:** run external/config backup in a capped one-shot worker ([6ca1c07](https://github.com/mdopp/servicebay/commit/6ca1c074ba491645b1d2612d4a50025af602792a))
* **backup-worker:** run external/config backup in a capped one-shot worker ([e40f2f3](https://github.com/mdopp/servicebay/commit/e40f2f323d671e1917793045c3f4099a7f7e7e7d)), closes [#1955](https://github.com/mdopp/servicebay/issues/1955)


### Bug Fixes

* **backup-worker:** add @servicebay/backup-worker path aliases for Turbopack build ([0a276fb](https://github.com/mdopp/servicebay/commit/0a276fbffd8ecf64a7f33b26cd8e3c247deed770))
* **backup-worker:** install native build toolchain for npm ci in worker image ([d3988cb](https://github.com/mdopp/servicebay/commit/d3988cba2d45e8354d05230d51f39b05f4a7623d)), closes [#1955](https://github.com/mdopp/servicebay/issues/1955)
* **backup-worker:** register backup-worker as workspace in Dockerfile ([e4d88b0](https://github.com/mdopp/servicebay/commit/e4d88b043d83e2e9200b4636830c5f127bf79159))
* **backup-worker:** register backup-worker as workspace in Dockerfile deps stages ([7d72390](https://github.com/mdopp/servicebay/commit/7d72390fc3588d930b28a405261e5c4ef5188d07))
* **workers:** :z relabel the worker /out mount so the worker can write status.json ([c9603fa](https://github.com/mdopp/servicebay/commit/c9603fa6b430ab431cdcdef3bf3926d3a1ebf97a))
* **workers:** :z relabel worker /out mount (SELinux MCS) so status.json writes ([dfc2931](https://github.com/mdopp/servicebay/commit/dfc29314e7508267fa055ab2e80feae899eb26de))
* **workers:** run worker containers as root for rootless-podman /out writes ([efb2f6d](https://github.com/mdopp/servicebay/commit/efb2f6d38ac86f2c00a8d6515622970806f79a34))
* **workers:** run worker containers as root for rootless-podman bind-mount writes ([e74de49](https://github.com/mdopp/servicebay/commit/e74de4922b48f635e6534a727e04a0d7e4f50809))

## [4.127.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.126.0...servicebay-v4.127.0) (2026-06-18)


### Features

* disk-import worker container + per-service Operate pages ([792e4f1](https://github.com/mdopp/servicebay/commit/792e4f1abcd561c7f32eafdb5fffeccaa5130005))
* **disk-import:** run the worker as a launched container behind a tile ([cc2e91e](https://github.com/mdopp/servicebay/commit/cc2e91ef22338b877a678fb9fa1126df2fae11e9)), closes [#1953](https://github.com/mdopp/servicebay/issues/1953)
* **settings:** per-service Operate pages with Health, Settings and Actions ([9bcf333](https://github.com/mdopp/servicebay/commit/9bcf333a5416fba033a8784195a46a9186f45253)), closes [#1957](https://github.com/mdopp/servicebay/issues/1957)


### Bug Fixes

* **disk-import:** create RO mountpoint + use host data dir so the worker launches ([3e3ae67](https://github.com/mdopp/servicebay/commit/3e3ae67ed44175f82f573676d184c02f94c3b312))
* **disk-import:** create RO mountpoint + use host data dir so the worker launches ([f6fb17a](https://github.com/mdopp/servicebay/commit/f6fb17af7fca01eb7df5d490d8208df0f473cf9f)), closes [#1963](https://github.com/mdopp/servicebay/issues/1963)
* **disk-import:** fail fast on outDir mkdir + self-heal HOST_DATA_DIR in quadlet ([4963d94](https://github.com/mdopp/servicebay/commit/4963d9475e53a0932e79431d889c45a275a2c463))
* **disk-import:** fail fast on outDir mkdir + self-heal HOST_DATA_DIR in quadlet ([cac4bfe](https://github.com/mdopp/servicebay/commit/cac4bfe650dcdeacf503ca69939ffe5dbfa956f6))
* **disk-import:** loosen immichProvisionFromEnv param to Record so partial-env tests typecheck ([439bf28](https://github.com/mdopp/servicebay/commit/439bf2854ba3ad16f62e1cf59adddfc2e07c5f7f))
* **disk-import:** re-add post-apply Immich External Library provision/scan ([bcc268f](https://github.com/mdopp/servicebay/commit/bcc268fa932a217e9d601feed0746570bc3c3d9e)), closes [#1954](https://github.com/mdopp/servicebay/issues/1954)
* **disk-import:** resolve host data dir at launch via podman self-inspect ([8bbf82b](https://github.com/mdopp/servicebay/commit/8bbf82b29018427c9f6c916cdc02b6cf57be449c))
* **disk-import:** resolve host data dir at launch via podman self-inspect ([64381cd](https://github.com/mdopp/servicebay/commit/64381cd8aa3a843b443172dfd51a7227cea564d6))
* **disk-import:** strip trailing slashes without backtracking regex (CodeQL js/polynomial-redos) ([97add1e](https://github.com/mdopp/servicebay/commit/97add1e00a63eb5f03186bfefae0f589aed4402c))

## [4.126.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.125.3...servicebay-v4.126.0) (2026-06-18)


### Features

* disk-import worker container, image-update poller throttle, settings IA shell ([82a8658](https://github.com/mdopp/servicebay/commit/82a86586c93bc57a89f6548ea343f46a7da2bd71))


### Bug Fixes

* **updater:** throttle image-update poller manifest-inspect fan-out ([d7df23a](https://github.com/mdopp/servicebay/commit/d7df23ae55b8066c42fb1e872f04183242120bd3)), closes [#1952](https://github.com/mdopp/servicebay/issues/1952)

## [4.125.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.125.2...servicebay-v4.125.3) (2026-06-17)


### Bug Fixes

* **disk-import,file-share:** split session store + reap zombies; persist Samba passdb ([0742b13](https://github.com/mdopp/servicebay/commit/0742b13a105dd2f540087c2e16bcca17d3529433))
* **disk-import:** split compact status from bulk records + reap zombie sessions ([a209da1](https://github.com/mdopp/servicebay/commit/a209da1925c70ddc038db6538e6595373263bb32)), closes [#1945](https://github.com/mdopp/servicebay/issues/1945) [#1943](https://github.com/mdopp/servicebay/issues/1943)
* **file-share:** persist Samba passdb so SMB users + passwords survive a restart ([9e70a39](https://github.com/mdopp/servicebay/commit/9e70a396900828ebfd028617ba777603ff34332c)), closes [#1946](https://github.com/mdopp/servicebay/issues/1946)

## [4.125.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.125.1...servicebay-v4.125.2) (2026-06-17)


### Bug Fixes

* **disk-import:** review-first scan, resilient hashing, wider junk prune ([#1937](https://github.com/mdopp/servicebay/issues/1937)) ([8ea6411](https://github.com/mdopp/servicebay/commit/8ea64117d7dc41a4e8e95400a44098692ce77405))
* **disk-import:** review-first scan, resilient hashing, wider junk prune ([#1937](https://github.com/mdopp/servicebay/issues/1937)) ([c62fac6](https://github.com/mdopp/servicebay/commit/c62fac628c7e1fa29bacc51e8d415304ac1f06c5))

## [4.125.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.125.0...servicebay-v4.125.1) (2026-06-17)


### Bug Fixes

* **disk-import:** prune node_modules/junk subtrees at the walk so they're never hashed ([#1932](https://github.com/mdopp/servicebay/issues/1932)) ([6bd96a1](https://github.com/mdopp/servicebay/commit/6bd96a1b2b085acf5f185af9d413e69234187d4c))
* **disk-import:** prune node_modules/junk subtrees at the walk so they're never hashed ([#1932](https://github.com/mdopp/servicebay/issues/1932)) ([ccf1a91](https://github.com/mdopp/servicebay/commit/ccf1a91a73fa23ad17ef7dea1693bf8b08fd9f40))
* **diskImport:** clamp request-supplied owner to a single path segment (CodeQL audit) ([c6b81b8](https://github.com/mdopp/servicebay/commit/c6b81b852ce7291cd040c6a7bcc2a9b88074e765)), closes [#1929](https://github.com/mdopp/servicebay/issues/1929)
* **immich,diskImport:** admin-password auto-rekey + routing owner clamp + routing-tree smoke test ([aad2c1d](https://github.com/mdopp/servicebay/commit/aad2c1d59494b76d73542e4d3008285fda441fa1))
* **immich:** auto-rekey preserved-pgdata admin password so External-Library provisioning works ([a08c691](https://github.com/mdopp/servicebay/commit/a08c691596720720044c33d5b4809d8f0a802eaa)), closes [#1928](https://github.com/mdopp/servicebay/issues/1928)
* **immich:** set -w /usr/src/app/server so bcrypt resolves in the rekey exec ([#1928](https://github.com/mdopp/servicebay/issues/1928)) ([a9d97a5](https://github.com/mdopp/servicebay/commit/a9d97a5d51c80bdf4280900c55b8c7dbb69689d0))
* **immich:** set -w /usr/src/app/server so bcrypt resolves in the rekey exec ([#1928](https://github.com/mdopp/servicebay/issues/1928)) ([32bdcfa](https://github.com/mdopp/servicebay/commit/32bdcfaeb2941ba22287bb65d5b718bd2cb259f3))
* **immich:** use stdin mode for psql + quote "user" table name ([#1928](https://github.com/mdopp/servicebay/issues/1928) refix) ([4340ebb](https://github.com/mdopp/servicebay/commit/4340ebb4c09a3a0a591c1c52a27589c4b8e17e31))
* **immich:** use stdin mode for psql + quote the \"user\" table name ([64653f8](https://github.com/mdopp/servicebay/commit/64653f8da625df33c2c10303f41388cfebcac5f8))

## [4.125.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.124.0...servicebay-v4.125.0) (2026-06-17)


### Features

* **eslint+registry:** React-Compiler rule adoption + persistent local template source ([bab7d97](https://github.com/mdopp/servicebay/commit/bab7d9755d81853f36fc5df1e8fb0387d687600a))
* **eslint:** adopt 13 low-touch React-Compiler react-hooks rules ([86d5da8](https://github.com/mdopp/servicebay/commit/86d5da871f5fd9defae4239f89e175e588800d44)), closes [#1921](https://github.com/mdopp/servicebay/issues/1921)
* **eslint:** enable react-hooks/set-state-in-effect, resolve 39 violations ([113fb56](https://github.com/mdopp/servicebay/commit/113fb56a01268e91b9252c39cf7cbb3fec39a294)), closes [#1922](https://github.com/mdopp/servicebay/issues/1922)
* **registry:** persistent local (non-git) template/stack source ([1000b47](https://github.com/mdopp/servicebay/commit/1000b479f70522d597f3ef4e38198713be30e166)), closes [#1919](https://github.com/mdopp/servicebay/issues/1919)

## [4.124.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.123.0...servicebay-v4.124.0) (2026-06-17)


### Features

* **disk-import:** per-folder routing review UI ([#1915](https://github.com/mdopp/servicebay/issues/1915)) ([5c2fabd](https://github.com/mdopp/servicebay/commit/5c2fabdbf4e3fdaab9160e59a8ee034c4159080d))
* **disk-import:** taxonomy movies split + Immich External-Library wiring ([bec8197](https://github.com/mdopp/servicebay/commit/bec8197d664ddf8ae4c7175b971fea09fd076c73))
* **disk-import:** taxonomy movies split + Immich External-Library wiring ([35c206f](https://github.com/mdopp/servicebay/commit/35c206fcf769ef3180b0d4c17b2bd849add455f8)), closes [#1914](https://github.com/mdopp/servicebay/issues/1914) [#1904](https://github.com/mdopp/servicebay/issues/1904)


### Bug Fixes

* **disk-import:** drop CLI's obsolete Immich upload path (typecheck) ([54a1da2](https://github.com/mdopp/servicebay/commit/54a1da2264fc32e4720328ae50acda6b7773a5a0))
* **immich:** disable SELinux relabel on photo-areas hostPath mount ([efd92a8](https://github.com/mdopp/servicebay/commit/efd92a860dd23ee0b7ebc495790ef3c9c67f6692))
* **immich:** disable SELinux relabel on photo-areas hostPath mount ([861e263](https://github.com/mdopp/servicebay/commit/861e26384063761d9c04ce5bcbaafb413bcf8949))
* **immich:** pod-level SELinux disable for photo-areas volume relabelling ([cdd227d](https://github.com/mdopp/servicebay/commit/cdd227d404434c2ec8fd23db2bb1c1d0732aac0c))
* **immich:** use Directory not DirectoryOrCreate for photo-areas hostPath ([2db9737](https://github.com/mdopp/servicebay/commit/2db9737beb7e33b012a0d976a1a26d4f961aee29))
* **immich:** use Directory not DirectoryOrCreate for photo-areas hostPath ([4990b04](https://github.com/mdopp/servicebay/commit/4990b0480c96d97b10df0baf3778908050d3d3b9))
* **immich:** use pod-level SELinux disable for photo-areas volume relabelling ([0d0d307](https://github.com/mdopp/servicebay/commit/0d0d3074a1f9bcb585a2188e09b9635f7548642b))

## [4.123.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.122.1...servicebay-v4.123.0) (2026-06-17)


### Features

* **diskImport:** owner+mode-aware apply target-path resolution ([c475f91](https://github.com/mdopp/servicebay/commit/c475f91c7250419f6baa63847093778453551122)), closes [#1913](https://github.com/mdopp/servicebay/issues/1913)
* **diskImport:** routing-tree data model, inheritance, owner axis, dedup scope ([7c22d91](https://github.com/mdopp/servicebay/commit/7c22d914b8bfd9ec2e29266048a1e146375d5f17)), closes [#1912](https://github.com/mdopp/servicebay/issues/1912)
* **diskImport:** routing-tree engine + owner/mode-aware apply target paths ([712c3c8](https://github.com/mdopp/servicebay/commit/712c3c8f1e126c4905fc13cdb201f009bf9ca925))

## [4.122.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.122.0...servicebay-v4.122.1) (2026-06-17)


### Bug Fixes

* **diskImport:** use absolute sourcePath as rsync/immich src ([f2b6503](https://github.com/mdopp/servicebay/commit/f2b65033ff5d5ec631eb8a3f1bf98f1d9cbb9196))
* **diskImport:** use absolute sourcePath as rsync/immich src ([5310325](https://github.com/mdopp/servicebay/commit/5310325e6315f603aa585317053fbd7caacabcf9)), closes [#1906](https://github.com/mdopp/servicebay/issues/1906)

## [4.122.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.121.1...servicebay-v4.122.0) (2026-06-17)


### Features

* **diskimport:** async durable disk-import with live progress + lost+found fix ([7c795e0](https://github.com/mdopp/servicebay/commit/7c795e01dde38ebb54ecfe0741962f941b77ac81))
* **diskimport:** async scan/apply jobs with live progress (no 504) ([8f99373](https://github.com/mdopp/servicebay/commit/8f993738ac1e4fd9274636e259b6e5cae6be1696)), closes [#1897](https://github.com/mdopp/servicebay/issues/1897)
* **diskimport:** durable file-based scan-session store (survive restart) ([e6a9959](https://github.com/mdopp/servicebay/commit/e6a995941fff5db1e78251fc13ff038790a5d6e7)), closes [#1896](https://github.com/mdopp/servicebay/issues/1896)


### Bug Fixes

* **diskimport:** tolerate find exit 1 on root-0700 dirs + prune lost+found ([bd74ee4](https://github.com/mdopp/servicebay/commit/bd74ee4cbdb673c59b44bb3cd34b0afc49afab4d)), closes [#1893](https://github.com/mdopp/servicebay/issues/1893)
* **diskimport:** use shared DATA_DIR from dirs.ts for catalog path ([785a95d](https://github.com/mdopp/servicebay/commit/785a95d9bac9f1a051c9df53c2454207c36eaee6))
* **diskimport:** use shared DATA_DIR from dirs.ts for catalog path ([7d4bc9b](https://github.com/mdopp/servicebay/commit/7d4bc9b21b314eae7b2df11b13062a0de415592f))


### Performance Improvements

* **diskimport:** batch host-side hashing + copy/chown (kill per-file round-trips) ([a66ab92](https://github.com/mdopp/servicebay/commit/a66ab923c4d9704abd90b6f50888980865249cfb)), closes [#1898](https://github.com/mdopp/servicebay/issues/1898)

## [4.121.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.121.0...servicebay-v4.121.1) (2026-06-16)


### Bug Fixes

* **externalBackup:** stop nightly NAS backup OOM + honest NPM sqlite fallback ([4ca1d2d](https://github.com/mdopp/servicebay/commit/4ca1d2d8126d5d9faa9a9155438ad2a61d20dbc3))
* **externalBackup:** stop nightly NAS backup OOM + honest NPM sqlite fallback ([ecda5e3](https://github.com/mdopp/servicebay/commit/ecda5e3164fd91d9bd9f989c40d451ce0397331b)), closes [#1894](https://github.com/mdopp/servicebay/issues/1894)

## [4.121.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.120.2...servicebay-v4.121.0) (2026-06-16)


### Features

* **backups:** surface NAS schedule + add NAS back-up-now, Created column, and delete ([e48e327](https://github.com/mdopp/servicebay/commit/e48e327992f78abe6611f35146b531f2eafba37b)), closes [#1890](https://github.com/mdopp/servicebay/issues/1890)
* **backups:** surface NAS schedule, back-up-now, Created column, and delete ([054a117](https://github.com/mdopp/servicebay/commit/054a11703bea51b9ca5a7798d7547691e19b99e1))

## [4.120.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.120.1...servicebay-v4.120.2) (2026-06-16)


### Bug Fixes

* **approvals:** confine declared move to the service jail and restart to self ([04cb314](https://github.com/mdopp/servicebay/commit/04cb3145549bf87542782e098c7250c179a65798)), closes [#1884](https://github.com/mdopp/servicebay/issues/1884)
* defer logs.db VACUUM off boot path + confine approvals move/restart ([6f91461](https://github.com/mdopp/servicebay/commit/6f91461df8c45b3aa875382fae3222c37f0ef6de))
* **logger:** defer logs.db VACUUM off the synchronous boot path ([076bf15](https://github.com/mdopp/servicebay/commit/076bf1517ddb12a8368d5a422d2fcd06a06c85cc)), closes [#1883](https://github.com/mdopp/servicebay/issues/1883)

## [4.120.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.120.0...servicebay-v4.120.1) (2026-06-15)


### Bug Fixes

* **agent:** stop trace wrapper from commenting out the command ([62f8d3d](https://github.com/mdopp/servicebay/commit/62f8d3d341c0bf86ac11841ced51a294c8a112b4)), closes [#1877](https://github.com/mdopp/servicebay/issues/1877)
* nginx proxy-host template ownership + executor trace wrapper no-op ([4aac98b](https://github.com/mdopp/servicebay/commit/4aac98b389fe74493bc2e5895a21997ea54b46f3))
* **nginx:** own a proxy host by its declaring template, not derived service ([d1142c1](https://github.com/mdopp/servicebay/commit/d1142c1bdca9bac3ef1b7062e7824bcad2cd8e8a)), closes [#1862](https://github.com/mdopp/servicebay/issues/1862)

## [4.120.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.119.2...servicebay-v4.120.0) (2026-06-15)


### Features

* **dashboards:** show diagnose status breakdown on Home Overview card ([df74a1d](https://github.com/mdopp/servicebay/commit/df74a1d2ae645b86a7d5e0dbe265df9f56607ccd)), closes [#1873](https://github.com/mdopp/servicebay/issues/1873)
* **mcp:** add typed non-destructive read tools (read_file/list_dir/disk_usage/container_exec) ([9a5daf7](https://github.com/mdopp/servicebay/commit/9a5daf73d3620c1f592a16a570d48fc73dfb6499)), closes [#1872](https://github.com/mdopp/servicebay/issues/1872)
* typed non-destructive MCP read tools + Home Diagnose status card ([394fc46](https://github.com/mdopp/servicebay/commit/394fc4680492fb65a620ebccc4f0f9635b208eab))


### Bug Fixes

* **install:** reconcile NPM proxy advanced_config on redeploy + fix [#1872](https://github.com/mdopp/servicebay/issues/1872) MCP read tools ([912f803](https://github.com/mdopp/servicebay/commit/912f803f86ea5bacd15e3dcfbf4dcbb1ef213526))
* **mcp:** canonicalize JAIL_ROOT symlink for read_file/list_dir on FCoS ([5c7d572](https://github.com/mdopp/servicebay/commit/5c7d57250db21e69dbc8b2d8ec728e950d0a5a25))
* **mcp:** canonicalize JAIL_ROOT symlink so read_file/list_dir accept FCoS paths ([480558c](https://github.com/mdopp/servicebay/commit/480558c5134bc77a53b70fb8b7972777aa7b7d4c)), closes [#1872](https://github.com/mdopp/servicebay/issues/1872)
* **mcp:** fix [#1872](https://github.com/mdopp/servicebay/issues/1872) box-verify reds in MCP read tools ([220ce68](https://github.com/mdopp/servicebay/commit/220ce68d81f17f32fbba163a5b1414db3e6a7aee))
* **nginx:** reconcile template-owned proxy host advanced_config on redeploy ([34be631](https://github.com/mdopp/servicebay/commit/34be631c6d0cbebadba21ac64dde8987ed893785)), closes [#1862](https://github.com/mdopp/servicebay/issues/1862)

## [4.119.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.119.1...servicebay-v4.119.2) (2026-06-15)


### Bug Fixes

* **backups,logger:** bound MCP auto-snapshot growth + logs.db retention ([93b0ec0](https://github.com/mdopp/servicebay/commit/93b0ec097d4d5e3fe6da761ed3044d8680ebc1d3))
* **logger:** add time-based retention + VACUUM to logs.db ([8497540](https://github.com/mdopp/servicebay/commit/8497540788c52cdddc1132057ffd28cddccf9153)), closes [#1869](https://github.com/mdopp/servicebay/issues/1869)
* **systembackup:** dedup + kind label + auto-retention for MCP pre-mutation snapshots ([9ae0285](https://github.com/mdopp/servicebay/commit/9ae02851ea1602eb6415521def26e4c3c14d9912)), closes [#1868](https://github.com/mdopp/servicebay/issues/1868)

## [4.119.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.119.0...servicebay-v4.119.1) (2026-06-15)


### Bug Fixes

* **externalBackup:** rotate NAS backups into dated slots with retention pruning ([9ff3388](https://github.com/mdopp/servicebay/commit/9ff3388215270857a35e54ce52ea66adb8d0ca4d)), closes [#1865](https://github.com/mdopp/servicebay/issues/1865)
* **ha,externalBackup:** guard HA on emptied config + rotate NAS backups into dated slots ([26598b4](https://github.com/mdopp/servicebay/commit/26598b4b58bb413fca38f1630e20e115228fb509))
* **services:** guard HA against starting on an emptied automations config ([ec7feec](https://github.com/mdopp/servicebay/commit/ec7feec55afb1ca4ef9f36393f0dcad414afd4f3)), closes [#1864](https://github.com/mdopp/servicebay/issues/1864)

## [4.119.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.118.1...servicebay-v4.119.0) (2026-06-15)


### Features

* **dashboards:** surface per-service image-update badge + overview ([d2b21e2](https://github.com/mdopp/servicebay/commit/d2b21e2f3b23fded4b56feb22c1ffbfb50312e7c)), closes [#1860](https://github.com/mdopp/servicebay/issues/1860)
* **stacks:** add per-service image-update digest-check API ([821a42d](https://github.com/mdopp/servicebay/commit/821a42da395aea63947d1f992efd41a12296eefe)), closes [#1859](https://github.com/mdopp/servicebay/issues/1859)
* **stacks:** surface per-service image-update availability (API + dashboard) ([5e69b36](https://github.com/mdopp/servicebay/commit/5e69b36c29530e2ca38db59949d48130deb8291e))

## [4.118.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.118.0...servicebay-v4.118.1) (2026-06-15)


### Bug Fixes

* **auth:** derive rate-limit key from trusted last XFF hop ([dd7f1ba](https://github.com/mdopp/servicebay/commit/dd7f1bade2650771b4461f3e034a29c97c73ce68)), closes [#1852](https://github.com/mdopp/servicebay/issues/1852)
* **backup:** pass CIFS password via 0600 credentials file, not inline -o ([47d5db7](https://github.com/mdopp/servicebay/commit/47d5db7e02d6a3545befac802af3cb6eb2691315)), closes [#1855](https://github.com/mdopp/servicebay/issues/1855)
* **reverseProxy:** validate + shell-quote NPM rekey container exec ([8b92f16](https://github.com/mdopp/servicebay/commit/8b92f164832f71a1e8e0004b98a2e25f3ba67e77)), closes [#1854](https://github.com/mdopp/servicebay/issues/1854)
* **security:** harden XFF rate-limit key, SSH exec, NPM rekey, CIFS mount ([31b6560](https://github.com/mdopp/servicebay/commit/31b656040352a94f44243ddaf3cbb429ae513259))
* **ssh:** run verifySSHConnection via execFile, no shell ([4a210b4](https://github.com/mdopp/servicebay/commit/4a210b4b6c2a40c1f2f36739dba78e0ce9df590b)), closes [#1853](https://github.com/mdopp/servicebay/issues/1853)

## [4.118.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.117.1...servicebay-v4.118.0) (2026-06-15)


### Features

* **voice:** optional openWakeWord custom-models slot ([123c9f3](https://github.com/mdopp/servicebay/commit/123c9f3aed49b60a3cdd8ee31ee43f794c1babbb))
* **voice:** optional openWakeWord custom-models slot ([3bff5b5](https://github.com/mdopp/servicebay/commit/3bff5b52f61399359d1623e30fca7e04692c6b46)), closes [#1832](https://github.com/mdopp/servicebay/issues/1832)

## [4.117.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.117.0...servicebay-v4.117.1) (2026-06-15)


### Bug Fixes

* **home-assistant:** write .solaris HA token path + migrate from .solilos ([a743738](https://github.com/mdopp/servicebay/commit/a743738add1f0e9104653bc4080bf1852651b292))
* **home-assistant:** write .solaris HA token path + migrate from .solilos ([5597cf2](https://github.com/mdopp/servicebay/commit/5597cf22118a6e5a9541ef43996da84f89923a00)), closes [#1847](https://github.com/mdopp/servicebay/issues/1847)

## [4.117.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.116.2...servicebay-v4.117.0) (2026-06-15)


### Features

* **approvals:** generic approval-request API + UI (replaces oscar pending-skills) ([36d5e23](https://github.com/mdopp/servicebay/commit/36d5e23d2852fff751719924c263dd7eaaa4d23f))
* **approvals:** generic approval-request backend ([da6cf95](https://github.com/mdopp/servicebay/commit/da6cf95b637e404672d3b496a706fec4453adda2)), closes [#1843](https://github.com/mdopp/servicebay/issues/1843)
* **settings:** generic Approvals UI replacing PendingSkillsSection ([ddea2ee](https://github.com/mdopp/servicebay/commit/ddea2eec78d6f655fd307965a8459605ffe514b2)), closes [#1844](https://github.com/mdopp/servicebay/issues/1844)

## [4.116.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.116.1...servicebay-v4.116.2) (2026-06-15)


### Bug Fixes

* **registry:** reset registry refresh to FETCH_HEAD so install reaches remote HEAD ([983b6ed](https://github.com/mdopp/servicebay/commit/983b6edd8c43f4e07390810ee9b1f211df41fbe4))
* **registry:** reset registry refresh to FETCH_HEAD so install reaches remote HEAD ([21ea5b4](https://github.com/mdopp/servicebay/commit/21ea5b4145ed274768f17f7c2cadd8c9f51bba58)), closes [#1836](https://github.com/mdopp/servicebay/issues/1836)
* **voice:** stop dead piper TTS container on GPU boxes ([f619b8f](https://github.com/mdopp/servicebay/commit/f619b8f3d862b7743bb126e4135d062eda6108d4))
* **voice:** stop dead piper TTS container on GPU boxes ([1270e27](https://github.com/mdopp/servicebay/commit/1270e27a0b0fd9c1bbc4bf2da8387e6c2fb6e5ff)), closes [#1833](https://github.com/mdopp/servicebay/issues/1833)

## [4.116.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.116.0...servicebay-v4.116.1) (2026-06-14)


### Bug Fixes

* **claude-dev:** share /workspace across dev + LDAP users (writable checkouts) ([e2e002f](https://github.com/mdopp/servicebay/commit/e2e002f8359966ce232ced6c70e615d6ea6a5096))
* **claude-dev:** share /workspace across dev + LDAP users so checkouts are writable ([1930e31](https://github.com/mdopp/servicebay/commit/1930e31fa5dfcd728b4bb685cd70c1094dea8f74))

## [4.116.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.115.1...servicebay-v4.116.0) (2026-06-14)


### Features

* **claude-dev:** add `start-claude` to launch one Claude per directory ([89ddd2c](https://github.com/mdopp/servicebay/commit/89ddd2cda9bc51d1ddde9b8406a755be74a62ba5))
* **claude-dev:** add start-claude — one Claude per directory with Remote Control ([e50ddbf](https://github.com/mdopp/servicebay/commit/e50ddbf086747722760bf8b990caa9eb6fd803e6))

## [4.115.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.115.0...servicebay-v4.115.1) (2026-06-14)


### Bug Fixes

* **claude-dev:** make LDAP login work with LLDAP 0.6.x (auth-only + local provisioning) ([2c99f51](https://github.com/mdopp/servicebay/commit/2c99f5149883189fca8d63976776a6412070aaf1))
* **claude-dev:** make LDAP login work with LLDAP 0.6.x (auth-only model) ([84913d2](https://github.com/mdopp/servicebay/commit/84913d2c3aecc87e28fc531f1de05831299c6a18))

## [4.115.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.114.0...servicebay-v4.115.0) (2026-06-14)


### Features

* **claude-dev:** authenticate SSH against LLDAP so you log in as your real user ([e48319f](https://github.com/mdopp/servicebay/commit/e48319f1a2be7f194cfb91808540a8db5de52507)), closes [#1827](https://github.com/mdopp/servicebay/issues/1827)
* **claude-dev:** LLDAP SSH login + fix dev-box mislabel as 'ServiceBay System' ([73621b4](https://github.com/mdopp/servicebay/commit/73621b4d64b5e7775a8fde6f02d28c00b6f088bd))


### Bug Fixes

* **twin:** stop mislabeling servicebay-claude-dev as the ServiceBay System unit ([e30177d](https://github.com/mdopp/servicebay/commit/e30177d155a7d98f6701d7e5989f74aa4db03a99))

## [4.114.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.113.0...servicebay-v4.114.0) (2026-06-13)


### Features

* **mcp:** distinguish approved vs denied access requests ([8383077](https://github.com/mdopp/servicebay/commit/83830777068e9aa9887a6f4771aa8811d457d505))
* **mcp:** distinguish approved vs denied access requests ([2efb669](https://github.com/mdopp/servicebay/commit/2efb669f599e56926671f900e28bf9c58cc35a3f)), closes [#1824](https://github.com/mdopp/servicebay/issues/1824)

## [4.113.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.112.0...servicebay-v4.113.0) (2026-06-13)


### Features

* **mcp:** add username to file_access_request and show kind/requestedBy in admin UI ([aa1278f](https://github.com/mdopp/servicebay/commit/aa1278fc393919739a717d7e1911595401cef7f6)), closes [#1821](https://github.com/mdopp/servicebay/issues/1821)
* **mcp:** add username to file_access_request and surface kind/requestedBy in admin UI ([776ff5c](https://github.com/mdopp/servicebay/commit/776ff5cd49ce72e178fc1f6caeb6d8772b0f5897))

## [4.112.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.111.0...servicebay-v4.112.0) (2026-06-13)


### Features

* **mcp:** access-request tools and install kube restart on spec change ([0470444](https://github.com/mdopp/servicebay/commit/0470444ae7318b12e2f035f5e3ac0c8cd8b7364e))
* **mcp:** expose access-request file/list/poll tools for admin approval ([b623a05](https://github.com/mdopp/servicebay/commit/b623a05f7782e5dea806e00976e09970bca6c0b8)), closes [#1818](https://github.com/mdopp/servicebay/issues/1818)


### Bug Fixes

* **install:** restart kube service when the pod spec changed on re-deploy ([5f37142](https://github.com/mdopp/servicebay/commit/5f37142d0d383e316c052c8500aa8a9c32cf3f21)), closes [#1813](https://github.com/mdopp/servicebay/issues/1813)

## [4.111.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.110.0...servicebay-v4.111.0) (2026-06-12)


### Features

* **voice:** Sol speaks Kokoro-Martin on GPU boxes ([c864896](https://github.com/mdopp/servicebay/commit/c864896775c90becdc84b65e70caf67c26b4147a)), closes [#1815](https://github.com/mdopp/servicebay/issues/1815)


### Bug Fixes

* **voice:** install_whisper_unit still called the refactored-away helper ([7717928](https://github.com/mdopp/servicebay/commit/77179289f51dd62a3682e71a058c6e35c1bb4850)), closes [#1815](https://github.com/mdopp/servicebay/issues/1815)

## [4.110.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.109.2...servicebay-v4.110.0) (2026-06-12)


### Features

* **voice:** run whisper STT on the GPU via a companion container Quadlet ([ba8b3b9](https://github.com/mdopp/servicebay/commit/ba8b3b9569c64337c3b375ad6aff5d6de07b383c)), closes [#1809](https://github.com/mdopp/servicebay/issues/1809)


### Bug Fixes

* **voice:** add the v1-to-v2 migration stub the deploy chain requires ([e55a451](https://github.com/mdopp/servicebay/commit/e55a451fbe96606ec0ec70b45103ee658959d600)), closes [#1809](https://github.com/mdopp/servicebay/issues/1809)
* **voice:** create the whisper volume dir and self-heal the stale pod ([5f7cbe6](https://github.com/mdopp/servicebay/commit/5f7cbe6f7b778049d4938ff0fb76568a7d7a6447)), closes [#1809](https://github.com/mdopp/servicebay/issues/1809)

## [4.109.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.109.1...servicebay-v4.109.2) (2026-06-09)


### Bug Fixes

* **install:** pull registries at install start, not only on boot ([#1806](https://github.com/mdopp/servicebay/issues/1806)) ([#1807](https://github.com/mdopp/servicebay/issues/1807)) ([5d5ef8a](https://github.com/mdopp/servicebay/commit/5d5ef8a32a70810d7186d921ebadcc08dcdefc11))

## [4.109.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.109.0...servicebay-v4.109.1) (2026-06-08)


### Bug Fixes

* **registry:** self-heal a permission-broken registry tree ([#1796](https://github.com/mdopp/servicebay/issues/1796)) ([41bf36f](https://github.com/mdopp/servicebay/commit/41bf36fbfa897ee009e22c9021e3d52563f5f1ab))
* **registry:** self-heal a permission-broken registry tree ([#1796](https://github.com/mdopp/servicebay/issues/1796)) ([cfcfc8a](https://github.com/mdopp/servicebay/commit/cfcfc8a0b4e66d2e0f6d5262104b257cbeacf4a9))

## [4.109.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.108.1...servicebay-v4.109.0) (2026-06-08)


### Features

* **maintenance-chat:** embed solilos-chat, retire HermesChatPanel ([#1781](https://github.com/mdopp/servicebay/issues/1781)) ([40de2d6](https://github.com/mdopp/servicebay/commit/40de2d6f52448d2cb0350a44002355b183eaab22))
* **maintenance-chat:** embed solilos-chat, retire HermesChatPanel ([#1781](https://github.com/mdopp/servicebay/issues/1781)) ([284157f](https://github.com/mdopp/servicebay/commit/284157f7e36f34c67b47c284aaee50dabae9cf3d))

## [4.108.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.108.0...servicebay-v4.108.1) (2026-06-08)


### Bug Fixes

* **dashboards:** include suppressed hub deps in network focus/ego mode ([6e24cd2](https://github.com/mdopp/servicebay/commit/6e24cd21d1a31e55d23a0eb28046e0930d6081f5)), closes [#1792](https://github.com/mdopp/servicebay/issues/1792)
* **network-map:** focus mode includes badge-suppressed hub deps ([#1792](https://github.com/mdopp/servicebay/issues/1792)) ([dca0304](https://github.com/mdopp/servicebay/commit/dca03049192bce1542242ae49b9a2042022f7434))

## [4.108.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.107.0...servicebay-v4.108.0) (2026-06-08)


### Features

* **network-map:** per-edge port labels + line-hops over crossings ([32d91aa](https://github.com/mdopp/servicebay/commit/32d91aa3e1f228d577b99a2d3a30bae7ba8e9f02))
* **network:** ELK-placed :Port labels per edge on the network map ([167f41e](https://github.com/mdopp/servicebay/commit/167f41e07e279fe03eb7a15f6fc189d9ba75e7ea)), closes [#1783](https://github.com/mdopp/servicebay/issues/1783)
* **network:** line-hops over crossing edges in the network map ([eebc0cd](https://github.com/mdopp/servicebay/commit/eebc0cd1d2756cad81b34a9c127dbfd513d15711)), closes [#1784](https://github.com/mdopp/servicebay/issues/1784)

## [4.107.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.106.2...servicebay-v4.107.0) (2026-06-08)


### Features

* **network-map:** orthogonal ELK routing + ubiquitous-dep badges + focus/ego mode ([2d3032a](https://github.com/mdopp/servicebay/commit/2d3032a6648b36233d4f531da714d27f5510e067))
* **network:** badge ubiquitous auth/dns deps instead of hub-spoke edges ([2f07884](https://github.com/mdopp/servicebay/commit/2f07884152dfb9c38916d0405ebb65a2ad1fb2bd)), closes [#1785](https://github.com/mdopp/servicebay/issues/1785)
* **network:** focus/ego mode reduces the map to a node's neighbourhood ([8d0dbb9](https://github.com/mdopp/servicebay/commit/8d0dbb9b72c11d14263cff7e894fc08c3a3a465b)), closes [#1786](https://github.com/mdopp/servicebay/issues/1786)
* **network:** render ELK orthogonal edge routing in the network map ([404ef78](https://github.com/mdopp/servicebay/commit/404ef78b6012c3cd6e85732e2eb2c09434be9212)), closes [#1782](https://github.com/mdopp/servicebay/issues/1782)

## [4.106.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.106.1...servicebay-v4.106.2) (2026-06-07)


### Bug Fixes

* **frontend:** stop leaking react-markdown node prop onto chat code elements ([e16a2a9](https://github.com/mdopp/servicebay/commit/e16a2a9d846b60e8c139013013305dd8d573e365)), closes [#1777](https://github.com/mdopp/servicebay/issues/1777)
* maintenance-chat markdown node attr + MCP .container Quadlet support ([c5b9122](https://github.com/mdopp/servicebay/commit/c5b9122d150c372ea410a84caeaada0ddb29562d))
* **mcp:** resolve .container Quadlets in service file-read/update path ([0661baf](https://github.com/mdopp/servicebay/commit/0661baf2f6702d036702e1d57da29efde38d761b)), closes [#1778](https://github.com/mdopp/servicebay/issues/1778)

## [4.106.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.106.0...servicebay-v4.106.1) (2026-06-07)


### Bug Fixes

* **home-assistant:** rename HA long-lived token file to .solilos after OSCAR rename ([34fa4c4](https://github.com/mdopp/servicebay/commit/34fa4c43e0d5ffbee0f1699194263a443e7684f0)), closes [#1769](https://github.com/mdopp/servicebay/issues/1769)
* **home-assistant:** rename long-lived token oscar→solilos with on-disk migration ([5f4d21c](https://github.com/mdopp/servicebay/commit/5f4d21c94a44bb32c2cd1c739dfb462a28c5407d))

## [4.106.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.105.0...servicebay-v4.106.0) (2026-06-07)


### Features

* **hermes:** drop chat avatar icons, render assistant Markdown ([06334ed](https://github.com/mdopp/servicebay/commit/06334ed4f01850229345d38c7571e80a3d16bd8c)), closes [#1767](https://github.com/mdopp/servicebay/issues/1767) [#1768](https://github.com/mdopp/servicebay/issues/1768)
* maintenance-chat markdown + MCP reboot-scope split + MCP approval gate + SSO login smoke ([21641b5](https://github.com/mdopp/servicebay/commit/21641b58c5c61250254ff915bb7f9ae00211a9f2))
* **mcp:** native per-tool approval gate for destructive tools ([e1fcf65](https://github.com/mdopp/servicebay/commit/e1fcf65858f8a4e949896f4fb3130fb376daf100)), closes [#1766](https://github.com/mdopp/servicebay/issues/1766)
* **mcp:** split reboot_node into its own reboot scope tier ([c8126ee](https://github.com/mdopp/servicebay/commit/c8126eec42747f7215b6bea8b4328f473fde255a)), closes [#1765](https://github.com/mdopp/servicebay/issues/1765)


### Bug Fixes

* **mcp:** intercept approve routes in server.ts to fix store isolation ([5bf316b](https://github.com/mdopp/servicebay/commit/5bf316bcc98c58610b1733b2bb64ce5e4dc8a42e))
* **mcp:** intercept approve routes in server.ts to fix store isolation ([de9cd62](https://github.com/mdopp/servicebay/commit/de9cd62823e6d4339fe568e81cb8cbf56f71756b))

## [4.105.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.104.0...servicebay-v4.105.0) (2026-06-06)


### Features

* **hermes:** chat history reload, API-key reconcile, and image-gated update availability ([51168f0](https://github.com/mdopp/servicebay/commit/51168f0070a0b4404b5dcead141c89b5b620c8d2))


### Bug Fixes

* **hermes:** reconcile API key with running engine + distinguish 401 from outage ([b682d15](https://github.com/mdopp/servicebay/commit/b682d15f3c32247667c719ab4a20cb600735d9c0)), closes [#1761](https://github.com/mdopp/servicebay/issues/1761)
* **hermes:** reload maintenance chat history on mount ([cc998a5](https://github.com/mdopp/servicebay/commit/cc998a5774c331a69494213e2c102baaf35db611)), closes [#1760](https://github.com/mdopp/servicebay/issues/1760)
* **updater:** gate update-available on image digest, not just release tag ([b6497e8](https://github.com/mdopp/servicebay/commit/b6497e8b298baefcffbf8e3d9fc22e8ff6e4e238)), closes [#1762](https://github.com/mdopp/servicebay/issues/1762)

## [4.104.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.103.0...servicebay-v4.104.0) (2026-06-06)


### Features

* **frontend:** native Hermes maintenance chat panel + /chat route ([91503cd](https://github.com/mdopp/servicebay/commit/91503cd2fe2b5ed8c4727efb8a1030c1f276f541))
* **frontend:** native Hermes maintenance chat panel + /chat route ([67fac03](https://github.com/mdopp/servicebay/commit/67fac03a192c4858f6a9e49a702aef198aff7c7c)), closes [#1755](https://github.com/mdopp/servicebay/issues/1755)

## [4.103.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.102.2...servicebay-v4.103.0) (2026-06-06)


### Features

* Hermes maintenance-chat backend + MCP service-files field-swap guard ([a1d2c77](https://github.com/mdopp/servicebay/commit/a1d2c77e29077159a97885a6c4aeee51d602c0dc))
* **hermes:** maintenance chat backend client + admin-for-families persona + session lifecycle ([47d928a](https://github.com/mdopp/servicebay/commit/47d928a797982e6c089a2e95665552d71003d753)), closes [#1754](https://github.com/mdopp/servicebay/issues/1754)


### Bug Fixes

* **mcp:** stop get_service_files/update_service_yaml field swap on round-trip ([918a97a](https://github.com/mdopp/servicebay/commit/918a97add8a17aba262dc3190e0867f792883d2b)), closes [#1752](https://github.com/mdopp/servicebay/issues/1752)

## [4.102.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.102.1...servicebay-v4.102.2) (2026-06-06)


### Bug Fixes

* **auth:** add migrations/v1-to-v2.py to complete the auth schema-v2 chain ([bb2dcbb](https://github.com/mdopp/servicebay/commit/bb2dcbbb1ec85f72c5f8573fc342a5267cd23b21))
* **auth:** add migrations/v1-to-v2.py to complete the auth schema-v2 chain ([2c50a8b](https://github.com/mdopp/servicebay/commit/2c50a8b510dd697391ae33b7c674f9ef2d3f4628)), closes [#1749](https://github.com/mdopp/servicebay/issues/1749)

## [4.102.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.102.0...servicebay-v4.102.1) (2026-06-06)


### Bug Fixes

* **auth:** add default_redirection_url for portal-direct Authelia login ([98d77e2](https://github.com/mdopp/servicebay/commit/98d77e2455899bc50411bb62f5be17c8afd4f202)), closes [#1742](https://github.com/mdopp/servicebay/issues/1742)
* **auth:** land portal-direct login on www via default_redirection_url ([6824eea](https://github.com/mdopp/servicebay/commit/6824eea98f60bb5616432f96bbec2d811ba223d8))

## [4.102.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.101.0...servicebay-v4.102.0) (2026-06-06)


### Features

* **diagnose:** reconcile OIDC clients as an sso_verify heal-action ([390b03e](https://github.com/mdopp/servicebay/commit/390b03e0d48584381141912a8f0ac8a99e4e5e2b)), closes [#1741](https://github.com/mdopp/servicebay/issues/1741)


### Bug Fixes

* **auth:** portable LLDAP-readiness probe + Phase 2 OIDC reconcile heal-action ([0801143](https://github.com/mdopp/servicebay/commit/08011434f9bd91e8d734900dfa2b9571650d84c6))
* **auth:** reconcile OIDC client_secret on re-register + gate Authelia on LLDAP readiness ([59f67d6](https://github.com/mdopp/servicebay/commit/59f67d6a68bd9f4c2e9385ad241d99fc7c53bf22)), closes [#1738](https://github.com/mdopp/servicebay/issues/1738) [#1737](https://github.com/mdopp/servicebay/issues/1737)
* **auth:** use BusyBox-portable nc probe for LLDAP readiness gate ([da71ee5](https://github.com/mdopp/servicebay/commit/da71ee5f1f36d3139ded682975adf7c87243ecf3)), closes [#1745](https://github.com/mdopp/servicebay/issues/1745)
* **media:** remove Audiobookshelf seed/wait block from post-deploy ([c122fcc](https://github.com/mdopp/servicebay/commit/c122fccf114f0f135ef21cfa81b8b9c636235139)), closes [#1740](https://github.com/mdopp/servicebay/issues/1740)
* OIDC secret reconcile + LLDAP readiness gate + media post-deploy ABS cleanup ([1764003](https://github.com/mdopp/servicebay/commit/17640037825551cf6cba2836e5d9575e9f06d01a))

## [4.101.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.100.0...servicebay-v4.101.0) (2026-06-06)


### Features

* **mcp:** add server instructions + teach the service-container model ([7ab4b80](https://github.com/mdopp/servicebay/commit/7ab4b80e149967a92c284880dd854db975aab011)), closes [#1732](https://github.com/mdopp/servicebay/issues/1732)


### Bug Fixes

* **media:** drop shared-tree SELinux relabel + finish ABS retirement ([b6daac6](https://github.com/mdopp/servicebay/commit/b6daac6a4b35a96ddbe0001d5f73dd0ea248a5a8)), closes [#1730](https://github.com/mdopp/servicebay/issues/1730) [#1731](https://github.com/mdopp/servicebay/issues/1731)
* **media:** finish ABS retirement + drop shared-tree SELinux relabel; managed-Quadlet detection; MCP self-description ([2f390f5](https://github.com/mdopp/servicebay/commit/2f390f5a71d54838b4507446f3dbf5971ded628f))
* **services:** treat single-container Quadlets in installedTemplates as managed ([b9d3a7a](https://github.com/mdopp/servicebay/commit/b9d3a7a6fbc5a51212520c1c79f2ae1d7dad7ea9)), closes [#1733](https://github.com/mdopp/servicebay/issues/1733)

## [4.100.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.99.2...servicebay-v4.100.0) (2026-06-06)


### Features

* **media:** retire Audiobookshelf for fresh installs, serve audiobooks via Jellyfin ([526c67b](https://github.com/mdopp/servicebay/commit/526c67b88899142f70f0dbfdd47b53768df0f0f8)), closes [#1725](https://github.com/mdopp/servicebay/issues/1725)


### Bug Fixes

* **auth:** preserve other stacks' Authelia OIDC clients on auth redeploy ([ea3ee4e](https://github.com/mdopp/servicebay/commit/ea3ee4e2d9a73a3bb38271336407e096cf1b3cc5)), closes [#1724](https://github.com/mdopp/servicebay/issues/1724)

## [4.99.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.99.1...servicebay-v4.99.2) (2026-06-05)


### Bug Fixes

* **media:** self-heal ABS OIDC secret + wire Jellyfin to LLDAP SSO ([153faf1](https://github.com/mdopp/servicebay/commit/153faf19223bf31b7e496470acd32a7eff3b2a60))
* **media:** self-heal ABS OIDC secret + wire Jellyfin to LLDAP SSO ([9e7b412](https://github.com/mdopp/servicebay/commit/9e7b412b458c597f35770653579bb4ad1c46c6cc)), closes [#1717](https://github.com/mdopp/servicebay/issues/1717) [#1718](https://github.com/mdopp/servicebay/issues/1718)

## [4.99.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.99.0...servicebay-v4.99.1) (2026-06-05)


### Bug Fixes

* **backups:** collapse Backup Sync config body when disabled ([87e7b4c](https://github.com/mdopp/servicebay/commit/87e7b4c11fbe7e37a37a916e0902fff087cfb241)), closes [#1710](https://github.com/mdopp/servicebay/issues/1710)
* disk-import privileged host exec + backup-sync collapse ([d58d788](https://github.com/mdopp/servicebay/commit/d58d788a13e52353f6c1faba6d20d0acf0768828))
* **diskImport:** run privileged host ops via opt-in safe_exec sudo ([4dcd2a4](https://github.com/mdopp/servicebay/commit/4dcd2a47e6e68bdb058386db557b8c4fb7dcb1ae)), closes [#1713](https://github.com/mdopp/servicebay/issues/1713)

## [4.99.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.98.0...servicebay-v4.99.0) (2026-06-05)


### Features

* **dashboards:** fold DNS resolvers into Network card + half-width Graphics/Network ([d1f9295](https://github.com/mdopp/servicebay/commit/d1f92959d150428ae2ceda06112dfd2008f0c786)), closes [#1706](https://github.com/mdopp/servicebay/issues/1706) [#1707](https://github.com/mdopp/servicebay/issues/1707)


### Bug Fixes

* **diagnose:** DNS timeout ≠ NXDOMAIN + sso_verify re-runs on manual ([ccd8b43](https://github.com/mdopp/servicebay/commit/ccd8b439e7cc826dc194a57c88357cdc2514f2cb)), closes [#1708](https://github.com/mdopp/servicebay/issues/1708) [#1709](https://github.com/mdopp/servicebay/issues/1709)
* **mcp:** re-activatable bootstrap token — expire in place, don't delete ([28b7571](https://github.com/mdopp/servicebay/commit/28b757129b4687093869b657daef754b36e7443a)), closes [#1705](https://github.com/mdopp/servicebay/issues/1705)
* SystemInfo layout polish + diagnose probe correctness + re-activatable bootstrap token ([f5c8889](https://github.com/mdopp/servicebay/commit/f5c8889a3c579697b80e0d5f8bba02f3182ca901))

## [4.98.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.97.0...servicebay-v4.98.0) (2026-06-05)


### Features

* **disk-import:** deterministic engine core — classify, dedup, catalog ([c162759](https://github.com/mdopp/servicebay/commit/c162759a247d9271918b50bfff2ae1ed8a84fba5)), closes [#1693](https://github.com/mdopp/servicebay/issues/1693)
* **disk-import:** host mount + resumable apply via safe_exec ([5d81fcd](https://github.com/mdopp/servicebay/commit/5d81fcd60ca16d04cdbbe5c32f82d2007c8509b9)), closes [#1694](https://github.com/mdopp/servicebay/issues/1694)
* **disk-import:** import engine + host-apply + CLI + UI card; portal card sizing; healthcheck block-scalar var fix ([79c7622](https://github.com/mdopp/servicebay/commit/79c762212f4328f6c115c4376986ec03a1ade200))
* **disk-import:** local-Ollama classifier — advisory review-plan suggestions ([86abb5b](https://github.com/mdopp/servicebay/commit/86abb5b56fb17908e6734fa76ba8756772ae1ea8)), closes [#1695](https://github.com/mdopp/servicebay/issues/1695)
* **disk-import:** repeatable CLI with review gate ([6674bf0](https://github.com/mdopp/servicebay/commit/6674bf0e2c9840f5785827cd932b8c6f8a4418f3)), closes [#1696](https://github.com/mdopp/servicebay/issues/1696)
* **disk-import:** ServiceBay 'Import data' card — routes + settings section ([0552c01](https://github.com/mdopp/servicebay/commit/0552c018711357e860f47f075bba8e88ee818e34)), closes [#1697](https://github.com/mdopp/servicebay/issues/1697)
* **portal:** weight-driven card sizeTier + content-driven grid heights ([3db1a37](https://github.com/mdopp/servicebay/commit/3db1a379e86e1e4eeaa9aae38465c542bb6bae24)), closes [#1700](https://github.com/mdopp/servicebay/issues/1700)


### Bug Fixes

* **health:** accept unquoted block-scalar {{VAR}} healthcheck port ([fc642bc](https://github.com/mdopp/servicebay/commit/fc642bc023b4b409ad6ea2bbcd00800df6f3c68a)), closes [#1688](https://github.com/mdopp/servicebay/issues/1688)

## [4.97.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.96.0...servicebay-v4.97.0) (2026-06-05)


### Features

* **health:** show effective DNS resolvers in System Networks section ([2c7db4e](https://github.com/mdopp/servicebay/commit/2c7db4e2daa594f6a083c858e5f07ff092e0d4e4)), closes [#1676](https://github.com/mdopp/servicebay/issues/1676)


### Bug Fixes

* forward-auth 403 explainer, orphan-container reconcile, Claude Dev card, DNS-resolvers health UI ([ca33fa4](https://github.com/mdopp/servicebay/commit/ca33fa4e2f4dac0362f1d4f0cd56fd28ff055fe4))
* **install:** reconcile orphan podman container records on reinstall ([7f9f58b](https://github.com/mdopp/servicebay/commit/7f9f58b2aed9043a70a2a40d109b4eca0ad35db8)), closes [#1668](https://github.com/mdopp/servicebay/issues/1668)
* **portal:** read lanIp from config.reverseProxy for Claude Dev host ([e6099bb](https://github.com/mdopp/servicebay/commit/e6099bbb7c7858135ffb8d60497c0b3729eb6048))
* **portal:** repair Claude Dev card terminal, category + VS Code link ([c8e9c9c](https://github.com/mdopp/servicebay/commit/c8e9c9c720df060b7821a5daacda157239444a6b)), closes [#1681](https://github.com/mdopp/servicebay/issues/1681) [#1682](https://github.com/mdopp/servicebay/issues/1682)
* **reverseProxy:** name the missing group on a forward-auth 403 deny ([51b473d](https://github.com/mdopp/servicebay/commit/51b473d1f60264db2f1b40499ef3e61ebedc372c)), closes [#1684](https://github.com/mdopp/servicebay/issues/1684)

## [4.96.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.95.2...servicebay-v4.96.0) (2026-06-05)


### Features

* **health:** nginx_config_valid probe runs nginx -t in the NPM container ([2f4d9e7](https://github.com/mdopp/servicebay/commit/2f4d9e7e9c18b3b856cec51d325becb06be44ee1)), closes [#1678](https://github.com/mdopp/servicebay/issues/1678)


### Bug Fixes

* box-DNS resolution, monitoring trust, sb launcher/boot, SQLite WAL, nginx config-valid probe ([c218dff](https://github.com/mdopp/servicebay/commit/c218dffcacfc013d79c454e9fcdc206797cfbe7b))
* **health:** system self-checks bypass SSRF guard + diagnose rows get history ([9e25f44](https://github.com/mdopp/servicebay/commit/9e25f449cdd40fe98b6c560b056fb5868c418360)), closes [#1670](https://github.com/mdopp/servicebay/issues/1670) [#1671](https://github.com/mdopp/servicebay/issues/1671)
* **router:** box DNS points at AdGuard + LAN-path verification for DNS probes ([9461ad2](https://github.com/mdopp/servicebay/commit/9461ad27d9887a815466d1f55d7cfcec953bb39f)), closes [#1672](https://github.com/mdopp/servicebay/issues/1672) [#1675](https://github.com/mdopp/servicebay/issues/1675)
* **sb:** stale token != not-set-up; usb-next boots the real installer device ([6edb80e](https://github.com/mdopp/servicebay/commit/6edb80e232dc6e9128192d3c3051767f0153d821)), closes [#1669](https://github.com/mdopp/servicebay/issues/1669) [#1674](https://github.com/mdopp/servicebay/issues/1674)
* **templates:** WAL-mode Authelia + NPM SQLite to stop "database is locked" ([8bebee6](https://github.com/mdopp/servicebay/commit/8bebee6e88f0e8d812d99f9ef68e77e242d3896f)), closes [#1679](https://github.com/mdopp/servicebay/issues/1679)

## [4.95.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.95.1...servicebay-v4.95.2) (2026-06-04)


### Bug Fixes

* **build:** make setup-raid mdadm.conf persistence idempotent ([6d4ae77](https://github.com/mdopp/servicebay/commit/6d4ae77b0c2e4534910b113d111011efab3ee6df)), closes [#1666](https://github.com/mdopp/servicebay/issues/1666)
* **diagnose:** sso_verify probe correctness — set_password admin path, ollama + OIDC coverage ([bd4c0b3](https://github.com/mdopp/servicebay/commit/bd4c0b3a06efd97b7e8d41b504c62d0bbe628c65)), closes [#1673](https://github.com/mdopp/servicebay/issues/1673) [#1685](https://github.com/mdopp/servicebay/issues/1685)
* **home-assistant:** survive backup-restore of YAML config + helpers ([69c01be](https://github.com/mdopp/servicebay/commit/69c01be16c4457bd6a26b064abf26fa246265446)), closes [#1686](https://github.com/mdopp/servicebay/issues/1686) [#1687](https://github.com/mdopp/servicebay/issues/1687)
* **install:** preserve secret.key/.auth-secret.env across wipe-config reinstall when enc config exists ([ad48207](https://github.com/mdopp/servicebay/commit/ad4820743dd1d22b2d82762ea62be5fc0079201e)), closes [#1667](https://github.com/mdopp/servicebay/issues/1667)
* reinstall config-survival batch — mdadm, secret-key, ollama domain, HA restore, sso_verify ([0947045](https://github.com/mdopp/servicebay/commit/094704533cc1520749ab3b37bc5673c8ae310538))
* **reverseProxy:** add localUpstreamHost to frontend proxy-host route type ([21222a5](https://github.com/mdopp/servicebay/commit/21222a513857431014dda1f424e68cda6d0ec724)), closes [#1683](https://github.com/mdopp/servicebay/issues/1683)
* **reverseProxy:** make ollama reachable via domain after reinstall ([0002964](https://github.com/mdopp/servicebay/commit/0002964c9c32b9393e03eaf73092b288489023d0)), closes [#1677](https://github.com/mdopp/servicebay/issues/1677) [#1680](https://github.com/mdopp/servicebay/issues/1680) [#1683](https://github.com/mdopp/servicebay/issues/1683)

## [4.95.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.95.0...servicebay-v4.95.1) (2026-06-04)


### Bug Fixes

* **health,portal:** alert root-cause correctness + portal down badge ([8d95f6b](https://github.com/mdopp/servicebay/commit/8d95f6b03ba914425cce8f476cb66d97282e2a1b))
* **health:** apply root-cause graph to recovery alerts and template http probes ([b465757](https://github.com/mdopp/servicebay/commit/b46575798e1a230f7cc7517e3ff5b899d32d1259)), closes [#1661](https://github.com/mdopp/servicebay/issues/1661) [#1663](https://github.com/mdopp/servicebay/issues/1663)
* **health:** drop dead tcp branch in serviceOfCheck (tsc seal fix) ([86f91fa](https://github.com/mdopp/servicebay/commit/86f91fab4a62bd2cfab40a6e0bafe04873381c58)), closes [#1663](https://github.com/mdopp/servicebay/issues/1663)
* **portal:** show down badge for stopped installed services ([c7e9f28](https://github.com/mdopp/servicebay/commit/c7e9f284179e9ab018c691b802624694dcf77239)), closes [#1662](https://github.com/mdopp/servicebay/issues/1662)

## [4.95.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.94.0...servicebay-v4.95.0) (2026-06-04)


### Features

* **health:** enrich restart/update digest (epic [#1650](https://github.com/mdopp/servicebay/issues/1650) item C) ([980e296](https://github.com/mdopp/servicebay/commit/980e296f4af13e9ff54c8a69ae28f833240b436c))
* **health:** enrich restart/update digest with version change, recovery duration, changelog ([39b9dce](https://github.com/mdopp/servicebay/commit/39b9dcec3fa7d76499b588d09b55615ffcbb9820)), closes [#1653](https://github.com/mdopp/servicebay/issues/1653)
* **health:** root-cause-only alerting + service-centered causal-chain email ([71841e5](https://github.com/mdopp/servicebay/commit/71841e54384312944f6528d2a4a00aff4b7cea73))
* **health:** root-cause-only alerting + service-centered causal-chain email ([6e4036d](https://github.com/mdopp/servicebay/commit/6e4036dde5d49a61714e36824a4adb0c7080a7f8)), closes [#1652](https://github.com/mdopp/servicebay/issues/1652)

## [4.94.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.93.1...servicebay-v4.94.0) (2026-06-04)


### Features

* **health,portal:** per-type alert failureThreshold + portal service status badge ([8818e61](https://github.com/mdopp/servicebay/commit/8818e61f860a51be2742b53d8330585f11589578))
* **health:** per-type failureThreshold before alerting ([6a2aa29](https://github.com/mdopp/servicebay/commit/6a2aa29d4ab7ed8a6c1d8e8a8a7320f58147d66a)), closes [#1651](https://github.com/mdopp/servicebay/issues/1651)
* **portal:** per-service up/down status badge on each card ([84fc192](https://github.com/mdopp/servicebay/commit/84fc192dd13742ce0a0b0f61408bd298fc89a15a)), closes [#1654](https://github.com/mdopp/servicebay/issues/1654)

## [4.93.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.93.0...servicebay-v4.93.1) (2026-06-03)


### Bug Fixes

* **portal:** migrate Authelia soft-auth off deprecated /api/verify ([6b9a7a6](https://github.com/mdopp/servicebay/commit/6b9a7a6367dd208189aedc33174e5dd3a1dee752))
* **portal:** migrate Authelia soft-auth off deprecated /api/verify ([b5bf2d7](https://github.com/mdopp/servicebay/commit/b5bf2d7ee424198669bf3ea405ef5e3c541d2526))
* **settings:** move Access requests panel from Networking to Security ([7359c4d](https://github.com/mdopp/servicebay/commit/7359c4d9f4a512333605e9fc2030e8172e99c88d))
* **settings:** move Access requests panel from Networking to Security ([f2cf96f](https://github.com/mdopp/servicebay/commit/f2cf96fc3a61f7e1ad90711e3a8bfdd5dcab8729)), closes [#1605](https://github.com/mdopp/servicebay/issues/1605)

## [4.93.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.92.0...servicebay-v4.93.0) (2026-06-03)


### Features

* **backup:** relabel Backups page to System Snapshot + Backup Sync ([b0fae9b](https://github.com/mdopp/servicebay/commit/b0fae9b089cf0d0ce22353ca5c8acbeb785d6072))
* **backup:** relabel Backups page to two backups — System Snapshot + Backup Sync ([f3dc76a](https://github.com/mdopp/servicebay/commit/f3dc76a3cf458cf00507a3c1ec0b9b6de67c0321)), closes [#1611](https://github.com/mdopp/servicebay/issues/1611)

## [4.92.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.91.0...servicebay-v4.92.0) (2026-06-03)


### Features

* **claude-dev:** add portal card user-guide with terminal + VS Code actions ([ac6ffea](https://github.com/mdopp/servicebay/commit/ac6ffead79fc3a030de914faa96f859ec8620dcc)), closes [#1619](https://github.com/mdopp/servicebay/issues/1619)


### Bug Fixes

* **file-share:** create POSIX user before smbpasswd -a for Samba accounts ([eed426f](https://github.com/mdopp/servicebay/commit/eed426f121287fe3cdc3033da99365b885f3f52d)), closes [#1630](https://github.com/mdopp/servicebay/issues/1630)
* **portal:** accept SSO sessions for portal setup assets in public mode ([92ef426](https://github.com/mdopp/servicebay/commit/92ef4265cff38a512da869a7743483bd9a170c18)), closes [#1628](https://github.com/mdopp/servicebay/issues/1628)
* saved-credential public URLs, portal SSO assets, Samba POSIX user, unified restore engine, claude-dev + Syncthing guides ([2a1b799](https://github.com/mdopp/servicebay/commit/2a1b799e011237c9a02999eb9d0ed7a8b30bf2a9))
* **settings:** resolve saved-credential URLs to public subdomains + add Vaultwarden import button ([38867be](https://github.com/mdopp/servicebay/commit/38867bec03499b501fe28d4bf9cd1bb039b97d04)), closes [#1626](https://github.com/mdopp/servicebay/issues/1626) [#1627](https://github.com/mdopp/servicebay/issues/1627)

## [4.91.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.90.3...servicebay-v4.91.0) (2026-06-03)


### Features

* **backup-sync:** local/USB target as a detected-mount picker ([5d5c004](https://github.com/mdopp/servicebay/commit/5d5c0049bcf7f7f3163a1adaf8c7fcf06c8b2223)), closes [#1613](https://github.com/mdopp/servicebay/issues/1613)
* backup-target hardening, portal SSO + appless cards, claude-dev tmux ([87e9e87](https://github.com/mdopp/servicebay/commit/87e9e8776391a3c5a07c62506ba5fe19205532ad))
* **backup:** System Snapshot collects per-service config, retires nginx-only Service-Data ([1c68e6e](https://github.com/mdopp/servicebay/commit/1c68e6e9289aca5125432facf23ed4d461b31426)), closes [#1609](https://github.com/mdopp/servicebay/issues/1609)
* **claude-dev:** persistent tmux session that survives disconnects ([dab8528](https://github.com/mdopp/servicebay/commit/dab8528e533e4403564f261ff73cbe7260f779e3)), closes [#1616](https://github.com/mdopp/servicebay/issues/1616)
* **portal:** appless cards + action links for URL-less services ([42dc477](https://github.com/mdopp/servicebay/commit/42dc47780e8f366ae17bcdc180824a39f1060f86)), closes [#1618](https://github.com/mdopp/servicebay/issues/1618)
* **terminal:** deep-link web terminal into a container and attach to a named session ([3fab72b](https://github.com/mdopp/servicebay/commit/3fab72bb0a77415df0201c6e2d03bf55ed58c905)), closes [#1617](https://github.com/mdopp/servicebay/issues/1617)


### Bug Fixes

* backup HA-OS import, proxy-host cert re-patch, snapshot config collector, terminal deep-link ([7bbc2b0](https://github.com/mdopp/servicebay/commit/7bbc2b07c68992e8467aad6527092149d0e2a619))
* **backup-mounts:** handle integer byte sizes from lsblk -b ([946e2f9](https://github.com/mdopp/servicebay/commit/946e2f912f452d0e79fce34312e3f7af594d971a))
* **backup-mounts:** update maybeHuman signature for number | null inputs ([0f42703](https://github.com/mdopp/servicebay/commit/0f42703e2368aa15cb40d1a0ff1cb4de34630523))
* **backup:** HA-OS import skips dir members in tar extraction ([307dac0](https://github.com/mdopp/servicebay/commit/307dac0df53b17c3174184f7ce36a176e2a4de0b)), closes [#1620](https://github.com/mdopp/servicebay/issues/1620)
* **backup:** validate Local target on Run like Test — no silent mkdir onto OS disk ([6b22dd2](https://github.com/mdopp/servicebay/commit/6b22dd2c459cae0e43f592952ba2129db97a3162)), closes [#1612](https://github.com/mdopp/servicebay/issues/1612)
* **portal:** recognize signed-in SSO user + link admin dashboard ([07198a6](https://github.com/mdopp/servicebay/commit/07198a66756798056bddaebf3d3834063bb7402b)), closes [#1606](https://github.com/mdopp/servicebay/issues/1606)
* **proxy-hosts:** re-apply forward-auth conf patch after cert-bind ([f5d6911](https://github.com/mdopp/servicebay/commit/f5d6911da72cb60187c7d83ee54694c22aafaf1e)), closes [#1623](https://github.com/mdopp/servicebay/issues/1623)

## [4.90.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.90.2...servicebay-v4.90.3) (2026-06-03)


### Bug Fixes

* **externalBackup:** drop Supervisor-only HA config entries on import ([5907ef4](https://github.com/mdopp/servicebay/commit/5907ef4b08faed1fc30eb4f431e2f669d686abac)), closes [#1601](https://github.com/mdopp/servicebay/issues/1601)
* **externalBackup:** route restore + wipe through host agent ([#1600](https://github.com/mdopp/servicebay/issues/1600)) ([5ba9c4f](https://github.com/mdopp/servicebay/commit/5ba9c4f662bee8f3e72996ad52f41a1bd6aae28f))
* **externalBackup:** route restore/wipe through host agent + drop HA-OS Supervisor entries ([7923e37](https://github.com/mdopp/servicebay/commit/7923e37af06b37f6f191bf0e81b7d803d70185ac))

## [4.90.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.90.1...servicebay-v4.90.2) (2026-06-03)


### Bug Fixes

* **externalBackup:** glob lovelace dashboards + back up HACS in the HA manifest ([7c5d434](https://github.com/mdopp/servicebay/commit/7c5d4341f90589a73aa4403ccf191bcb18a8cbc3)), closes [#1596](https://github.com/mdopp/servicebay/issues/1596)
* **externalBackup:** route the config-survival producer through the host agent ([eea92ae](https://github.com/mdopp/servicebay/commit/eea92ae3a171d77cdfcefdae54c665f3f923da06)), closes [#1597](https://github.com/mdopp/servicebay/issues/1597)
* **externalBackup:** translate HA add-on config entries for the container deploy ([93850f8](https://github.com/mdopp/servicebay/commit/93850f8f52ac8919284c3130537a8122836b63c1)), closes [#1595](https://github.com/mdopp/servicebay/issues/1595)
* HA config-survival, OIDC secret reconcile, backup host-agent routing, knip rework ([6f97a83](https://github.com/mdopp/servicebay/commit/6f97a831c4f249f7f892b7d54b2d3377fc569053))
* **home-assistant:** auto-configure Z-Wave serial port, disable soft-reset, back up the key store ([9cd5b83](https://github.com/mdopp/servicebay/commit/9cd5b8390729c6aca6304cb23cd3d5af736d113f)), closes [#1594](https://github.com/mdopp/servicebay/issues/1594)
* **immich:** reconcile OIDC client secret in DB on wipe-configs reinstall ([93d6b9b](https://github.com/mdopp/servicebay/commit/93d6b9b03203f9c0c79a141072d9732182ded32b)), closes [#1556](https://github.com/mdopp/servicebay/issues/1556)
* **sb-tui:** sync Go HA backup includes with the TS manifest ([7d0a754](https://github.com/mdopp/servicebay/commit/7d0a75468f115979034b1849e6ac90709b29d428)), closes [#1596](https://github.com/mdopp/servicebay/issues/1596) [#1595](https://github.com/mdopp/servicebay/issues/1595)

## [4.90.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.90.0...servicebay-v4.90.1) (2026-06-02)


### Bug Fixes

* **diagnose:** scope sso_verify probes to installed services ([bd3af4e](https://github.com/mdopp/servicebay/commit/bd3af4e4a7a48b3b48ccab51435faf9964efd061))
* **diagnose:** scope sso_verify probes to installed services ([78636f7](https://github.com/mdopp/servicebay/commit/78636f751f3987c560b270beaf01a90176b70157)), closes [#1591](https://github.com/mdopp/servicebay/issues/1591)

## [4.90.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.89.0...servicebay-v4.90.0) (2026-06-02)


### Features

* **install:** per-service config/data split + wipe-mode model ([244a3e8](https://github.com/mdopp/servicebay/commit/244a3e8d310a6cd6b13b12c0cdd79a5ab874dc94))
* **install:** per-service config/data split + wipe-mode model ([0da637a](https://github.com/mdopp/servicebay/commit/0da637a32da3ccf794b48023fc0a36a45f8d5b2c)), closes [#1585](https://github.com/mdopp/servicebay/issues/1585)

## [4.89.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.88.1...servicebay-v4.89.0) (2026-06-02)


### Features

* **reverseProxy:** branded proxy error pages for unknown subdomain and bare 401/502 ([cd35130](https://github.com/mdopp/servicebay/commit/cd35130a2ed1e81ca2bc7cae4ef5fe46ccf5c86c)), closes [#1583](https://github.com/mdopp/servicebay/issues/1583)


### Bug Fixes

* **externalBackup:** decouple NAS auto-restore from retired cleanInstall flag ([1bcbbc0](https://github.com/mdopp/servicebay/commit/1bcbbc043a0218de92f5e6e0c52619c95b59b4b7)), closes [#1584](https://github.com/mdopp/servicebay/issues/1584)
* NAS auto-restore decoupled from cleanInstall + branded proxy error pages ([d9977a0](https://github.com/mdopp/servicebay/commit/d9977a01b857134800d477b908b2be013fb8c3c4))
* **util:** replace unreachable return with default case in humanizeDomainError ([c9712d0](https://github.com/mdopp/servicebay/commit/c9712d08c388f9e8858b68f506729959d4a90fbe))

## [4.88.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.88.0...servicebay-v4.88.1) (2026-06-02)


### Bug Fixes

* **frontend:** upgrade lucide-react to 1.x and reconcile icon imports ([e29e008](https://github.com/mdopp/servicebay/commit/e29e00802ee66147a575c628b6fc8a8066b400f5))
* **frontend:** upgrade lucide-react to 1.x and reconcile icon imports ([04a62f5](https://github.com/mdopp/servicebay/commit/04a62f58f44777ecab4314d678d01211529a5b23)), closes [#1578](https://github.com/mdopp/servicebay/issues/1578) [#1576](https://github.com/mdopp/servicebay/issues/1576)

## [4.88.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.87.0...servicebay-v4.88.0) (2026-06-02)


### Features

* **backup:** operator-configurable source list + per-source excludes for Backup Sync ([e1f50d4](https://github.com/mdopp/servicebay/commit/e1f50d4ef4186b17a71523050fcbb6ce5b40b098)), closes [#1554](https://github.com/mdopp/servicebay/issues/1554)
* **portal:** recommend BasicSync with an install QR for file-share sync ([70b0c53](https://github.com/mdopp/servicebay/commit/70b0c531442a1d045f647d2ac7993767ae31843b)), closes [#1560](https://github.com/mdopp/servicebay/issues/1560)
* wipe-configs UX, BasicSync portal, domain-check collapse, backup-sync sources ([7417cc7](https://github.com/mdopp/servicebay/commit/7417cc773d5fe8b7991ec1e4c795236514426448))


### Bug Fixes

* **ux:** make wipe-configs / restore data lifecycle unmistakable ([f48d468](https://github.com/mdopp/servicebay/commit/f48d4684d1b5daa52f4165d16b49588ee02b4f2f)), closes [#1558](https://github.com/mdopp/servicebay/issues/1558)

## [4.87.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.86.1...servicebay-v4.87.0) (2026-06-02)


### Features

* **diagnose:** add domain_resolves_to_box blocking DNS-resolution probe ([9a80982](https://github.com/mdopp/servicebay/commit/9a80982267d96ad12d18773637654f1f15ecde8d)), closes [#1563](https://github.com/mdopp/servicebay/issues/1563)


### Bug Fixes

* **health:** prune lingering checks for un-installed services ([f0832d8](https://github.com/mdopp/servicebay/commit/f0832d89150d08b3f6f7343d559ff804da19e472)), closes [#1551](https://github.com/mdopp/servicebay/issues/1551)
* portal/diagnose UI, health-check hygiene, DNS probe, sb-tui nav + CI security hardening ([f1bad6b](https://github.com/mdopp/servicebay/commit/f1bad6b5e03265df982438025a6422348381760d))
* **portal:** pin HA card to HA_SUBDOMAIN; add diagnose history opener ([d4af2a2](https://github.com/mdopp/servicebay/commit/d4af2a24c713fca23a9be15512988eaeed896784)), closes [#1562](https://github.com/mdopp/servicebay/issues/1562) [#1553](https://github.com/mdopp/servicebay/issues/1553)
* **sb:** advance to post-install menu after standalone watch completes ([7649330](https://github.com/mdopp/servicebay/commit/76493306d7a4be06917f2d1cc4c8478ab2b1eac6)), closes [#1555](https://github.com/mdopp/servicebay/issues/1555)

## [4.86.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.86.0...servicebay-v4.86.1) (2026-06-02)


### Bug Fixes

* **fe-lint:** fix tsc type errors in useInstallPlan.test.ts mock.calls ([cd3fd82](https://github.com/mdopp/servicebay/commit/cd3fd82c4c995b4d80a5ae0b99805ed2a398daa4))
* **fe-lint:** fix TypeScript build errors from lint-sweep extractions ([b96840e](https://github.com/mdopp/servicebay/commit/b96840ea2d096f72a9aef72def11b68627b9e675))
* **hooks:** remove unused variables in useInstallPlan.test.ts ([39875cf](https://github.com/mdopp/servicebay/commit/39875cf46ba093fa82a29d364a2732e88b0c0b37))

## [4.86.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.85.0...servicebay-v4.86.0) (2026-06-02)


### Features

* **diagnose,installer:** typed probe shape + persisted history + desired-state wizard ([ddd5c37](https://github.com/mdopp/servicebay/commit/ddd5c3726e3037047f04b6d067172364119d3e86))
* **diagnose:** persist every on-demand probe result to HealthStore ([1868f8d](https://github.com/mdopp/servicebay/commit/1868f8d8eb274e77cad19c75611fe4c4c46eefb2)), closes [#1540](https://github.com/mdopp/servicebay/issues/1540)
* **diagnose:** uniform first-seen/last-ok/trend history per probe row ([3d868ce](https://github.com/mdopp/servicebay/commit/3d868ce0d1265766978dffcdad87a0de4aadf3c6)), closes [#1541](https://github.com/mdopp/servicebay/issues/1541)
* **installer:** wizard stack picker as desired-state editor via /install/plan ([d29cbdb](https://github.com/mdopp/servicebay/commit/d29cbdbd722b58d2b005d4768e30a9078588cef8)), closes [#1537](https://github.com/mdopp/servicebay/issues/1537)

## [4.85.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.84.0...servicebay-v4.85.0) (2026-06-02)


### Features

* **diagnose:** regroup probe rows into problem-domain cards ([16ba662](https://github.com/mdopp/servicebay/commit/16ba662594032a002caa77f7bb98e2c2523b68a9)), closes [#1534](https://github.com/mdopp/servicebay/issues/1534)
* **externalBackup:** configurable backup destination + FritzBox NAS creds in the UI ([e3e871b](https://github.com/mdopp/servicebay/commit/e3e871be8239e5bc40762536f5515d04665dba6d)), closes [#1525](https://github.com/mdopp/servicebay/issues/1525) [#1527](https://github.com/mdopp/servicebay/issues/1527)
* **externalBackup:** NPM as first-class backup manifest + post-restore credential reconcile ([6e69785](https://github.com/mdopp/servicebay/commit/6e69785cc8569b4779bdfdf1a79d6e7f3bb7f049)), closes [#1528](https://github.com/mdopp/servicebay/issues/1528) [#1529](https://github.com/mdopp/servicebay/issues/1529)
* FritzBox/NPM backup config + NPM credential cleanup + diagnose consolidation & regroup ([221e8ba](https://github.com/mdopp/servicebay/commit/221e8bac637b649da472f03c344926631d16ce8c))
* **reverseProxy:** derive NPM admin credential from DB, drop free-text field ([05f076c](https://github.com/mdopp/servicebay/commit/05f076c2b5f795b68b5a75eb282e30fc941ab75d)), closes [#1530](https://github.com/mdopp/servicebay/issues/1530)

## [4.84.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.83.1...servicebay-v4.84.0) (2026-06-02)


### Features

* **backups:** collapse System Backups list to newest 5 with show-all toggle ([#1531](https://github.com/mdopp/servicebay/issues/1531)) ([ba8b84a](https://github.com/mdopp/servicebay/commit/ba8b84a77b43bdd00d5a4738008eae45437d8450))

## [4.83.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.83.0...servicebay-v4.83.1) (2026-06-02)


### Bug Fixes

* **externalBackup:** cd-then-list for FritzBox FTP (empty NAS backup list broke reinstall auto-restore) ([82cc2b5](https://github.com/mdopp/servicebay/commit/82cc2b57faf5e984d5041f57d1dcde975cf4db75))
* **externalBackup:** FritzBox FTP ignores LIST &lt;path&gt; — cd then bare list() ([31282de](https://github.com/mdopp/servicebay/commit/31282de4b28286ae33a03ac3baa787d5bb602829))

## [4.83.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.82.0...servicebay-v4.83.0) (2026-06-02)


### Features

* **install:** drop clean-install from the wizard; reinstall = redeploy-over-data ([#1520](https://github.com/mdopp/servicebay/issues/1520)) ([f211ec0](https://github.com/mdopp/servicebay/commit/f211ec0ce50c51eeccb1102ffd6372fedc916fb2))
* **install:** server-side /api/install/plan — single source for the desired-state diff ([#1520](https://github.com/mdopp/servicebay/issues/1520)) ([7ecbf89](https://github.com/mdopp/servicebay/commit/7ecbf899fe6b7e730b5bede4ebaf74bf26275e1e))
* **install:** single-source /api/install/plan + drop clean-install from the wizard ([#1520](https://github.com/mdopp/servicebay/issues/1520)) ([1554d84](https://github.com/mdopp/servicebay/commit/1554d8496d29846381ec5bc56ce784d6c251b92c))
* **sb:** add a non-interactive, scriptable CLI for box control ([568ef4f](https://github.com/mdopp/servicebay/commit/568ef4fe4d033705e78ab76271f056aa277bbce5))
* **sb:** make all four journey phases headers with nested actions ([3fce8c6](https://github.com/mdopp/servicebay/commit/3fce8c69592e178d3816458f4a5c65125cfb066b))
* **sb:** rename sb-tui → sb + add a scriptable CLI + consistent menu ([2ef26dd](https://github.com/mdopp/servicebay/commit/2ef26dd1a2f5d2a2f9f8b3a373d4651fa7f70856))


### Bug Fixes

* **agent:** give the cold-boot reconnect refresh a 90s timeout ([b4d5733](https://github.com/mdopp/servicebay/commit/b4d5733ad8b938453ff11189ceeae8f3f6fb1e33))
* **fritzbox:** stop the GetInfo DNS probe spamming a SOAP 500 warning every poll ([4847106](https://github.com/mdopp/servicebay/commit/48471069473a3f45b54cae4ee0bab9681c21f8e7))
* **media:** update portal user-guide from Navidrome to Jellyfin ([8c7d69b](https://github.com/mdopp/servicebay/commit/8c7d69b6ea0d615508b05e77f5fce29a9ad12745))
* quiet recurring log noise (FritzBox DNS, cold-boot refresh) + portal Jellyfin card ([959b574](https://github.com/mdopp/servicebay/commit/959b57484039d6c65f00a5f5ce8d55389b819c4d))

## [4.82.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.81.0...servicebay-v4.82.0) (2026-06-02)


### Features

* **file-share:** provision shared-gid + setgid + default ACL on notes vault ([39ca35a](https://github.com/mdopp/servicebay/commit/39ca35afe61b80c4a4fa98d75ce9cffac50744aa))
* **file-share:** shared-gid + setgid + default ACL on the notes vault ([4f885c8](https://github.com/mdopp/servicebay/commit/4f885c89392b53472067295d247c7e48278b2d09))

## [4.81.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.80.2...servicebay-v4.81.0) (2026-06-02)


### Features

* **access-requests:** skip doomed admin approval for an already-registered email ([830cfd7](https://github.com/mdopp/servicebay/commit/830cfd73a82beade08bfd956958e8019fa03a649)), closes [#1510](https://github.com/mdopp/servicebay/issues/1510)
* **install:** move rootless podman image store to /mnt/data RAID ([09ae040](https://github.com/mdopp/servicebay/commit/09ae040a24395e562973247f566896ad78e690dc)), closes [#1494](https://github.com/mdopp/servicebay/issues/1494)
* **install:** persist image store on RAID and skip doomed access-request approvals ([bd28b25](https://github.com/mdopp/servicebay/commit/bd28b25263698c5647a42e3fcfae61dd9f72b079))

## [4.80.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.80.1...servicebay-v4.80.2) (2026-06-02)


### Bug Fixes

* **dashboard:** reconcile socket connect, offline banner + drop redundant setup rider ([94da39e](https://github.com/mdopp/servicebay/commit/94da39e50a87d7a1984a30768c539e95b70a7ba1)), closes [#1503](https://github.com/mdopp/servicebay/issues/1503) [#1504](https://github.com/mdopp/servicebay/issues/1504) [#1509](https://github.com/mdopp/servicebay/issues/1509)
* **health:** gate per-service checks on actual deployment ([28e9152](https://github.com/mdopp/servicebay/commit/28e91525e9a17ea9178d68b3cb07641cfc45df0e)), closes [#1506](https://github.com/mdopp/servicebay/issues/1506)
* **home-assistant:** reconcile HA token, Z-Wave device + integrations after a wipe-configs reinstall ([69b0774](https://github.com/mdopp/servicebay/commit/69b0774a774ebb876f16aa44dc81101a8ea54cd6)), closes [#1505](https://github.com/mdopp/servicebay/issues/1505) [#1511](https://github.com/mdopp/servicebay/issues/1511) [#1512](https://github.com/mdopp/servicebay/issues/1512)
* reconcile install/dashboard/health/tui state after wipe-configs reinstall ([407de7a](https://github.com/mdopp/servicebay/commit/407de7a193d5db7c48eb72e00db8b98767ea0030))
* **sb-tui:** re-auth on a rejected token instead of dead-ending ([f771bbb](https://github.com/mdopp/servicebay/commit/f771bbbd201ca2621f84aafdd559ddf694910054)), closes [#1502](https://github.com/mdopp/servicebay/issues/1502)

## [4.80.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.80.0...servicebay-v4.80.1) (2026-06-01)


### Bug Fixes

* **health:** color failing history-chart bars red, not dark-green ([#1507](https://github.com/mdopp/servicebay/issues/1507)) ([2116a58](https://github.com/mdopp/servicebay/commit/2116a583cf3f4a799bc9f9a1774e588ad1296107))
* **health:** color failing history-chart bars red, not dark-green ([#1507](https://github.com/mdopp/servicebay/issues/1507)) ([30b1428](https://github.com/mdopp/servicebay/commit/30b1428a154178254ab7003ad817ffafe8c1034a))
* **tui:** nest the NAS-upload backup picker under the path field ([7e91cee](https://github.com/mdopp/servicebay/commit/7e91ceeef64b6ec0c46adcdddbeda174483b8906))
* **tui:** nest the NAS-upload backup picker under the path field ([bb2cce1](https://github.com/mdopp/servicebay/commit/bb2cce1f390d8fa01236df072b88a9ca1b36edff))

## [4.80.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.79.0...servicebay-v4.80.0) (2026-06-01)


### Features

* **backup:** auto-restore service config from NAS on reinstall ([#1218](https://github.com/mdopp/servicebay/issues/1218) entry 1) ([d438737](https://github.com/mdopp/servicebay/commit/d438737a902fff66394f01ff6bb412a1b2300955))
* **backup:** onboarding orphan-backup hint ([#1218](https://github.com/mdopp/servicebay/issues/1218) entry 2) ([388daa2](https://github.com/mdopp/servicebay/commit/388daa2b296ac96b6acdb650e05e9a9832925dae))
* **backup:** onboarding orphan-backup hint ([#1218](https://github.com/mdopp/servicebay/issues/1218) entry 2) ([802f5cd](https://github.com/mdopp/servicebay/commit/802f5cdb491246f098a03db810cc8dea1610ef22))
* **install:** factory-reset image-wipe level ([#1495](https://github.com/mdopp/servicebay/issues/1495)) ([a9535bd](https://github.com/mdopp/servicebay/commit/a9535bd6e38b56d307cbea48c4695e5ca5ec02e8))
* **install:** factory-reset image-wipe level ([#1495](https://github.com/mdopp/servicebay/issues/1495)) ([dddf000](https://github.com/mdopp/servicebay/commit/dddf000eeb577873317b570d287021b4ad858a4a))
* **tui,install:** factory-fresh install toggle ([#1496](https://github.com/mdopp/servicebay/issues/1496)) ([523fda2](https://github.com/mdopp/servicebay/commit/523fda2931d7a97733a09278b452bd234b916fd2))
* **tui,install:** factory-fresh install toggle in the build form ([#1496](https://github.com/mdopp/servicebay/issues/1496)) ([970159c](https://github.com/mdopp/servicebay/commit/970159cc55adcfd49f44b2f1b8207d5249d4dd52))
* **tui:** chain post-boot sign-in + restore + install into Express ([#1233](https://github.com/mdopp/servicebay/issues/1233)) ([f85654e](https://github.com/mdopp/servicebay/commit/f85654e1cacec32c7344ded78e7303da9a2a7c5d))
* **tui:** chain post-boot sign-in + restore + install into Express ([#1233](https://github.com/mdopp/servicebay/issues/1233)) ([2a80a4e](https://github.com/mdopp/servicebay/commit/2a80a4e575f9e1619a3db69eefa53b83b83fcafc))


### Bug Fixes

* **install:** apply variables.json defaults on reinstall for newly-added vars ([50daef5](https://github.com/mdopp/servicebay/commit/50daef555d85fb6a84478c636ca40b6872a8a4dc))
* **install:** apply variables.json defaults on reinstall for newly-added vars ([79d608b](https://github.com/mdopp/servicebay/commit/79d608b424e1e64ee8e55d69c415e76c14b89d1a))

## [4.79.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.78.0...servicebay-v4.79.0) (2026-06-01)


### Features

* **install:** render post-deploy progress as a user-facing bar ([9221d10](https://github.com/mdopp/servicebay/commit/9221d10c5827bd4bc442efde56f7ecb01d14303a)), closes [#1288](https://github.com/mdopp/servicebay/issues/1288)
* **portal:** surface a manual-action card for interactive Signal pairing ([8e41508](https://github.com/mdopp/servicebay/commit/8e4150863c35e16d69f8fde8d3c1ac698f87a0be)), closes [#1253](https://github.com/mdopp/servicebay/issues/1253)
* post-deploy progress bar consumer and Signal-pairing portal card ([96432a5](https://github.com/mdopp/servicebay/commit/96432a59988aea9c46d1004c1ccf74f839a4aa2e))


### Bug Fixes

* **tests:** e2e login helper targets placeholder + gitignore playwright artifacts ([e9b7629](https://github.com/mdopp/servicebay/commit/e9b762927f3adb7e2e0c81946286a2e84bba9d11))

## [4.78.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.77.0...servicebay-v4.78.0) (2026-06-01)


### Features

* LAN-only 403 explainer, Settings IA reshape, browser-verify harness ([72421fb](https://github.com/mdopp/servicebay/commit/72421fbc5dbd30f18c5fba1e4c6943726abb0dee))
* **reverseProxy:** branded LAN-only 403 explainer page ([#1415](https://github.com/mdopp/servicebay/issues/1415)) ([c38367b](https://github.com/mdopp/servicebay/commit/c38367b346c05209f1861e27810a115fd4898b4b))
* **settings:** reshape Settings into concern-based tabs per decided IA ([c94d222](https://github.com/mdopp/servicebay/commit/c94d222fa6ab6b2ac9ade0596a50f39aacb55f32)), closes [#1427](https://github.com/mdopp/servicebay/issues/1427)
* **tests:** headless Playwright browser-verify harness for autoloop Box-Verify ([9172232](https://github.com/mdopp/servicebay/commit/91722322aa6c813456112a8ef6b5dc78b2711746)), closes [#1473](https://github.com/mdopp/servicebay/issues/1473)


### Bug Fixes

* **autoloop:** epics stay blocked until children close, never reclassify out ([342a81b](https://github.com/mdopp/servicebay/commit/342a81bcafb1b3ea906678d85903e38a22e64a1f))
* **autoloop:** epics stay blocked until children close, never reclassify out ([d842b2a](https://github.com/mdopp/servicebay/commit/d842b2a592f37a9780ae6f6b8e10a57daa556719))
* **backend:** widen node-twin param types in extracted lint-sweep helpers ([871699f](https://github.com/mdopp/servicebay/commit/871699f91357a134666c3a4bba0c8ef46ad171f1))

## [4.77.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.76.0...servicebay-v4.77.0) (2026-06-01)


### Features

* **autoloop:** structured blocked_by + every-run two-tier unblock recheck ([2b51b93](https://github.com/mdopp/servicebay/commit/2b51b93320d4ca9db3cbccec376735cade0bfffc))
* **autoloop:** structured blocked_by + every-run two-tier unblock recheck ([8a33485](https://github.com/mdopp/servicebay/commit/8a33485ac70aee2254d2c6186900d29f0ea55ed6))


### Bug Fixes

* **test:** exclude *-worktree/ dirs from vitest discovery ([7a5d117](https://github.com/mdopp/servicebay/commit/7a5d117f81cfba06fd6a17338195dcf83332e39c)), closes [#1476](https://github.com/mdopp/servicebay/issues/1476)

## [4.76.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.75.0...servicebay-v4.76.0) (2026-06-01)


### Features

* **autoloop:** mirror blocked / needs-refinement / box_verify to GitHub labels ([d4ed323](https://github.com/mdopp/servicebay/commit/d4ed323444a10ae5e94bfd9f2eca2f877b26a250))
* **autoloop:** mirror blocked / needs-refinement / box_verify to GitHub labels ([bc02208](https://github.com/mdopp/servicebay/commit/bc022089a941d81a402bb0afdce03adcd32bab15))
* **backup:** nightly + on-demand triggers for FritzBox NAS config backup ([3ee5ebd](https://github.com/mdopp/servicebay/commit/3ee5ebde683825331af2a74e97534906af8e6abf)), closes [#1217](https://github.com/mdopp/servicebay/issues/1217)
* install secret regen, PUBLIC_DOMAIN prefill, nightly NAS backup + lint sweeps ([a1ad9ed](https://github.com/mdopp/servicebay/commit/a1ad9ed20608050c2c07f76d6055c909b8460093))


### Bug Fixes

* **health:** extract helpers to clear lint warnings ([f20cb0c](https://github.com/mdopp/servicebay/commit/f20cb0c19d49ea5b9efa564f894049f42e51faf6))
* **install:** pre-fill PUBLIC_DOMAIN from reverseProxy.publicDomain + add help text ([fb3753f](https://github.com/mdopp/servicebay/commit/fb3753fa1cd161c1b96229be2ff8ab211f65b2e7)), closes [#1252](https://github.com/mdopp/servicebay/issues/1252)
* **install:** regenerate secret.key + .auth-secret.env after stack reset wipe ([333c28e](https://github.com/mdopp/servicebay/commit/333c28eecb0231645936a828c7dd3f906bf48b7b)), closes [#1246](https://github.com/mdopp/servicebay/issues/1246)

## [4.75.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.74.0...servicebay-v4.75.0) (2026-06-01)


### Features

* **diagnose:** auto-run SSO verify post-install + surface it as a probe ([54879a9](https://github.com/mdopp/servicebay/commit/54879a93c1a7bddd0c9b4164239451f8254bf6a1)), closes [#1454](https://github.com/mdopp/servicebay/issues/1454) [#1455](https://github.com/mdopp/servicebay/issues/1455)
* **health:** auto-run SSO verify post-install, self-repair popup and 4-way counters ([66784c9](https://github.com/mdopp/servicebay/commit/66784c98169e058ccff894b847b2fb3a3369f266))
* **health:** self-repair popup + four-way counters, drop Self-Diagnose tab ([1ac2f13](https://github.com/mdopp/servicebay/commit/1ac2f1328947df1f806f09e5ae1db526667e93ba)), closes [#1423](https://github.com/mdopp/servicebay/issues/1423)

## [4.74.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.73.0...servicebay-v4.74.0) (2026-06-01)


### Features

* **autoloop:** run Box-Verify async in background, let builder build-ahead ([22bc1f8](https://github.com/mdopp/servicebay/commit/22bc1f82b9157063cbf0751c09ff859fa1fb4643))

## [4.73.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.72.0...servicebay-v4.73.0) (2026-06-01)


### Features

* **diagnose:** fold self-diagnose probes into Checks list, scheduled daily ([4a84e96](https://github.com/mdopp/servicebay/commit/4a84e960a8760caf57ac25677183baa0c2e05dc2)), closes [#1423](https://github.com/mdopp/servicebay/issues/1423)
* **diagnose:** in-process ephemeral-user SSO verification module ([229e87f](https://github.com/mdopp/servicebay/commit/229e87f69c2fefd3e4d734eabbb17765c457eb0e)), closes [#1453](https://github.com/mdopp/servicebay/issues/1453)
* **external-backup:** register FritzBox NAS as a backup source + surface NAS backups in Settings ([08d9f0a](https://github.com/mdopp/servicebay/commit/08d9f0aca3737a21f88450e144893ee54c2339fa)), closes [#1440](https://github.com/mdopp/servicebay/issues/1440)
* **portal:** settings UI for max-users limit + LAN-only portal toggle ([6c2de2a](https://github.com/mdopp/servicebay/commit/6c2de2ae797b18fde10f31c1ebedc75a540b1171)), closes [#1456](https://github.com/mdopp/servicebay/issues/1456)
* SSO verify, Home polish, portal cap/LAN-gate, NAS backup UI, admin-hash reconcile, diagnose-fold slice ([df6c941](https://github.com/mdopp/servicebay/commit/df6c941cf5f6bbde759d003e49b13c4e3076646e))


### Bug Fixes

* **auth:** reconcile stored admin hash with new SERVICEBAY_PASSWORD on reinstall ([f0be08e](https://github.com/mdopp/servicebay/commit/f0be08ecb13987ee1665c475ebb28870db1ce407)), closes [#1438](https://github.com/mdopp/servicebay/issues/1438)
* **dashboards:** align Home cards and health banner with app palette ([cf1b53a](https://github.com/mdopp/servicebay/commit/cf1b53abf0648b165ba24dc8dc44ee6b71a2edba)), closes [#1420](https://github.com/mdopp/servicebay/issues/1420)

## [4.72.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.71.0...servicebay-v4.72.0) (2026-06-01)


### Features

* **mcp:** get_channel / set_channel tools for autonomous :dev verify ([30a2817](https://github.com/mdopp/servicebay/commit/30a2817890396b4491d27b6f45886a88c48eee53))
* **mcp:** get_channel / set_channel tools for autonomous :dev verify ([fdfbfdb](https://github.com/mdopp/servicebay/commit/fdfbfdb95f6a907cc64cbcb47f2ec814f999b262))

## [4.71.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.70.0...servicebay-v4.71.0) (2026-06-01)


### Features

* **mcp:** re-activate the bootstrap token from Settings ([87f774c](https://github.com/mdopp/servicebay/commit/87f774c41ec99d9878c0906eba088c1f6587a963))
* **portal:** cap user access requests at a configurable max-users limit ([22b63ab](https://github.com/mdopp/servicebay/commit/22b63ab5b6008e7502d635ef2b6623725ce942d5))


### Bug Fixes

* **install:** self-heal an empty/diverged NPM admin password before provisioning ([40b86d3](https://github.com/mdopp/servicebay/commit/40b86d3dbd86b07d86e83ecbc2020e3f03cd4d71))
* **network-map:** group ports by host so multi-IP cards don't balloon ([894573b](https://github.com/mdopp/servicebay/commit/894573bf0b355948fe693f2066138781bc66e190))
* **sidebar:** drop the duplicated username from the account widget ([11b9eb6](https://github.com/mdopp/servicebay/commit/11b9eb6e4007c2f7c61f3704e829959b4125ef09))

## [4.70.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.69.3...servicebay-v4.70.0) (2026-06-01)


### Features

* **settings:** re-download the credentials CSV from Saved credentials ([e9fba8d](https://github.com/mdopp/servicebay/commit/e9fba8dd00c3084deb97ce55424394ee7e5236fe))
* **settings:** re-download the credentials CSV from Saved credentials ([9055ebc](https://github.com/mdopp/servicebay/commit/9055ebcaf534bd00dc47dc1f124996d1047ad427))

## [4.69.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.69.2...servicebay-v4.69.3) (2026-06-01)


### Bug Fixes

* **install:** warn when a pod-YAML variable renders empty ([15e300c](https://github.com/mdopp/servicebay/commit/15e300c52f053fb760dd3c204ff1051d6bc8ebbd))
* **install:** warn when a pod-YAML variable renders empty ([e4c57b8](https://github.com/mdopp/servicebay/commit/e4c57b8fa3f58ca2c9771fc3b06ad2f165d24d79))

## [4.69.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.69.1...servicebay-v4.69.2) (2026-06-01)


### Bug Fixes

* **health:** register domain checks from the live NPM route table ([9bfd06b](https://github.com/mdopp/servicebay/commit/9bfd06bff34bf64c76296c145df4b45af5e0817d))
* **health:** register domain checks from the live NPM route table ([912f4e9](https://github.com/mdopp/servicebay/commit/912f4e90090bc3a79b836a3dd3928955c094e245))

## [4.69.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.69.0...servicebay-v4.69.1) (2026-06-01)


### Bug Fixes

* **lldap:** map UNIQUE-constraint duplicate to a friendly outcome ([3896008](https://github.com/mdopp/servicebay/commit/38960088f6475aa14ceeb93f74a59f2bc91d5e9b))
* **lldap:** map UNIQUE-constraint duplicate to a friendly outcome ([f315fc1](https://github.com/mdopp/servicebay/commit/f315fc1e9e0d251eaef48d651844f9330c998354))

## [4.69.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.68.0...servicebay-v4.69.0) (2026-06-01)


### Features

* **autoloop:** batched dev-channel box verify, no more deferral ([93886b3](https://github.com/mdopp/servicebay/commit/93886b37774ea2957b3595cb914c73231e3462d9))
* **autoloop:** batched dev-channel box verify, no more deferral ([7635c34](https://github.com/mdopp/servicebay/commit/7635c34810ebdff25262efc7d1f944a756c24ddc))
* **autoloop:** groom and cluster the queue before selection ([430d801](https://github.com/mdopp/servicebay/commit/430d80124fcfd9b27f402f581870c65a7d4aea6c))
* **autoloop:** groom and cluster the queue before selection ([bee32a0](https://github.com/mdopp/servicebay/commit/bee32a084f1196d95184cf1d20b7ecf24a4b9787))
* **docs-coherence:** parallel agent to keep docs in sync as PRs land ([82310aa](https://github.com/mdopp/servicebay/commit/82310aa4161f2d6129a9306a03c02225ffb99a86))
* **docs-coherence:** parallel agent to keep docs in sync as PRs land ([4d1010e](https://github.com/mdopp/servicebay/commit/4d1010e68092ad66d24358ba288a4edaf471907e))

## [4.68.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.67.0...servicebay-v4.68.0) (2026-05-31)


### Features

* **tui:** channel switch in the interactive menu (not just the CLI) ([#1431](https://github.com/mdopp/servicebay/issues/1431)) ([fd44d75](https://github.com/mdopp/servicebay/commit/fd44d75497b98a34860ef8e1dec87c14860c5d62))

## [4.67.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.66.1...servicebay-v4.67.0) (2026-05-31)


### Features

* **tui:** channel switch — flip the running box to dev/latest/test ([#1417](https://github.com/mdopp/servicebay/issues/1417)) ([1511984](https://github.com/mdopp/servicebay/commit/15119843b70135ae7f3da443d3d379ac79b599f6))

## [4.66.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.66.0...servicebay-v4.66.1) (2026-05-31)


### Bug Fixes

* two bugs surfaced by on-box 4.66.0 verification ([#1413](https://github.com/mdopp/servicebay/issues/1413)) ([8ff3360](https://github.com/mdopp/servicebay/commit/8ff33603547652d418bc0bc18a8e44fe6b16b1c9))

## [4.66.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.65.0...servicebay-v4.66.0) (2026-05-31)


### Features

* **tui:** desired-state stack panel — install / reinstall / uninstall ([#1411](https://github.com/mdopp/servicebay/issues/1411)) ([09141d1](https://github.com/mdopp/servicebay/commit/09141d120c0f00e208031d49cf346c2827e3d1e9))

## [4.65.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.64.0...servicebay-v4.65.0) (2026-05-31)


### Features

* **install:** auto re-key NPM admin during install when creds are stale ([#1409](https://github.com/mdopp/servicebay/issues/1409)) ([88f5cf6](https://github.com/mdopp/servicebay/commit/88f5cf6a92f6c93f918191589e41d4d143f281d6))

## [4.64.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.63.4...servicebay-v4.64.0) (2026-05-31)


### Features

* **diagnose:** non-destructive NPM admin re-key (keep proxy routes) ([#1407](https://github.com/mdopp/servicebay/issues/1407)) ([2383c6a](https://github.com/mdopp/servicebay/commit/2383c6aaa2a21ef620f0c88f6ddbb734d36cb44e))

## [4.63.4](https://github.com/mdopp/servicebay/compare/servicebay-v4.63.3...servicebay-v4.63.4) (2026-05-31)


### Bug Fixes

* **install:** always re-key LLDAP admin on auth deploy (kill the crash-loop) ([#1405](https://github.com/mdopp/servicebay/issues/1405)) ([3dc3f68](https://github.com/mdopp/servicebay/commit/3dc3f68d8b107877af79ede1d0f2618ae10bedb4))

## [4.63.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.63.2...servicebay-v4.63.3) (2026-05-31)


### Bug Fixes

* **frontend:** make the Home health headline agree with the core-stack banner ([#1403](https://github.com/mdopp/servicebay/issues/1403)) ([0dac46b](https://github.com/mdopp/servicebay/commit/0dac46bcfe6126f547b2b7e2966af3f68ac94a27))

## [4.63.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.63.1...servicebay-v4.63.2) (2026-05-31)


### Bug Fixes

* **tui:** expand selected stacks into their templates before install ([#1401](https://github.com/mdopp/servicebay/issues/1401)) ([8e08b83](https://github.com/mdopp/servicebay/commit/8e08b832d2269768502f02f11e3a0190409e3eb1))

## [4.63.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.63.0...servicebay-v4.63.1) (2026-05-31)


### Bug Fixes

* **install:** provision portal routing after services settle; honest skip ([#1399](https://github.com/mdopp/servicebay/issues/1399)) ([c1c1721](https://github.com/mdopp/servicebay/commit/c1c1721196b4f1262ccf2a3ca2d1c353caf76b3d))

## [4.63.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.62.0...servicebay-v4.63.0) (2026-05-31)


### Features

* **frontend:** live install-progress card on the Home dashboard ([#1396](https://github.com/mdopp/servicebay/issues/1396)) ([48704d5](https://github.com/mdopp/servicebay/commit/48704d5dfd25679b674f5c9b4838a9852de12a96))
* **frontend:** move active domain into the sidebar near the user ([#1395](https://github.com/mdopp/servicebay/issues/1395)) ([3f57b74](https://github.com/mdopp/servicebay/commit/3f57b746e1f8612afa3e33e7722c46b4006ef753))


### Bug Fixes

* **install:** portal routing reports skipped, not failed, when AdGuard is absent ([#1397](https://github.com/mdopp/servicebay/issues/1397)) ([5aa232a](https://github.com/mdopp/servicebay/commit/5aa232af07d5e1499e6631d0e858850be46041f9))

## [4.62.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.61.0...servicebay-v4.62.0) (2026-05-31)


### Features

* **frontend:** red offline banner, drop the always-on "Live" indicator ([b7441b0](https://github.com/mdopp/servicebay/commit/b7441b0c888da366bd149a9ee163d5322e91469c))
* **frontend:** red offline banner; drop the always-on Live indicator ([3ebd0c1](https://github.com/mdopp/servicebay/commit/3ebd0c11368e5bd488c330d223fd69309c78ed00))
* **tui:** self-report build version ([5b09727](https://github.com/mdopp/servicebay/commit/5b09727ee8de334b01efc5934dc2abcec9188379))
* **tui:** self-report build version ([95ed171](https://github.com/mdopp/servicebay/commit/95ed171cd9699bbee18415d172c558c2b8aa107f))
* **tui:** surface and attach to a running install from the launcher ([d2deedf](https://github.com/mdopp/servicebay/commit/d2deedf4447f7307f805025fa3f97354de61bc87))
* **tui:** surface and attach to a running install from the launcher ([5f2caa1](https://github.com/mdopp/servicebay/commit/5f2caa128a2b6e3c188a72dfc398ac9a89d503d1))


### Bug Fixes

* **frontend:** only highlight Home on the exact root path ([551a3e3](https://github.com/mdopp/servicebay/commit/551a3e315cb4337441f19bac47e53ff57dc550b0))
* **frontend:** only highlight Home on the exact root path ([287fc9e](https://github.com/mdopp/servicebay/commit/287fc9e89f10a491bd01561cdb3e2dea00cc5b09))
* **tui:** clearer install monitor — connectivity badge and USB-boot steps ([93371bf](https://github.com/mdopp/servicebay/commit/93371bfd24669063148bce0abb8b0744138ae0a2))
* **tui:** clearer install monitor — connectivity badge and USB-boot steps ([0420dbf](https://github.com/mdopp/servicebay/commit/0420dbf2018996002440d18b9b04374a2d8b430b))
* **tui:** find backups in the build dir, robust path entry, boxed input fields ([7c500c1](https://github.com/mdopp/servicebay/commit/7c500c1b565e3f896a681edccf8a4bd318a12f19))
* **tui:** parse the install progress object so the monitor advances ([cf46842](https://github.com/mdopp/servicebay/commit/cf4684223b96970bd315838c2eeb0a419cc9a0a3))
* **tui:** parse the install progress object so the monitor advances ([717e7b9](https://github.com/mdopp/servicebay/commit/717e7b9e7257fa29064167bd24e59cbe87b7f330))
* **tui:** surface install progress errors and needs-credentials state ([f29984d](https://github.com/mdopp/servicebay/commit/f29984d896d86b84dd0e15c8995df284c26483e8))
* **tui:** surface install progress errors and needs-credentials state ([5cd7ba3](https://github.com/mdopp/servicebay/commit/5cd7ba31b0f321b02a0ab1dbdc663f9bc4287371))
* **tui:** upload panel finds build-dir backups, robust path entry, boxed fields ([975b461](https://github.com/mdopp/servicebay/commit/975b461dced811f052794ec590e93aa122a5a02d))

## [4.61.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.60.1...servicebay-v4.61.0) (2026-05-31)


### Features

* **tui:** backup-file picker for the NAS upload ([af32c6b](https://github.com/mdopp/servicebay/commit/af32c6bacebd0ade161fc7123d36f57c1965f0de))
* **tui:** direct-FTP backup upload + numbered setup-journey UX ([77afca7](https://github.com/mdopp/servicebay/commit/77afca72bd36d2ef9706dc45d9881a04acb99682))
* **tui:** numbered setup-journey menu plus ungated NAS upload and live install line ([b038b72](https://github.com/mdopp/servicebay/commit/b038b72ce7f7a5f8fd21c922da8749f6ed61b82f))
* **tui:** optional backup-staging step in Express ([725dae0](https://github.com/mdopp/servicebay/commit/725dae0f5b2bc9bd80df8f46145e47e19a4eec3d))
* **tui:** self-explaining menu labels + guided upload panel ([160c2e4](https://github.com/mdopp/servicebay/commit/160c2e4a883727c4026a740c8e563fd1fe1b8a1b))
* **tui:** upload a Home Assistant backup to the NAS via direct FTP ([a305823](https://github.com/mdopp/servicebay/commit/a3058239b02e4c7c78d6077ab64d54ccd4fdbee2))


### Bug Fixes

* **backup:** allow within-root symlinks so NPM cert backups can be created ([74bf5ef](https://github.com/mdopp/servicebay/commit/74bf5ef58d381c502f6f5148f8ec74dafec8f208))
* **backup:** allow within-root symlinks so NPM cert backups can be created ([1b2c00a](https://github.com/mdopp/servicebay/commit/1b2c00a36bbb321689d78afcdf2ba2d5bd46aa23)), closes [#1381](https://github.com/mdopp/servicebay/issues/1381)
* **boot:** sudo the reinstall reboot so it actually reboots ([467090a](https://github.com/mdopp/servicebay/commit/467090aa791f3c87362a98b7b35c7d3d37741f42))
* **boot:** sudo the reinstall reboot so it actually reboots ([ba613e2](https://github.com/mdopp/servicebay/commit/ba613e2b0ae93ae5588ff1835174c2b4eaa4b832))

## [4.60.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.60.0...servicebay-v4.60.1) (2026-05-30)


### Bug Fixes

* **tui:** auto-install missing build-host tools instead of dead-ending ([06dd435](https://github.com/mdopp/servicebay/commit/06dd435b20df006662074535bf6f3e2e41baf0b0))
* **tui:** auto-install missing build-host tools instead of dead-ending ([62b49b4](https://github.com/mdopp/servicebay/commit/62b49b494eab9e85ace9122a72420998461e5ba2)), closes [#1327](https://github.com/mdopp/servicebay/issues/1327)

## [4.60.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.59.0...servicebay-v4.60.0) (2026-05-30)


### Features

* **external-backup:** on-demand back-up-all-services-to-NAS endpoint ([7951e27](https://github.com/mdopp/servicebay/commit/7951e27bfbeb8881fe1b2d6c486c1284d8dbf74e))
* **external-backup:** on-demand back-up-all-services-to-NAS endpoint ([b632652](https://github.com/mdopp/servicebay/commit/b63265295f1aa90b6198b2a409a7e9d57fbc4749))

## [4.59.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.58.0...servicebay-v4.59.0) (2026-05-30)


### Features

* **tui:** Home Assistant backup extract + manifest-filter in Go ([ef8e95f](https://github.com/mdopp/servicebay/commit/ef8e95feca52189c73ed983ce72197295e76c0c2))
* **tui:** Home Assistant backup extract + manifest-filter in Go ([ea7e5cd](https://github.com/mdopp/servicebay/commit/ea7e5cd3108ab1dd38fbdad952c5510cb7813163))

## [4.58.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.57.0...servicebay-v4.58.0) (2026-05-30)


### Features

* **boot:** scope the usb-next endpoint + TUI client for USB-boot status ([c2de209](https://github.com/mdopp/servicebay/commit/c2de209ed324e90b87d8ecb9fe6d8d18eb25dfbe))
* **tui:** show USB-boot status on the watch dashboard + u to enable ([e0e9688](https://github.com/mdopp/servicebay/commit/e0e96882915b99249a8efbc05a79fad480f4a5a5))
* **tui:** USB-boot status on the watch dashboard + u to enable ([02b23c4](https://github.com/mdopp/servicebay/commit/02b23c406d558763ba0057bf8a956bbd41a6afcd))

## [4.57.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.56.1...servicebay-v4.57.0) (2026-05-30)


### Features

* **external-backup:** restore a service config backup from the NAS ([#1218](https://github.com/mdopp/servicebay/issues/1218)) ([02b223a](https://github.com/mdopp/servicebay/commit/02b223a711031d2746b736dd3eeabbb20c374487))
* **external-backup:** restore a service config backup from the NAS ([#1218](https://github.com/mdopp/servicebay/issues/1218)) ([41ddc63](https://github.com/mdopp/servicebay/commit/41ddc634af2e2679db83f93a40ce4d5e829076c0))

## [4.56.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.56.0...servicebay-v4.56.1) (2026-05-30)


### Bug Fixes

* **external-backup:** extract only manifest paths from HA backups ([#1353](https://github.com/mdopp/servicebay/issues/1353)) ([c0d32b4](https://github.com/mdopp/servicebay/commit/c0d32b450a10ccfbfe6d0b4b27ecf09dbc142d1d))
* **external-backup:** extract only manifest paths from HA backups ([#1353](https://github.com/mdopp/servicebay/issues/1353)) ([01eea6e](https://github.com/mdopp/servicebay/commit/01eea6e342fbec01ab8b40c24f7c74ddf83f9e3c))

## [4.56.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.55.0...servicebay-v4.56.0) (2026-05-30)


### Features

* **backup:** export lldap users/groups and stage them on the NAS ([4000476](https://github.com/mdopp/servicebay/commit/4000476fb9b5ad0373768cd12100ae3ce491b7c1))
* **backup:** export lldap users/groups and stage them on the NAS ([99bc624](https://github.com/mdopp/servicebay/commit/99bc62499ecb6244ee5f75d7fac6c88a00dad99d))
* **backup:** import a Home Assistant OS backup into the NAS ([073f458](https://github.com/mdopp/servicebay/commit/073f458e8c8a77f4b62bee0940ac8ed5459fa40d))
* **backup:** import a Home Assistant OS backup into the NAS ([1c5177f](https://github.com/mdopp/servicebay/commit/1c5177f43bc5c926a6225e0cd66617a042c99ddc))
* **backup:** route to stage an uploaded service backup onto the NAS ([12ea906](https://github.com/mdopp/servicebay/commit/12ea9061022f08f73928ec62f95925e0c6de06bc))
* **backup:** route to stage an uploaded service backup onto the NAS ([81f8c35](https://github.com/mdopp/servicebay/commit/81f8c35028b16b7c5b6e343b5ee2b136b67ccb44))
* **tui:** upload a service backup archive to the NAS ([43ac35d](https://github.com/mdopp/servicebay/commit/43ac35de2a4461cc971a4ad5ac41af63f64e195d))
* **tui:** upload a service backup archive to the NAS ([12663cf](https://github.com/mdopp/servicebay/commit/12663cf277a1bde1315e0ff888e43b267865e7d1))

## [4.55.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.54.0...servicebay-v4.55.0) (2026-05-29)


### Features

* **tui:** after build, guide boot + watch the install (reinstall-aware) ([8185d38](https://github.com/mdopp/servicebay/commit/8185d38397ecd230bff8fa5b3e5d37e774a7d7e0))
* **tui:** after build, guide boot + watch the install (reinstall-aware) ([f7e0f99](https://github.com/mdopp/servicebay/commit/f7e0f99c2c041ce768688472591f098c5a55bf2d))
* **tui:** full-screen build wizard form replacing stdin Q&A ([7feeee0](https://github.com/mdopp/servicebay/commit/7feeee0eabc721b66a48c155fd0c6c87d81c2826))
* **tui:** full-screen build wizard form replacing stdin Q&A ([b36dc03](https://github.com/mdopp/servicebay/commit/b36dc033e6605d961e2a8fa67b8950eff759855c))
* **tui:** memorable host password + SSH-key guidance/generation ([3c4ce79](https://github.com/mdopp/servicebay/commit/3c4ce793632f939b7420d97643398ce89c70f607))
* **tui:** memorable host password + SSH-key guidance/generation ([0a0936c](https://github.com/mdopp/servicebay/commit/0a0936cef8a08dd730f6ebaccd39ad24b4410bda))
* **tui:** stay on a live screen + "boot box from USB" reinstall action ([84c2075](https://github.com/mdopp/servicebay/commit/84c2075bb4b88b5620b7c4d0f5f01a8b45219c40))
* **tui:** stay on live screen + boot-box-from-USB reinstall action ([4221654](https://github.com/mdopp/servicebay/commit/422165452f6b76d2f131fb3aba383a92ed64ab2e))


### Bug Fixes

* **tui:** accept mixed-case hostnames + in-field caret editing ([58b4265](https://github.com/mdopp/servicebay/commit/58b4265d3c884ab9e37b0b6e512e710948f8fff6))
* **tui:** accept mixed-case hostnames + in-field caret editing ([c9646e3](https://github.com/mdopp/servicebay/commit/c9646e3a630ac331dca2e705cbbb63e7d26c68a4))
* **tui:** auto-refresh the menu + show box URL persistently ([6dd89ed](https://github.com/mdopp/servicebay/commit/6dd89edce31a9ff82312ea85c7502217adffea08))
* **tui:** auto-refresh the menu + show box URL persistently ([bf8e352](https://github.com/mdopp/servicebay/commit/bf8e3526813bab91e025c2d5c0c2f7bd65e57854))
* **tui:** coherent build-form interaction + esc returns to menu ([e727ffc](https://github.com/mdopp/servicebay/commit/e727ffc9ae75bac195c2d70f6ff39f3f8dcbc8ab))
* **tui:** coherent build-form interaction + esc returns to menu ([ef55c30](https://github.com/mdopp/servicebay/commit/ef55c30b8ea6619516d592c511e60db0a1a15a45))
* **tui:** colour the watch status dots + guide booting FROM the USB ([4dc4ab3](https://github.com/mdopp/servicebay/commit/4dc4ab3e743d06d488f832f946531c7511188649))
* **tui:** colour watch status dots + guide booting FROM the USB ([1b17875](https://github.com/mdopp/servicebay/commit/1b17875a9e2166dd711f1700aad46502fe0afa26))

## [4.54.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.53.0...servicebay-v4.54.0) (2026-05-29)


### Features

* **tui:** backup list/create/restore panel over REST ([26fe93d](https://github.com/mdopp/servicebay/commit/26fe93d38bdf692b8169269cb0d66d4b1a03f4a5))
* **tui:** backup list/create/restore panel over REST ([263a2b8](https://github.com/mdopp/servicebay/commit/263a2b8d6b87116f96a2f5605479e0388ac00901))
* **tui:** guided Express setup for the pre-boot happy path ([ed13ef9](https://github.com/mdopp/servicebay/commit/ed13ef962cef67d6f648848326345c886b1e46d7))
* **tui:** guided Express setup for the pre-boot happy path ([6469d39](https://github.com/mdopp/servicebay/commit/6469d3950224a4a525aedadfac177a2e7218aa55))
* **tui:** stack-install panel over REST ([92a73e2](https://github.com/mdopp/servicebay/commit/92a73e211f58f3bb0947667b101e03dc2a47b55b))
* **tui:** stack-install panel over REST ([2a044cb](https://github.com/mdopp/servicebay/commit/2a044cb870d84e0f92104b09ae940bd8df00168d))
* **tui:** unified app shell + in-TUI sign-in ([e219f3c](https://github.com/mdopp/servicebay/commit/e219f3ccb5b41b558c3051e80331164d21af710e))
* **tui:** unified app shell + in-TUI sign-in ([967ef5f](https://github.com/mdopp/servicebay/commit/967ef5f5398871d5721f55131797a1fe5f1540c1))


### Bug Fixes

* **tui:** detect box phase by what it serves, not a stale job flag ([4f15de8](https://github.com/mdopp/servicebay/commit/4f15de8ac95d4be5e6a860f3e659fe4efa3a5e26))
* **tui:** detect box phase by what it serves, not a stale job flag ([7825687](https://github.com/mdopp/servicebay/commit/78256878aac7c622fe1c6e98be89c7ea861bdbb4))
* **tui:** drop dead Watch action on an up box; explain the sign-in ([5cf7c38](https://github.com/mdopp/servicebay/commit/5cf7c38a0b92012cdd3b1b69ade197f0e4492cbc))
* **tui:** drop dead Watch action on an up box; explain the sign-in ([3e3955b](https://github.com/mdopp/servicebay/commit/3e3955ba1b408d184e664f40e1df98b7899e71b2))
* **tui:** reachable idle box is manageable; watch + open run in-app ([5e9a35c](https://github.com/mdopp/servicebay/commit/5e9a35c97712e7de3f3afad07f7411686696c16b))
* **tui:** send same-origin header on login + token mint ([88cd4b5](https://github.com/mdopp/servicebay/commit/88cd4b5f04a533a076a92a48da9c2e840088b0f5))
* **tui:** send same-origin header on login + token mint ([5e3e966](https://github.com/mdopp/servicebay/commit/5e3e9660a4aa6bd3c7f6a5680f1ef02346c7958a))
* **tui:** treat a reachable idle box as manageable; watch + open run in-app ([6eed976](https://github.com/mdopp/servicebay/commit/6eed976c4533f7cb66624b775ae77dddff91739e))

## [4.53.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.52.0...servicebay-v4.53.0) (2026-05-29)


### Features

* **auth:** make scoped REST tokens reachable + redact config for token callers ([d82c579](https://github.com/mdopp/servicebay/commit/d82c579677bb598cbabd7cef0db94651fe2a4efa))
* **auth:** make scoped REST tokens reachable + redact config for token callers ([aae310a](https://github.com/mdopp/servicebay/commit/aae310ae65380bbe85e4a7b644754f16a32430d9))
* **mcp:** add guarded factory_reset tool ([14c5710](https://github.com/mdopp/servicebay/commit/14c571065b419ed8c2b22e04fa34401daf5e093e))
* **tui:** box REST token client + edit-config panel ([1b12e2c](https://github.com/mdopp/servicebay/commit/1b12e2cfd6bff5324283deedf18488927e4183bf))
* **tui:** box REST token client + edit-config panel ([d37ceaa](https://github.com/mdopp/servicebay/commit/d37ceaa3bb01643bb329082876fecef7a4f85aad))
* **tui:** full-screen launcher + complete lifecycle menu + auto-launch ([d08434d](https://github.com/mdopp/servicebay/commit/d08434dd653d33871bd6530c7639c0f5b14235b5))
* **tui:** full-screen launcher, complete lifecycle menu, auto-launch ([b159943](https://github.com/mdopp/servicebay/commit/b1599436c24e2383f708de7554cb0cd58eeca887))

## [4.52.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.51.1...servicebay-v4.52.0) (2026-05-29)


### Features

* **tui:** cross-compiled sb-tui release binaries + curl|sh installer ([88964b0](https://github.com/mdopp/servicebay/commit/88964b0202087caa773e22bcf66ffbe5da8c05da))
* **tui:** cross-compiled sb-tui release binaries + curl|sh installer ([b382a92](https://github.com/mdopp/servicebay/commit/b382a9270918dd0d5895ba2f79b1124a94585125)), closes [#1279](https://github.com/mdopp/servicebay/issues/1279)


### Bug Fixes

* **services:** realign sudo-written asset files to their dir owner ([6840b6e](https://github.com/mdopp/servicebay/commit/6840b6e0bff8c3cfd38cf2d57c0401db1acceb8d))
* **services:** realign sudo-written asset files to their dir owner ([9055e20](https://github.com/mdopp/servicebay/commit/9055e20b0f282b21e6f5c54b7bab830c9f94392e)), closes [#1298](https://github.com/mdopp/servicebay/issues/1298)

## [4.51.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.51.0...servicebay-v4.51.1) (2026-05-29)


### Bug Fixes

* **dashboards:** sort services by displayName not unit name ([69386b0](https://github.com/mdopp/servicebay/commit/69386b00739c0224b37d055542d6f38c97c7d50a))

## [4.51.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.50.1...servicebay-v4.51.0) (2026-05-29)


### Features

* **tui-go:** USB device enumeration and ISO flash ([5ec7d73](https://github.com/mdopp/servicebay/commit/5ec7d73ec55e60bb0869992e80f683b1ede77e9d))

## [4.50.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.50.0...servicebay-v4.50.1) (2026-05-29)


### Bug Fixes

* **tui-go:** reuse an existing ServiceBay SSH keypair when baking ([77a84bb](https://github.com/mdopp/servicebay/commit/77a84bbc091b3341d0d30627b68953901b4094fe))
* **tui-go:** reuse an existing ServiceBay SSH keypair when baking ([ece2a7f](https://github.com/mdopp/servicebay/commit/ece2a7f8e091c8b7439d40804b1df5661018311e))

## [4.50.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.49.0...servicebay-v4.50.0) (2026-05-29)


### Features

* **tui-go:** render Butane template for the native ISO build ([645c619](https://github.com/mdopp/servicebay/commit/645c619eaecff549bd00329550f648a4e7189733))
* **tui-go:** render Butane template for the native ISO build ([db730d8](https://github.com/mdopp/servicebay/commit/db730d8b3ef6353ef52d1157e9be52e0bcb680eb))
* **tui-go:** transpile and bake the customized installer ISO ([aca1e1f](https://github.com/mdopp/servicebay/commit/aca1e1f68c4ec78c772626c9b50c0315e911d92d))
* **tui-go:** transpile and bake the customized installer ISO ([d3d2f19](https://github.com/mdopp/servicebay/commit/d3d2f193610d0f60940a9e70a7020cce940fdd0e))

## [4.49.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.48.0...servicebay-v4.49.0) (2026-05-29)


### Features

* **tui-go:** bootstrap secret generation and Bitwarden CSV ([a6fffb7](https://github.com/mdopp/servicebay/commit/a6fffb70ee0a633aa661d2be5a72ce299f77c23f))
* **tui-go:** bootstrap secret generation and Bitwarden CSV ([bdde38a](https://github.com/mdopp/servicebay/commit/bdde38aec8e20d2554bc78f9f4dd5d558206e68b))
* **tui-go:** FCoS ISO download and version picker ([ab5ba4e](https://github.com/mdopp/servicebay/commit/ab5ba4e96c12794241f248700e0ab099cd11b391))
* **tui-go:** FCoS ISO download and version picker ([e957207](https://github.com/mdopp/servicebay/commit/e9572073ef04bf6674312bf86ca0ae088fed491b))
* **tui-go:** ServiceBay config.json builder ([bb8fbdd](https://github.com/mdopp/servicebay/commit/bb8fbdd907c87428d84a80b3ce70ea508258df14))
* **tui-go:** ServiceBay config.json builder ([bf37b24](https://github.com/mdopp/servicebay/commit/bf37b249ab9389a2e26ecd20a5f770e5839d9fef))

## [4.48.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.47.0...servicebay-v4.48.0) (2026-05-29)


### Features

* **install:** auto-generate ServiceBay-owned bootstrap secrets ([8d57ce8](https://github.com/mdopp/servicebay/commit/8d57ce8aeea40a012f994a7bd9f8e7d908526c05))
* **install:** auto-generate ServiceBay-owned bootstrap secrets ([6b10d64](https://github.com/mdopp/servicebay/commit/6b10d64552dab9f6f41dd59ff2d4666aaf74dd83))
* **tui-go:** build-leg install-settings model ([ff08a21](https://github.com/mdopp/servicebay/commit/ff08a21fa99d809f103f9c0450c3f2feaf59068e))
* **tui-go:** build-leg install-settings model ([8d4d255](https://github.com/mdopp/servicebay/commit/8d4d2555dd003acc4baa15a31762266e50b2446c))
* **tui-go:** native install-watch dashboard, remove install-tui.sh ([e2b1869](https://github.com/mdopp/servicebay/commit/e2b1869b7b10fae6ac07bcca042a6f0b94a5ba90))
* **tui-go:** native install-watch dashboard, remove install-tui.sh ([d8b7192](https://github.com/mdopp/servicebay/commit/d8b71927afd1ceaf6f377098b3fb15dc5961ac60))

## [4.47.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.46.2...servicebay-v4.47.0) (2026-05-29)


### Features

* **api:** scoped API tokens on REST + unify the token store ([a5f1c05](https://github.com/mdopp/servicebay/commit/a5f1c054e43cf2a0f504ff515c9080bde189d6ec))
* **mcp:** add reboot_node tool with SSH fallback ([57cfa3e](https://github.com/mdopp/servicebay/commit/57cfa3eebf43e08bb0ff79059c104cae5a9aacfd))
* **mcp:** add reboot_node tool with SSH fallback ([54e45b7](https://github.com/mdopp/servicebay/commit/54e45b7ab29060a78773b74a01d9664aea269585))
* **mcp:** add verify_usb_boot reinstall-readiness check ([3cb7f1a](https://github.com/mdopp/servicebay/commit/3cb7f1abe6a20b8fa1484a7d9b6a33bc5ff42159))
* **mcp:** add verify_usb_boot reinstall-readiness check ([06391b8](https://github.com/mdopp/servicebay/commit/06391b841f334732cd9367eeff5442cb661064dc))
* **tui-go:** scaffold Go + Bubble Tea launcher with phase menu ([077c301](https://github.com/mdopp/servicebay/commit/077c3014d6ee5b881c1c3bf77202f1be8a3c3c26))
* **tui-go:** scaffold Go + Bubble Tea launcher with phase menu ([cc857f2](https://github.com/mdopp/servicebay/commit/cc857f233aaaeb69dfab0dfd458acff2db5afd26))


### Bug Fixes

* **help:** dedupe and de-jargon the What's New changelog ([c583309](https://github.com/mdopp/servicebay/commit/c583309b1f4a325b93e332ceb6a8c784fdbdc594))
* **help:** dedupe and de-jargon the What's New changelog ([528f0b5](https://github.com/mdopp/servicebay/commit/528f0b5aca84fe87b5e45e5c4b09ecb752f05a66))

## [4.46.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.46.1...servicebay-v4.46.2) (2026-05-28)


### Bug Fixes

* **services:** retry asset write with sudo when the agent rejects on EACCES ([44cb1bb](https://github.com/mdopp/servicebay/commit/44cb1bbb21df4595a33b72e61556d18d3523f5bd))
* **services:** retry asset write with sudo when the agent rejects on EACCES ([e081002](https://github.com/mdopp/servicebay/commit/e081002dc6ec8e07633b1e6a897918bd4edb1b08))

## [4.46.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.46.0...servicebay-v4.46.1) (2026-05-28)


### Bug Fixes

* **install:** stream real image-pull progress with cached-layer info ([154b151](https://github.com/mdopp/servicebay/commit/154b151503d0aa8ca3ed484b269e749866e4edcc))
* **install:** stream real image-pull progress with cached-layer info ([7ed65b0](https://github.com/mdopp/servicebay/commit/7ed65b070ecf7731e540da2fbf2f875d4a5508bb))
* **registry:** list Stacks before Templates in the registry browser ([b7623cf](https://github.com/mdopp/servicebay/commit/b7623cfdbdb7ef017bfc17315936290a339f3ed4))
* **registry:** list Stacks before Templates in the registry browser ([3d314d8](https://github.com/mdopp/servicebay/commit/3d314d86fad207a6f8d7b99dfe2eadbc2b4022cb))
* **registry:** run registry git ops non-interactively so unreachable repos fail fast ([9aa7473](https://github.com/mdopp/servicebay/commit/9aa7473e857f253948f91aa4daa831877b7abb14))
* **registry:** run registry git ops non-interactively so unreachable repos fail fast ([fc771bf](https://github.com/mdopp/servicebay/commit/fc771bf163bd6fb2326a0a8c62b60eefd243d1bd))

## [4.46.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.45.0...servicebay-v4.46.0) (2026-05-28)


### Features

* **registry:** give stacks their own section in the registry browser ([9b56615](https://github.com/mdopp/servicebay/commit/9b566157c6659cef45a2d29987095d42ce375436))
* **registry:** give stacks their own section in the registry browser ([d67fd4d](https://github.com/mdopp/servicebay/commit/d67fd4da971fa125cc30cc322ce014aa4f57c61d))


### Bug Fixes

* **frontend:** show signed-in user + working logout on LAN-direct access ([07a4f9d](https://github.com/mdopp/servicebay/commit/07a4f9dfff98209b3e9e2df74741f99322fa5b86))
* **frontend:** show signed-in user + working logout on LAN-direct access ([22425d4](https://github.com/mdopp/servicebay/commit/22425d49f7f99f12457227d03f68d22916637fc8))
* **install:** count already-deployed templates as satisfying install-time deps ([f910550](https://github.com/mdopp/servicebay/commit/f910550ff1b89e707dd16ceac03714863b701c03))
* **install:** count already-deployed templates as satisfying install-time deps ([4e238aa](https://github.com/mdopp/servicebay/commit/4e238aace977d0bbb96e8ae4ac81c09d36b6e2c5))

## [4.45.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.44.0...servicebay-v4.45.0) (2026-05-28)


### Features

* **tui:** Fedora CoreOS ISO version-picker panel ([69f34ed](https://github.com/mdopp/servicebay/commit/69f34ed7e597eee0472778b90266d64f8cec63aa))
* **tui:** Fedora CoreOS ISO version-picker panel ([7c8b6cf](https://github.com/mdopp/servicebay/commit/7c8b6cf91e1d28e62697d06a2c43390b47ff2a1a))
* **tui:** lifecycle launcher shell with phase detection ([25971b1](https://github.com/mdopp/servicebay/commit/25971b12a8c5d3e51a5f940c051425c975d6a940))
* **tui:** lifecycle launcher shell with phase detection ([138fb8f](https://github.com/mdopp/servicebay/commit/138fb8f82d92d3177490b49fb9128c0df4162cc5))


### Bug Fixes

* **auth:** don't let a failing SMTP check fatal the whole auth pod ([7f0998c](https://github.com/mdopp/servicebay/commit/7f0998cfc1079a08b0e5a7fc724a433e01c6a944))
* **auth:** stop LLDAP reset-loop on reinstall and SMTP-fatal auth crashes ([207ed06](https://github.com/mdopp/servicebay/commit/207ed06a2120f55f1860e03bd0477f7caf3b4f8b))
* **ci:** cache workspace node_modules so the root tsc resolves nested deps ([4f002eb](https://github.com/mdopp/servicebay/commit/4f002eb755c127c954371531df768f9469e8368d))
* **install:** keep LLDAP serving on secret-regen reinstall ([8745dfa](https://github.com/mdopp/servicebay/commit/8745dfac89d9ee2d389f9fed85e417a18a60f1d5))

## [4.44.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.43.0...servicebay-v4.44.0) (2026-05-28)


### Features

* **backup:** add sb-config-upload CLI to seed the NAS from a non-SB source ([c3f8633](https://github.com/mdopp/servicebay/commit/c3f8633d6c2b4ffd89e95c66943216d42dac9554))
* **backup:** add sb-config-upload CLI to seed the NAS from a non-SB source ([92209e1](https://github.com/mdopp/servicebay/commit/92209e1a5e08387a7f59ec80d11f290b9d9d7a45))
* **backup:** diagnose probe for FritzBox NAS backup reachability ([1a0cd97](https://github.com/mdopp/servicebay/commit/1a0cd97d77857b35a76f3fd39aa798b64f7c5c6c))
* **backup:** diagnose probe for FritzBox NAS backup reachability ([da8d1c5](https://github.com/mdopp/servicebay/commit/da8d1c5696b72142218284180e640b9080fbedde))
* **backup:** produce per-service config tarballs and write them to the NAS ([dabba6b](https://github.com/mdopp/servicebay/commit/dabba6b3180b8454da8c8f82ca0ff8962ad34f4d))
* **backup:** produce per-service config tarballs and write them to the NAS ([ae0c74a](https://github.com/mdopp/servicebay/commit/ae0c74af0560c1cabbced647d00cf96193d83839))

## [4.43.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.42.0...servicebay-v4.43.0) (2026-05-28)


### Features

* **backup:** FTP NAS client for the FritzBox (reuses gateway creds) ([fdfc58a](https://github.com/mdopp/servicebay/commit/fdfc58afafa5c9a594d4f851784a71c2ebf42f0c))
* **backup:** FTP NAS client for the FritzBox (reuses gateway creds) ([5cbd4b2](https://github.com/mdopp/servicebay/commit/5cbd4b2f9eca6e18503427183a75e8ec56023d1d))
* **backup:** per-service config manifest + stripping rules for externalBackup ([ed05b0b](https://github.com/mdopp/servicebay/commit/ed05b0baad97dd9c4fcc5f6ffe683d4a659ab389))
* **backup:** per-service config manifest + stripping rules for externalBackup ([1b0867a](https://github.com/mdopp/servicebay/commit/1b0867ae09bd9fd489ec04530cb41703a2904567))


### Bug Fixes

* **actions:** require admin session on sensitive Server Actions ([f5fd24e](https://github.com/mdopp/servicebay/commit/f5fd24e2f2053e99b3eeffd26cdffbe234c05216))
* **agent:** redact secret env values from command-payload logs ([2fb4cbd](https://github.com/mdopp/servicebay/commit/2fb4cbd730a3f780f9ee4a17eaf6b6404a5b2468))
* **agent:** redact secret env values from command-payload logs ([ee66882](https://github.com/mdopp/servicebay/commit/ee66882f557058ee3b7df56c620a909d9406d063))
* **agent:** redact secrets from command result logs too ([3a16f87](https://github.com/mdopp/servicebay/commit/3a16f8713ee6a225d1759979fb45748e3d97921b))
* **agent:** redact secrets from command result logs too ([0195bd8](https://github.com/mdopp/servicebay/commit/0195bd8a267bebc738235088548c1cd1cb9893ec))
* **mcp:** resolve real client IP for bootstrap-token LAN gate ([07033ab](https://github.com/mdopp/servicebay/commit/07033ab46cee18379d2c48990a0aa5322a2d73af))

## [4.42.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.41.1...servicebay-v4.42.0) (2026-05-28)


### Features

* **file-share:** link the latest BasicSync APK per Android ABI ([51bc2eb](https://github.com/mdopp/servicebay/commit/51bc2eb631627bf12151804f0314e9117ddf2ca0))
* **file-share:** link the latest BasicSync APK per Android ABI ([894634d](https://github.com/mdopp/servicebay/commit/894634d5563ac418954a2f075920d9477bd17826))


### Bug Fixes

* **install:** assemble walks all registries when source is omitted ([48c1088](https://github.com/mdopp/servicebay/commit/48c10882afad7c07a7b0f852d81ae991243209e6))
* **install:** assemble walks all registries when source is omitted ([10c8451](https://github.com/mdopp/servicebay/commit/10c845160d9b13f832548824cfe366afaf6d0494))

## [4.41.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.41.0...servicebay-v4.41.1) (2026-05-28)


### Bug Fixes

* **install:** sudo-retry asset write when hostPath is owned by another uid ([b5a50dd](https://github.com/mdopp/servicebay/commit/b5a50dd12cfb46537864cdcbfc634ce0d45303dd))
* **install:** sudo-retry asset write when hostPath is owned by another uid ([5aa95a3](https://github.com/mdopp/servicebay/commit/5aa95a35da33a85f63567a86e0ae4f6f10314d6c))

## [4.41.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.40.2...servicebay-v4.41.0) (2026-05-28)


### Features

* **install:** fetch remote FCoS image list + auto-launch install-tui ([4ad0f35](https://github.com/mdopp/servicebay/commit/4ad0f359d28dc0df6b1af558c2a204e0642d4f81))
* **install:** fetch remote FCoS image list + auto-launch install-tui ([bae9b61](https://github.com/mdopp/servicebay/commit/bae9b610768fa8d3208d570ea1b3150a4ff5391b))

## [4.40.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.40.1...servicebay-v4.40.2) (2026-05-27)


### Bug Fixes

* **install:** pre-pull renders {{VAR}} image placeholders against wizard variables ([c325a2a](https://github.com/mdopp/servicebay/commit/c325a2aeba39cd7f194035fb94cf4e621fd48e78))
* **install:** pre-pull renders {{VAR}} image placeholders against wizard variables ([a6cc3dc](https://github.com/mdopp/servicebay/commit/a6cc3dc669a4170dd7812303b68c2f475725d2c0))
* **network:** break infinite-render loop in useTopologyData by stabilising fetchGraph ([bbd4ebb](https://github.com/mdopp/servicebay/commit/bbd4ebb87e4c47ced81bc036fbca4563783fcf8f))
* **network:** break infinite-render loop in useTopologyData by stabilising fetchGraph ([c1588b9](https://github.com/mdopp/servicebay/commit/c1588b928ca2d3ccaff06540d09390fa3b37e654))
* **nginx:** reconcile NPM proxy upstream when a domain is re-used by a new template ([328fb67](https://github.com/mdopp/servicebay/commit/328fb6743b0bb1e5421153c17c5580dd09038218))
* **nginx:** reconcile NPM proxy upstream when a domain is re-used by a new template ([9230dbd](https://github.com/mdopp/servicebay/commit/9230dbd1daae108fed13179c797a19928a22517e))

## [4.40.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.40.0...servicebay-v4.40.1) (2026-05-27)


### Bug Fixes

* **api:** /api/system/stacks now includes external-registry stacks ([2a4930e](https://github.com/mdopp/servicebay/commit/2a4930ef6eda6ec62ad73bef8f64c3a67e4ff29c))
* **api:** /api/system/stacks now includes external-registry stacks ([c534761](https://github.com/mdopp/servicebay/commit/c534761460f64831ba2b46d2c2706933e753170a))
* **portal:** /api/portal/asset now serves authenticated SB sessions in public mode ([46dc511](https://github.com/mdopp/servicebay/commit/46dc5113f7bf493efe733f90a030acdba5a3c497))
* **portal:** accept 8-group Syncthing device-ids (v2.x format) ([77d5226](https://github.com/mdopp/servicebay/commit/77d52267a4ea8161f139122d1c2eaa4c41fa1935))
* **portal:** accept Syncthing v2.x 8-group device-ids ([10cc0ad](https://github.com/mdopp/servicebay/commit/10cc0adb84444c704b55e36cd2d60b6d054b130e))
* **portal:** allow authenticated SB requests to /api/portal/asset in public mode ([bdf402a](https://github.com/mdopp/servicebay/commit/bdf402af5e85f29917181438f89d20561dd89646))

## [4.40.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.39.2...servicebay-v4.40.0) (2026-05-27)


### Features

* **installer:** add mdopp/oscar as opt-in default registry in FCoS prompt ([bb9842c](https://github.com/mdopp/servicebay/commit/bb9842c6f47c6fe5048a2e51764d75da7ad3d883))
* **installer:** add mdopp/oscar as opt-in default registry in FCoS prompt ([25e753d](https://github.com/mdopp/servicebay/commit/25e753df5351ef5115853034eab982a8215388f1))
* **install:** ship template skills/ directories to agent via existing extraFiles transport ([ab2e40e](https://github.com/mdopp/servicebay/commit/ab2e40e9c432a74f20c58d27df68d747688ef189))
* **install:** ship template skills/ directories to agent via existing extraFiles transport ([443baec](https://github.com/mdopp/servicebay/commit/443baec5171a3fb2320ffb24db948b098150df43))

## [4.39.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.39.1...servicebay-v4.39.2) (2026-05-27)


### Bug Fixes

* **installer:** hide system-wide Clean Install toggle from per-template modal ([72520b0](https://github.com/mdopp/servicebay/commit/72520b08d4f51a59c04c1be0768254b4ca0190e2))
* **installer:** hide system-wide Clean Install toggle from per-template modal ([2bdf67b](https://github.com/mdopp/servicebay/commit/2bdf67bda7d6dac93f9d60b0021422dd5dc60bd2))

## [4.39.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.39.0...servicebay-v4.39.1) (2026-05-27)


### Bug Fixes

* **install:** cap per-job log file at configured line/byte limits ([ab236cb](https://github.com/mdopp/servicebay/commit/ab236cbb7af455aa95c93f009ae798ada74caa80))
* **install:** cap per-job log file at maxJobLogLines / maxJobLogBytes ([53bfe31](https://github.com/mdopp/servicebay/commit/53bfe31e5ae58cce7ecbcda495030685888f6858))
* **install:** serialize createJob to close TOCTOU on concurrent installs ([fe6af50](https://github.com/mdopp/servicebay/commit/fe6af5004e5aebd1ea0e111ce24e93985a909cdd))
* **install:** serialize createJob to close TOCTOU on concurrent installs ([7a72e34](https://github.com/mdopp/servicebay/commit/7a72e345a4d994781df39da7985bd71e69527124))

## [4.39.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.38.0...servicebay-v4.39.0) (2026-05-27)


### Features

* **backend:** add schemaVersion field to AppConfig ([5336664](https://github.com/mdopp/servicebay/commit/5336664c953fedf5071370a95e62e96ada325aff))
* **backend:** add schemaVersion field to AppConfig ([53a6b6f](https://github.com/mdopp/servicebay/commit/53a6b6f2b4b45de1144d333114708e94b1377ce8))

## [4.38.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.37.0...servicebay-v4.38.0) (2026-05-27)


### Features

* **backend:** add per-job log cap config fields ([ccbfe81](https://github.com/mdopp/servicebay/commit/ccbfe81ee07fedf0b7809be026767559a48dc504))
* **backend:** add per-job log cap config fields ([ffd7a50](https://github.com/mdopp/servicebay/commit/ffd7a5040124a2be50b4e72ceda62e434e12eaf3))
* **frontend:** add FocusTrap component and wire it into FileViewerOverlay ([114a07d](https://github.com/mdopp/servicebay/commit/114a07d363a4f12c9f3532215de8c718631af16a))
* **frontend:** add FocusTrap component and wire it into FileViewerOverlay ([b237065](https://github.com/mdopp/servicebay/commit/b237065203df33b06f828e34879db140663b3238))

## [4.37.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.36.4...servicebay-v4.37.0) (2026-05-27)


### Features

* **api-client:** add apiFetch wrapper that handles 401 redirects ([0b30aba](https://github.com/mdopp/servicebay/commit/0b30abacad57af9773f2b68e9b746279762eff96))
* **api-client:** add apiFetch wrapper that handles 401 redirects ([3d4ec1e](https://github.com/mdopp/servicebay/commit/3d4ec1eee78f50c065eafa3955156e380490b78f))


### Bug Fixes

* **api:** replace any with structural types in service action-stream ([78e9821](https://github.com/mdopp/servicebay/commit/78e98217a3d6040f1f63083bbf86119b3db2fe34))
* **api:** replace any with structural types in service action-stream ([557fc73](https://github.com/mdopp/servicebay/commit/557fc735bd9abe3097340cd3b6e854776d842e16))

## [4.36.4](https://github.com/mdopp/servicebay/compare/servicebay-v4.36.3...servicebay-v4.36.4) (2026-05-27)


### Bug Fixes

* **backend:** route discovery when endpoint is empty ([611750b](https://github.com/mdopp/servicebay/commit/611750b6b46cdd4f29407a60bee7d8273d98b204))
* **backend:** route discovery's systemctl call through execArgv ([94cae9f](https://github.com/mdopp/servicebay/commit/94cae9fdf1c7d6dd0b69e8c21f44314e76d7194c))
* **backend:** shellQuote to use single quotes ([4eac25d](https://github.com/mdopp/servicebay/commit/4eac25dde1ff27f927da305f248809f505089c4b))

## [4.36.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.36.2...servicebay-v4.36.3) (2026-05-27)


### Bug Fixes

* **backend:** apply runtime logLevel changes inside updateConfig ([2520a47](https://github.com/mdopp/servicebay/commit/2520a47a6d0475e57e15960e1e43638e2b24ae99))
* **backend:** apply runtime logLevel changes inside updateConfig ([c5b2efa](https://github.com/mdopp/servicebay/commit/c5b2efa8581ae43129b681842085ec09a9164ecf))
* **backend:** require FritzBox host to be a private LAN address ([7dac577](https://github.com/mdopp/servicebay/commit/7dac57782c54786e634ffbf8e9902482acc25c77))
* **backend:** require FritzBox host to be a private LAN address ([109fdb9](https://github.com/mdopp/servicebay/commit/109fdb97a2a41fe4af7a01f0fbe01667a6c84e83))
* **portal:** reset onboarding picker checks on back-nav into picker ([40813ca](https://github.com/mdopp/servicebay/commit/40813ca6b024796983a96f41d53660f31a85af0b))
* **portal:** reset onboarding picker checks on back-nav into picker ([229c664](https://github.com/mdopp/servicebay/commit/229c664772b77f6aef65740031416cdbd47613e1))

## [4.36.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.36.1...servicebay-v4.36.2) (2026-05-27)


### Bug Fixes

* **frontend:** add actionable CTAs to error boundaries ([921f86b](https://github.com/mdopp/servicebay/commit/921f86b814c1a9d1833c253d12835bc936e921ae))
* **frontend:** add actionable CTAs to error boundaries ([ee8dc84](https://github.com/mdopp/servicebay/commit/ee8dc84f68d681d1ea9c19ec7c7677dabcab8d20))
* **frontend:** route stray console.warn through the typed logger ([ecf88b7](https://github.com/mdopp/servicebay/commit/ecf88b7777bc399dca1f0e156e64837d19345e0b))
* **frontend:** route stray console.warn through the typed logger ([84203b4](https://github.com/mdopp/servicebay/commit/84203b45b9d2aa81bef9da1de797955a86068c55))

## [4.36.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.36.0...servicebay-v4.36.1) (2026-05-27)


### Bug Fixes

* **frontend:** add missing runningAction dep to useServiceActions useMemo ([#1105](https://github.com/mdopp/servicebay/issues/1105)) ([a2abe1f](https://github.com/mdopp/servicebay/commit/a2abe1fdd0e76a9da14d1b464533dc785a193be1)), closes [#1065](https://github.com/mdopp/servicebay/issues/1065)
* **portal:** parse stack READMEs before advancing to services step ([#1108](https://github.com/mdopp/servicebay/issues/1108)) ([a84dea4](https://github.com/mdopp/servicebay/commit/a84dea445f545b68e8ac8a93d577b1bc21896af1)), closes [#1067](https://github.com/mdopp/servicebay/issues/1067)

## [4.36.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.35.1...servicebay-v4.36.0) (2026-05-27)


### Features

* **hermes-webui:** decommission orphaned open-webui pod on (re)install ([#1083](https://github.com/mdopp/servicebay/issues/1083)) ([#1084](https://github.com/mdopp/servicebay/issues/1084)) ([7d4b010](https://github.com/mdopp/servicebay/commit/7d4b0108281d6eda8d0a47006a1aeb3becd85809))

## [4.35.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.35.0...servicebay-v4.35.1) (2026-05-26)


### Bug Fixes

* **portal:** use Syncthing v2 `device-id` subcommand for pair-QR generator ([#1060](https://github.com/mdopp/servicebay/issues/1060)) ([4c6a5c5](https://github.com/mdopp/servicebay/commit/4c6a5c54fbfdfaa65378b08afdbe3277797e9b21))

## [4.35.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.34.0...servicebay-v4.35.0) (2026-05-26)


### Features

* **hermes-webui:** replace open-webui with nesquena/hermes-webui template ([#1044](https://github.com/mdopp/servicebay/issues/1044)) ([#1054](https://github.com/mdopp/servicebay/issues/1054)) ([1f7f3ba](https://github.com/mdopp/servicebay/commit/1f7f3babf3ebc14092b8cdefd414fab27984486b))
* **hermes:** enumerate local Ollama tags under custom_providers so Models tab surfaces them ([#1053](https://github.com/mdopp/servicebay/issues/1053)) ([d30169e](https://github.com/mdopp/servicebay/commit/d30169e1a3b09bbc0160a8d22618566f914f358f))

## [4.34.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.33.5...servicebay-v4.34.0) (2026-05-26)


### Features

* **hermes:** auto-wire SB-MCP into Hermes config.yaml on install ([#1045](https://github.com/mdopp/servicebay/issues/1045)) ([#1049](https://github.com/mdopp/servicebay/issues/1049)) ([8ddb56b](https://github.com/mdopp/servicebay/commit/8ddb56b16c7ed7ab6c5c753ab77e5ff8d20478f0))
* **ollama:** pre-pull extras + verify model post-pull ([#1048](https://github.com/mdopp/servicebay/issues/1048)) ([1060381](https://github.com/mdopp/servicebay/commit/1060381dd684ab9895021a156e9f28122968bf10))


### Bug Fixes

* **hermes:** wire OPENAI_BASE_URL/_KEY env so /v1/chat/completions actually resolves an inference provider ([#1043](https://github.com/mdopp/servicebay/issues/1043)) ([413eff7](https://github.com/mdopp/servicebay/commit/413eff7523aa0622bc3b31481db741e30a3ff8c5))

## [4.33.5](https://github.com/mdopp/servicebay/compare/servicebay-v4.33.4...servicebay-v4.33.5) (2026-05-26)


### Bug Fixes

* **portal:** pass X-Original-URL on Authelia /api/verify ([#1041](https://github.com/mdopp/servicebay/issues/1041)) ([80e7b05](https://github.com/mdopp/servicebay/commit/80e7b05424a37dca94cb2507816001f304588d72))

## [4.33.4](https://github.com/mdopp/servicebay/compare/servicebay-v4.33.3...servicebay-v4.33.4) (2026-05-26)


### Bug Fixes

* **portal:** stop bouncing anonymous /portal visits to /login ([#1039](https://github.com/mdopp/servicebay/issues/1039)) ([d1ad3d3](https://github.com/mdopp/servicebay/commit/d1ad3d3898165508714d41c43495d1fc22b558c9))

## [4.33.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.33.2...servicebay-v4.33.3) (2026-05-26)


### Bug Fixes

* **open-webui+portal:** ENABLE_SIGNUP=true (admin bootstrap) + CTA above grid ([#1037](https://github.com/mdopp/servicebay/issues/1037)) ([ed4220c](https://github.com/mdopp/servicebay/commit/ed4220cbf7a74c99650365b26cfbdbcf904d1862))

## [4.33.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.33.1...servicebay-v4.33.2) (2026-05-26)


### Bug Fixes

* **agent:** remove function-local subprocess re-import that shadowed module-level ([#1034](https://github.com/mdopp/servicebay/issues/1034)) ([d08f009](https://github.com/mdopp/servicebay/commit/d08f0093a3b6584b9c9b146891b2c5b56fcf8ae3))

## [4.33.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.33.0...servicebay-v4.33.1) (2026-05-26)


### Bug Fixes

* **open-webui:** route chat through Hermes (not direct to Ollama) ([#1032](https://github.com/mdopp/servicebay/issues/1032)) ([9ce6062](https://github.com/mdopp/servicebay/commit/9ce606207339e7190810a1eb58cbbcdc3035c045))

## [4.33.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.32.1...servicebay-v4.33.0) (2026-05-26)


### Features

* **open-webui:** family chat UI at chat.&lt;domain&gt; ([#1031](https://github.com/mdopp/servicebay/issues/1031)) ([27529c1](https://github.com/mdopp/servicebay/commit/27529c10f5b7a7a117c5bcdb13cf5cc4c184715b))


### Bug Fixes

* **gatekeeper:** add version arg to AsrProgram/AsrModel/TtsProgram ([#1027](https://github.com/mdopp/servicebay/issues/1027)) ([50bf647](https://github.com/mdopp/servicebay/commit/50bf64714b2a841505dd89c41b1acc20a18009e3))
* **ollama:** rootless GPU passthrough via .container Quadlet fallback ([#1029](https://github.com/mdopp/servicebay/issues/1029)) ([aecfd3f](https://github.com/mdopp/servicebay/commit/aecfd3fc606f1d63d4098392c43a741d7d69c463))

## [4.32.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.32.0...servicebay-v4.32.1) (2026-05-26)


### Bug Fixes

* **media:** lowercase folder convention under file-share/data ([#1022](https://github.com/mdopp/servicebay/issues/1022)) ([c627ce9](https://github.com/mdopp/servicebay/commit/c627ce97c1433ebff14ef5d8c744c2a885411514))

## [4.32.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.31.0...servicebay-v4.32.0) (2026-05-26)


### Features

* **portal:** state-aware access-request CTAs + user chip with avatar ([#1019](https://github.com/mdopp/servicebay/issues/1019)) ([09b4374](https://github.com/mdopp/servicebay/commit/09b437432780b4ff531f4ccce960437f30e48366))

## [4.31.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.30.0...servicebay-v4.31.0) (2026-05-26)


### Features

* portal logout + bot/refresh-cw icons + honcho memory template ([#1012](https://github.com/mdopp/servicebay/issues/1012)) ([4477cd9](https://github.com/mdopp/servicebay/commit/4477cd9454468db70bf0c8a6aa50787c915d6765))

## [4.30.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.29.1...servicebay-v4.30.0) (2026-05-26)


### Features

* **auth:** surface signed-in user in sidebar + Logout link ([#1001](https://github.com/mdopp/servicebay/issues/1001) MVP) ([#1011](https://github.com/mdopp/servicebay/issues/1011)) ([ebc9db0](https://github.com/mdopp/servicebay/commit/ebc9db0ced835d650b2e0bd5e2cd5f16715d3330))
* **ollama:** add OLLAMA_SUBDOMAIN — internal NPM host gated by Authelia forward-auth ([#1006](https://github.com/mdopp/servicebay/issues/1006)) ([1a5f88e](https://github.com/mdopp/servicebay/commit/1a5f88e1f60ad5f9a1abd29a31e7e2bb30fadbbd))


### Bug Fixes

* **hermes:** ship sane defaults — HA token retry, noAutoGenerate gateway secrets, ServiceBay config.yaml ([#1008](https://github.com/mdopp/servicebay/issues/1008)) ([0f1eee4](https://github.com/mdopp/servicebay/commit/0f1eee4948b2e209569c8bd3b1686a964286b6fd))
* **install:** reset servicebay-splash failed state after retire ([#998](https://github.com/mdopp/servicebay/issues/998)) ([61b4889](https://github.com/mdopp/servicebay/commit/61b488930eda987f62ef536986fe7cabf95e2e57))
* **proxy:** land Authelia headers + strict-upstream-host in location block; agent gains sudo write_file ([#1007](https://github.com/mdopp/servicebay/issues/1007)) ([c14de93](https://github.com/mdopp/servicebay/commit/c14de935fe84311aa128f0f96dbad89d4bc90f59))

## [4.29.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.29.0...servicebay-v4.29.1) (2026-05-26)


### Bug Fixes

* **boot:** prepend sudo -n to efibootmgr calls in reinstall wizard ([#992](https://github.com/mdopp/servicebay/issues/992)) ([dd7c780](https://github.com/mdopp/servicebay/commit/dd7c780d3f4840fcfebdc1fb9edae316d59b25a4)), closes [#984](https://github.com/mdopp/servicebay/issues/984)
* **install:** auto-provision operator LLDAP user + ensure OIDC clients ([#993](https://github.com/mdopp/servicebay/issues/993)) ([76c31ce](https://github.com/mdopp/servicebay/commit/76c31ce8c76f7aa5385a8b865ba51ced3d9ee63a))
* **proxy:** reconcile advanced_config + rewrite hermes Host header ([#994](https://github.com/mdopp/servicebay/issues/994)) ([382f37a](https://github.com/mdopp/servicebay/commit/382f37a9f03de2040f75b67f6f44386dbc177995))

## [4.29.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.28.0...servicebay-v4.29.0) (2026-05-26)


### Features

* **dashboard:** show GPU details + fix disk field-name mismatch; retire splash quadlet after install ([2787163](https://github.com/mdopp/servicebay/commit/278716383e0721ae53f76893f48fb02dbefc5e6a))
* **scripts:** add install-tui.sh — full-screen dashboard view of the install ([ed96cf0](https://github.com/mdopp/servicebay/commit/ed96cf0e8a5ae89dde1f43edfa843bde679d87d1))


### Bug Fixes

* hermes 502 (NPM upstream now loopback) + authelia smtp notifier ([3d1f58c](https://github.com/mdopp/servicebay/commit/3d1f58c3737d273e8a168a7b0d0d42e6dabb6379))
* **scripts:** install-tui — reduce flicker via alt-screen + per-line clear ([62bec38](https://github.com/mdopp/servicebay/commit/62bec38d612fbbdbc5fca3a1f61ed581c48b3a36))

## [4.28.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.27.0...servicebay-v4.28.0) (2026-05-25)


### Features

* **install:** splash redesign — static SPA shell + status.txt + log.txt ([8d5a243](https://github.com/mdopp/servicebay/commit/8d5a2432229576ad3e5205032b1d156e5c4eecce))
* **scripts:** add watch-install.sh — terminal-side install monitor ([2854ef8](https://github.com/mdopp/servicebay/commit/2854ef84955b863a7b2de0aab269c66e3dd29551))


### Bug Fixes

* **install:** splash-during-install now actually visible — two follow-ups from live reinstall ([ab8403d](https://github.com/mdopp/servicebay/commit/ab8403d2b8d0332d4ed58d2325d13fc2dfbf97fb))
* **install:** unstick FCoS reinstall — USB demote + NVIDIA CDI retry + per-stage progress page ([1a069b4](https://github.com/mdopp/servicebay/commit/1a069b44150ea7bf30d55163e315f1e3d2c56f52))
* **install:** unstick NVIDIA on FCoS — kick akmods + dodge SIGPIPE/pipefail bug ([99290f0](https://github.com/mdopp/servicebay/commit/99290f0027c6c938d520606bc252497cbd00c792))

## [4.27.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.26.0...servicebay-v4.27.0) (2026-05-25)


### Features

* **oscar:** close OSCAR follow-ups [#937](https://github.com/mdopp/servicebay/issues/937) [#938](https://github.com/mdopp/servicebay/issues/938) [#939](https://github.com/mdopp/servicebay/issues/939) [#940](https://github.com/mdopp/servicebay/issues/940) ([#941](https://github.com/mdopp/servicebay/issues/941)) ([8b47738](https://github.com/mdopp/servicebay/commit/8b47738270f32e5323e11f37c6d16af80e8d3ff5))

## [4.26.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.25.0...servicebay-v4.26.0) (2026-05-25)


### Features

* **oscar:** consolidate oscar repository into servicebay ([#933](https://github.com/mdopp/servicebay/issues/933)) ([59846cb](https://github.com/mdopp/servicebay/commit/59846cb2e67cdbb00265ac0cb02ddd46c4c1117e))
* **oscar:** relocate gatekeeper, schema, and skills under templates/oscar-household/src/ ([f6aa0d6](https://github.com/mdopp/servicebay/commit/f6aa0d6dedf3d5a5aaa308d151e4beb9d69c6e67))
* **system:** stop UEFI USB boot loop after FCoS install ([#930](https://github.com/mdopp/servicebay/issues/930)) ([04aead3](https://github.com/mdopp/servicebay/commit/04aead34db1d58c952d46a81598172360f25691f))
* **system:** stop UEFI USB boot loop after FCoS install ([#930](https://github.com/mdopp/servicebay/issues/930)) ([d79fb6d](https://github.com/mdopp/servicebay/commit/d79fb6d1ec1ad3ad1a6d6b69e264a115af554b14))


### Bug Fixes

* auto-onboard HA + mint long-lived token so Hermes can authenticate [#934](https://github.com/mdopp/servicebay/issues/934) ([8f39adc](https://github.com/mdopp/servicebay/commit/8f39adcd12a8b2d75eda728650480f8794740422))
* **fcos:** force-load nvidia kmod + bump stage-3 timeout to 3 min ([b55e159](https://github.com/mdopp/servicebay/commit/b55e159c16821797deb2d17b7ca7cdcf138304c4))
* **fcos:** use akmod-nvidia-open + add libnvidia-container repo ([2c77a17](https://github.com/mdopp/servicebay/commit/2c77a175ff83b99e65663e309af523c5e9c6c7c6))
* **health:** re-bootstrap service-health poller after agent sync [#935](https://github.com/mdopp/servicebay/issues/935) ([347a72e](https://github.com/mdopp/servicebay/commit/347a72e7847a00632fe9ef69b072abd602cceebb))
* **hermes:** relax data-dir perms so oscar-household can merge MCP block ([d8f0a43](https://github.com/mdopp/servicebay/commit/d8f0a4377d022e0f24d76a99d6ebd0c6cad06b9b))
* **install:** stop oscar-household init thrash + auto-enable ollama GPU on CDI hosts ([f5fb57d](https://github.com/mdopp/servicebay/commit/f5fb57daddb5fa7c312963ad925b8221e63c870d))
* **oscar-household:** add tcp health probe so household stack reports ready ([0282693](https://github.com/mdopp/servicebay/commit/0282693e71dbc5014f9ffa8b37a3cbfcf0099091))
* **oscar-household:** drop ports block - hostNetwork can't carry port mappings ([664eda0](https://github.com/mdopp/servicebay/commit/664eda00a848bb2f5c182bdfd291650b2b8c2815))
* **oscar-household:** mint real servicebay-mcp token instead of unused env value ([6079a54](https://github.com/mdopp/servicebay/commit/6079a5492f375b862b23d77660394afa1fefccdc))


### Performance Improvements

* **ci:** optimize CI and release workflows with caching and removing redundant steps ([098ec7d](https://github.com/mdopp/servicebay/commit/098ec7d521bd852862a53e28a2404240cad15496))

## [4.25.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.24.8...servicebay-v4.25.0) (2026-05-25)


### Features

* **hermes:** add skills and notes volume mounts for Oscar Phase 3 ([1ade1c6](https://github.com/mdopp/servicebay/commit/1ade1c612f3724e3558f3f013e337b9778ad3cdc))
* **hermes:** fold OSCAR MVP into ServiceBay ([033b2c4](https://github.com/mdopp/servicebay/commit/033b2c4e60d2a2ea0ddd31e3439269dc794416e7))
* **hermes:** fold OSCAR MVP into ServiceBay ([a8b930d](https://github.com/mdopp/servicebay/commit/a8b930d251968031568d1a679f74962aa04117ad))
* **oscar:** add oscar-household template, post-deploy tests, and stack inclusion ([4720635](https://github.com/mdopp/servicebay/commit/4720635542126ff57a62ff26abe723c6a5d5fd67))

## [4.24.8](https://github.com/mdopp/servicebay/compare/servicebay-v4.24.7...servicebay-v4.24.8) (2026-05-25)


### Bug Fixes

* **fcos,scripts:** split NVIDIA install into 3 stages with reboot between each ([#919](https://github.com/mdopp/servicebay/issues/919)) ([d997b77](https://github.com/mdopp/servicebay/commit/d997b7765d87a148347ddd83833fd37184ca1036))

## [4.24.7](https://github.com/mdopp/servicebay/compare/servicebay-v4.24.6...servicebay-v4.24.7) (2026-05-24)


### Bug Fixes

* **media:** accept alreadySetup as a terminal success without requiring ok ([#917](https://github.com/mdopp/servicebay/issues/917)) ([3ff81e3](https://github.com/mdopp/servicebay/commit/3ff81e30daa1a4ef7694efa9ec432f2f0436bce7))

## [4.24.6](https://github.com/mdopp/servicebay/compare/servicebay-v4.24.5...servicebay-v4.24.6) (2026-05-24)


### Bug Fixes

* **install:** self-heal three more stale-data-dir regressions ([#915](https://github.com/mdopp/servicebay/issues/915)) ([031d897](https://github.com/mdopp/servicebay/commit/031d89722bc7a73ddeaaae2c27d80eebd52dfa86))

## [4.24.5](https://github.com/mdopp/servicebay/compare/servicebay-v4.24.4...servicebay-v4.24.5) (2026-05-24)


### Bug Fixes

* **install:** self-heal three reinstall regressions ([#912](https://github.com/mdopp/servicebay/issues/912)) ([a4ddaf0](https://github.com/mdopp/servicebay/commit/a4ddaf0a3d7fabd854c9facae8bafa344cf2de03))

## [4.24.4](https://github.com/mdopp/servicebay/compare/servicebay-v4.24.3...servicebay-v4.24.4) (2026-05-24)


### Bug Fixes

* **auth:** auto-grant LLDAP 'admin' the 'admins' group at install + smoke-test it ([#895](https://github.com/mdopp/servicebay/issues/895)) ([71ee3a3](https://github.com/mdopp/servicebay/commit/71ee3a398f37735c839f7a00fb06a0bdf67c3dcc))

## [4.24.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.24.2...servicebay-v4.24.3) (2026-05-24)


### Performance Improvements

* **build:** switch to Turbopack by splitting logger into client-safe stub ([#905](https://github.com/mdopp/servicebay/issues/905)) ([#907](https://github.com/mdopp/servicebay/issues/907)) ([0987c33](https://github.com/mdopp/servicebay/commit/0987c3327ea294feaaa607c3f3f5540b8d438d91))

## [4.24.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.24.1...servicebay-v4.24.2) (2026-05-24)


### Bug Fixes

* **ux:** comprehensive UX polish batch ([#903](https://github.com/mdopp/servicebay/issues/903)) ([b3cbbec](https://github.com/mdopp/servicebay/commit/b3cbbec97b2a00f97d809b5557ff2859313b8776))

## [4.24.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.24.0...servicebay-v4.24.1) (2026-05-23)


### Bug Fixes

* **network:** substitute 0.0.0.0 / 127.0.0.1 with the node's reachable IP ([#892](https://github.com/mdopp/servicebay/issues/892)) ([a72ea58](https://github.com/mdopp/servicebay/commit/a72ea58193f45d5144216bc7456d8cdfcc61c10a))

## [4.24.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.23.3...servicebay-v4.24.0) (2026-05-23)


### Features

* **hermes:** add user-guide.md so Hermes appears on /portal ([#889](https://github.com/mdopp/servicebay/issues/889)) ([601b13b](https://github.com/mdopp/servicebay/commit/601b13ba0755d8e6cf122c6961c0d95a7724e405))


### Bug Fixes

* **network:** declared edges carry target's primary port + HA→voice dep ([#890](https://github.com/mdopp/servicebay/issues/890)) ([97ab327](https://github.com/mdopp/servicebay/commit/97ab3273e339456fab0c7cf6d8225c63025c0285))

## [4.23.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.23.2...servicebay-v4.23.3) (2026-05-23)


### Bug Fixes

* **dashboard:** hide servicebay-splash from implicit-services path too ([#887](https://github.com/mdopp/servicebay/issues/887)) ([55f7998](https://github.com/mdopp/servicebay/commit/55f7998e5a5a1474eda12c1a379f03aeda2a89cc))

## [4.23.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.23.1...servicebay-v4.23.2) (2026-05-23)


### Bug Fixes

* **dashboard:** hide servicebay-splash from the services list ([#885](https://github.com/mdopp/servicebay/issues/885)) ([d1f6429](https://github.com/mdopp/servicebay/commit/d1f6429da60286099cbaa355ed62966f97cecd32))

## [4.23.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.23.0...servicebay-v4.23.1) (2026-05-23)


### Bug Fixes

* **home:** remove duplicate / route that broke the client manifest ([#879](https://github.com/mdopp/servicebay/issues/879)) ([#881](https://github.com/mdopp/servicebay/issues/881)) ([5689751](https://github.com/mdopp/servicebay/commit/5689751d408e3ebf7fd9fc0a63f3dd5b407261ab))
* **sync:** forward to 127.0.0.1 + disable host check on Syncthing ([#880](https://github.com/mdopp/servicebay/issues/880)) ([#882](https://github.com/mdopp/servicebay/issues/882)) ([8c4c45a](https://github.com/mdopp/servicebay/commit/8c4c45ac2f6f32c1bc7d21e8f0c905b26ffdf560))

## [4.23.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.22.0...servicebay-v4.23.0) (2026-05-23)


### Features

* **workspace:** extract WorkspaceDrawer foundation ([#804](https://github.com/mdopp/servicebay/issues/804)) ([#875](https://github.com/mdopp/servicebay/issues/875)) ([806cd49](https://github.com/mdopp/servicebay/commit/806cd49a9ebf5f9b7cdb1370df96bb697ae4bcc0))

## [4.22.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.21.0...servicebay-v4.22.0) (2026-05-23)


### Features

* **actions:** service-action buttons show Running… spinner + disable peers ([#805](https://github.com/mdopp/servicebay/issues/805)) ([#872](https://github.com/mdopp/servicebay/issues/872)) ([d051287](https://github.com/mdopp/servicebay/commit/d0512878f0edafa963b3e701d7f937b3355c30a9))
* **install:** emit image-pull progress log lines ([#805](https://github.com/mdopp/servicebay/issues/805)) ([#873](https://github.com/mdopp/servicebay/issues/873)) ([e573eea](https://github.com/mdopp/servicebay/commit/e573eeabec67bf5cafe9c965a351caa27cbbecbd))

## [4.21.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.20.0...servicebay-v4.21.0) (2026-05-23)


### Features

* **wizard:** per-service expandable rows in the install overlay ([#822](https://github.com/mdopp/servicebay/issues/822)) ([#869](https://github.com/mdopp/servicebay/issues/869)) ([aac39a5](https://github.com/mdopp/servicebay/commit/aac39a524f7c1010c817e9ec367c56dc8d095868))

## [4.20.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.19.0...servicebay-v4.20.0) (2026-05-23)


### Features

* Overview Dashboard at /, streamlined sidebar ([#802](https://github.com/mdopp/servicebay/issues/802), [#803](https://github.com/mdopp/servicebay/issues/803)) ([#867](https://github.com/mdopp/servicebay/issues/867)) ([9c4a506](https://github.com/mdopp/servicebay/commit/9c4a506a2d2b3dfe7eb2a678b8a3425098568649))

## [4.19.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.18.0...servicebay-v4.19.0) (2026-05-23)


### Features

* **network:** emit declared dependency edges from servicebay.dependencies ([#505](https://github.com/mdopp/servicebay/issues/505) PR-2) ([#862](https://github.com/mdopp/servicebay/issues/862)) ([b4602c3](https://github.com/mdopp/servicebay/commit/b4602c371d822a7ab54819d45609d94e70572b3d))

## [4.18.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.17.0...servicebay-v4.18.0) (2026-05-23)


### Features

* **network:** render observed vs declared edges distinctly ([#813](https://github.com/mdopp/servicebay/issues/813)) ([#860](https://github.com/mdopp/servicebay/issues/860)) ([205e255](https://github.com/mdopp/servicebay/commit/205e2559621515363fcd1c70ff8d9ee0028a279b))

## [4.17.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.16.2...servicebay-v4.17.0) (2026-05-23)


### Features

* **install,mcp:** MCP unmanaged-bundle tools + parallel image pre-pull [ARCH-14, perf] ([#852](https://github.com/mdopp/servicebay/issues/852)) ([901cf64](https://github.com/mdopp/servicebay/commit/901cf64dd112f49ce233826f6512ef290dbe4692))
* **install:** centralized reset-combo validation + selfHeal contracts + UI guardrail [ARCH-16a/17/16b] ([#850](https://github.com/mdopp/servicebay/issues/850)) ([32528dd](https://github.com/mdopp/servicebay/commit/32528dda00ec146922cfb9db322a6deedf725e4e))


### Bug Fixes

* **login:** guard socket + 401 redirects so /login doesn't loop ([#854](https://github.com/mdopp/servicebay/issues/854)) ([#855](https://github.com/mdopp/servicebay/issues/855)) ([0e0a789](https://github.com/mdopp/servicebay/commit/0e0a789943c91d22244115f4dbb5785a4e45c5d5))
* **ui:** read app version from /api/system/version ([#812](https://github.com/mdopp/servicebay/issues/812)) ([#856](https://github.com/mdopp/servicebay/issues/856)) ([65fd29b](https://github.com/mdopp/servicebay/commit/65fd29bec4f08c34df2fdad72efdbcf0c409989f))
* **wizard:** Finish button now closes the wizard reliably ([#811](https://github.com/mdopp/servicebay/issues/811)) ([#857](https://github.com/mdopp/servicebay/issues/857)) ([22d9c6e](https://github.com/mdopp/servicebay/commit/22d9c6e0e56abe7bff3675b8fe8bbed860c1869e))

## [4.16.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.16.1...servicebay-v4.16.2) (2026-05-22)


### Bug Fixes

* **install:** persist the credentials manifest to config.installManifest ([#839](https://github.com/mdopp/servicebay/issues/839)) ([64f6218](https://github.com/mdopp/servicebay/commit/64f6218f7a97459eab00d8f7c45dfde7ce90511e))

## [4.16.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.16.0...servicebay-v4.16.1) (2026-05-22)


### Bug Fixes

* **security:** reach host services via host.containers.internal, not LAN_IP ([#837](https://github.com/mdopp/servicebay/issues/837)) ([68406e1](https://github.com/mdopp/servicebay/commit/68406e1ba8f3ead5b601d49c98204fbe9ff624e1))

## [4.16.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.15.1...servicebay-v4.16.0) (2026-05-22)


### Features

* **hermes:** expose the web dashboard with a subdomain and portal card ([#834](https://github.com/mdopp/servicebay/issues/834)) ([57baa17](https://github.com/mdopp/servicebay/commit/57baa1708f1d17e540a7aecf0c547513ef585d35))


### Bug Fixes

* **adguard:** use /login.html for the healthcheck, not /control/status ([#835](https://github.com/mdopp/servicebay/issues/835)) ([98c9930](https://github.com/mdopp/servicebay/commit/98c99305441966201dd44c6529a5160cd1a4db92)), closes [#827](https://github.com/mdopp/servicebay/issues/827)
* **immich:** correct healthcheck endpoint to /api/server/ping ([#831](https://github.com/mdopp/servicebay/issues/831)) ([3e7dd5e](https://github.com/mdopp/servicebay/commit/3e7dd5ea787cb40844e1ba4cbeb2f7c6b1cf2cd4))

## [4.15.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.15.0...servicebay-v4.15.1) (2026-05-22)


### Bug Fixes

* **install:** emit only complete lines from exec_stream ([#828](https://github.com/mdopp/servicebay/issues/828)) ([431779a](https://github.com/mdopp/servicebay/commit/431779a9069f492d484f244e124153d0034d6650))

## [4.15.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.14.1...servicebay-v4.15.0) (2026-05-22)


### Features

* **network:** discover observed service↔service edges via ss ([#505](https://github.com/mdopp/servicebay/issues/505)) ([#823](https://github.com/mdopp/servicebay/issues/823)) ([b29043a](https://github.com/mdopp/servicebay/commit/b29043ad9fe9ec847388b09c68acbc342aec2f50))

## [4.14.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.14.0...servicebay-v4.14.1) (2026-05-22)


### Bug Fixes

* **ui:** redirect to /login when the realtime socket is rejected as unauthorized ([#820](https://github.com/mdopp/servicebay/issues/820)) ([dce4e8a](https://github.com/mdopp/servicebay/commit/dce4e8a8da98eda619edf13877d7ac3f4dc3661e))

## [4.14.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.13.2...servicebay-v4.14.0) (2026-05-22)


### Features

* **templates:** add claude-dev stack — containerised Claude Code CLI ([#779](https://github.com/mdopp/servicebay/issues/779)) ([#815](https://github.com/mdopp/servicebay/issues/815)) ([77021af](https://github.com/mdopp/servicebay/commit/77021af1b0f26d3f3eaf9408dcd989cd3793d50f))


### Bug Fixes

* **install:** readiness gating + per-service proxy hosts ([#807](https://github.com/mdopp/servicebay/issues/807), [#808](https://github.com/mdopp/servicebay/issues/808), [#809](https://github.com/mdopp/servicebay/issues/809), [#810](https://github.com/mdopp/servicebay/issues/810)) ([#814](https://github.com/mdopp/servicebay/issues/814)) ([0d73981](https://github.com/mdopp/servicebay/commit/0d73981fe2bd03c483f09d99a1b32f99855a839a))

## [4.13.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.13.1...servicebay-v4.13.2) (2026-05-22)


### Bug Fixes

* **install:** topo-sort installs all infrastructure tier before any feature ([#796](https://github.com/mdopp/servicebay/issues/796)) ([#797](https://github.com/mdopp/servicebay/issues/797)) ([d0e1e0b](https://github.com/mdopp/servicebay/commit/d0e1e0bf86c1ff48a3976a880be0dfebd48ef930))

## [4.13.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.13.0...servicebay-v4.13.1) (2026-05-21)


### Reverts

* **frontend:** drop Storybook integration; keep mock-layer ([#753](https://github.com/mdopp/servicebay/issues/753)) ([#794](https://github.com/mdopp/servicebay/issues/794)) ([03cb7f0](https://github.com/mdopp/servicebay/commit/03cb7f0ce3da5ee5898845aee574da1dc8cb450e))

## [4.13.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.12.0...servicebay-v4.13.0) (2026-05-21)


### Features

* **frontend:** Phase 4 — Storybook + node: prefix sweep ([#753](https://github.com/mdopp/servicebay/issues/753)) ([#790](https://github.com/mdopp/servicebay/issues/790)) ([4e0261f](https://github.com/mdopp/servicebay/commit/4e0261f8ea60246e0aa7638525c2b40f55378d94))

## [4.12.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.11.4...servicebay-v4.12.0) (2026-05-21)


### Features

* **frontend:** Phase 4 foundation — MSW mock layer + dev:frontend script ([#753](https://github.com/mdopp/servicebay/issues/753)) ([#787](https://github.com/mdopp/servicebay/issues/787)) ([f90cfc5](https://github.com/mdopp/servicebay/commit/f90cfc5e0220457555e7c3cd5390cb2f12cc13a7))
* **install:** boot-time splash page so cold-boot windows aren't silent ([#775](https://github.com/mdopp/servicebay/issues/775)) ([#784](https://github.com/mdopp/servicebay/issues/784)) ([e65f33a](https://github.com/mdopp/servicebay/commit/e65f33a000c3ca76d67dadd5b36def1368e830d4))


### Bug Fixes

* **diagnose:** make OIDC probe send proxied-traffic headers + scope log classifier to current process ([#781](https://github.com/mdopp/servicebay/issues/781)) ([#782](https://github.com/mdopp/servicebay/issues/782)) ([f8fad5e](https://github.com/mdopp/servicebay/commit/f8fad5e632f28f1431af6b402b6871df12d56cd7))
* **install,secrets:** preserve secret.key across reinstalls + fail-loud on key mismatch ([#780](https://github.com/mdopp/servicebay/issues/780)) ([#783](https://github.com/mdopp/servicebay/issues/783)) ([eaf42a3](https://github.com/mdopp/servicebay/commit/eaf42a394ad08a60414b01ea422de8030e5998a1))

## [4.11.4](https://github.com/mdopp/servicebay/compare/servicebay-v4.11.3...servicebay-v4.11.4) (2026-05-21)


### Bug Fixes

* **agent:** only replace sentinel inside `r\"\"\"…\"\"\"`, not in comments ([#777](https://github.com/mdopp/servicebay/issues/777)) ([77de987](https://github.com/mdopp/servicebay/commit/77de987dcb0407f010fd9c408a41d47e3a07aab9))

## [4.11.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.11.2...servicebay-v4.11.3) (2026-05-21)


### Bug Fixes

* **install:** guard indirect expansion against set -u ([#773](https://github.com/mdopp/servicebay/issues/773)) ([cb2a2f8](https://github.com/mdopp/servicebay/commit/cb2a2f83eac9ad6e420c9f4925411f30f375c23b))

## [4.11.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.11.1...servicebay-v4.11.2) (2026-05-21)


### Bug Fixes

* **docker:** install workspace prod deps + allow pre-seeded install secrets ([#771](https://github.com/mdopp/servicebay/issues/771)) ([cacef33](https://github.com/mdopp/servicebay/commit/cacef33c1088a441b2c88c1a20c9adeabdbfca5f))

## [4.11.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.11.0...servicebay-v4.11.1) (2026-05-21)


### Bug Fixes

* **docker:** point agent COPY at new package + ship scripts dir ([#770](https://github.com/mdopp/servicebay/issues/770)) ([b832039](https://github.com/mdopp/servicebay/commit/b8320391e976b5d42663dee1ab438ae9dc458eec))
* **test:** bump RTL asyncUtilTimeout to 10s ([#757](https://github.com/mdopp/servicebay/issues/757)) ([#768](https://github.com/mdopp/servicebay/issues/768)) ([5f02376](https://github.com/mdopp/servicebay/commit/5f0237629526accd07367f494af672b97938dad8))

## [4.11.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.10.0...servicebay-v4.11.0) (2026-05-20)


### Features

* **wizard:** mobile-responsive layout ([#718](https://github.com/mdopp/servicebay/issues/718)) ([#751](https://github.com/mdopp/servicebay/issues/751)) ([dfd4b4a](https://github.com/mdopp/servicebay/commit/dfd4b4aac4c4e2966501526524731f3907a4be7a))

## [4.10.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.9.0...servicebay-v4.10.0) (2026-05-20)


### Features

* **agent:** structured safe_exec dispatcher + TS execSafe ([#722](https://github.com/mdopp/servicebay/issues/722)) ([#743](https://github.com/mdopp/servicebay/issues/743)) ([a6ec7d1](https://github.com/mdopp/servicebay/commit/a6ec7d19941b43fcc5419c37c11f842d57904f6f))
* **dashboards:** phased hydration gate for /services and /containers ([#737](https://github.com/mdopp/servicebay/issues/737)) ([#745](https://github.com/mdopp/servicebay/issues/745)) ([78fc300](https://github.com/mdopp/servicebay/commit/78fc3001c1683b8f0319041d67d311dc28d63964))
* **wizard,ux:** observability + UX batch ([#732](https://github.com/mdopp/servicebay/issues/732) [#729](https://github.com/mdopp/servicebay/issues/729) [#728](https://github.com/mdopp/servicebay/issues/728) [#727](https://github.com/mdopp/servicebay/issues/727)) ([#740](https://github.com/mdopp/servicebay/issues/740)) ([4e4495f](https://github.com/mdopp/servicebay/commit/4e4495f7eddd29290c1fc0db47cf93209338f70d))
* **wizard:** FRITZ!Box prerequisite + Verify connection ([#726](https://github.com/mdopp/servicebay/issues/726)) ([#742](https://github.com/mdopp/servicebay/issues/742)) ([bc2a97d](https://github.com/mdopp/servicebay/commit/bc2a97df3168e4fc3f7c19fbe2f9cd39ba0de0e0))


### Bug Fixes

* diagnose + media + install copy batch ([#736](https://github.com/mdopp/servicebay/issues/736) [#735](https://github.com/mdopp/servicebay/issues/735) [#734](https://github.com/mdopp/servicebay/issues/734) [#733](https://github.com/mdopp/servicebay/issues/733) [#725](https://github.com/mdopp/servicebay/issues/725)) ([#738](https://github.com/mdopp/servicebay/issues/738)) ([040fc15](https://github.com/mdopp/servicebay/commit/040fc158017e1ed0ed7ece578531200aa33f6952))
* **install:** scrub config.json under the in-process lock ([#711](https://github.com/mdopp/servicebay/issues/711)) ([#739](https://github.com/mdopp/servicebay/issues/739)) ([cf4093c](https://github.com/mdopp/servicebay/commit/cf4093ce2882c6e57dfc1bd67ad25a51e4056532))
* **wizard:** surface stacksOnlyMode in the header ([#690](https://github.com/mdopp/servicebay/issues/690)) ([#741](https://github.com/mdopp/servicebay/issues/741)) ([176778c](https://github.com/mdopp/servicebay/commit/176778ce773f26b036757ea452e6ff2ee9abdf00))

## [4.9.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.8.2...servicebay-v4.9.0) (2026-05-20)


### Features

* wizard split + stability batch ([#693](https://github.com/mdopp/servicebay/issues/693) [#686](https://github.com/mdopp/servicebay/issues/686) [#694](https://github.com/mdopp/servicebay/issues/694) [#696](https://github.com/mdopp/servicebay/issues/696) [#714](https://github.com/mdopp/servicebay/issues/714) [#715](https://github.com/mdopp/servicebay/issues/715) [#716](https://github.com/mdopp/servicebay/issues/716) [#717](https://github.com/mdopp/servicebay/issues/717) [#730](https://github.com/mdopp/servicebay/issues/730)) ([#731](https://github.com/mdopp/servicebay/issues/731)) ([8b7641c](https://github.com/mdopp/servicebay/commit/8b7641cb9c5493177e9591e7a4773b9b39f16ef3))


### Bug Fixes

* **hermes:** use args: gateway run, not command: nor empty ([#706](https://github.com/mdopp/servicebay/issues/706) followup) ([#712](https://github.com/mdopp/servicebay/issues/712)) ([0b0a905](https://github.com/mdopp/servicebay/commit/0b0a9051fbc5c7ccfb0fae1a8ac7ffcf6dd76884))
* **install:** abort cleanInstall when reset call fails ([#710](https://github.com/mdopp/servicebay/issues/710)) ([a7310ff](https://github.com/mdopp/servicebay/commit/a7310ffe98a6477be16e9fc1572697415d2139b7))

## [4.8.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.8.1...servicebay-v4.8.2) (2026-05-19)


### Bug Fixes

* **install:** cascade-bug batch — wipe scope, NPM drift, hermes, state, DNS ([#708](https://github.com/mdopp/servicebay/issues/708)) ([38f398b](https://github.com/mdopp/servicebay/commit/38f398b990971b1e9f0f50bc86cffb879ff6daaa))

## [4.8.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.8.0...servicebay-v4.8.1) (2026-05-19)


### Bug Fixes

* **stacks:** README checklist format so wizard parses templates ([#699](https://github.com/mdopp/servicebay/issues/699)) ([066b8f3](https://github.com/mdopp/servicebay/commit/066b8f33bd2af26318e67d948c658a962740e399))

## [4.8.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.7.1...servicebay-v4.8.0) (2026-05-19)


### Features

* **install:** NVIDIA GPU layer — Butane unit + standalone script ([#682](https://github.com/mdopp/servicebay/issues/682)) ([62e8f1b](https://github.com/mdopp/servicebay/commit/62e8f1b4512ec974692dcb42f38fc67758a2e101))
* **wizard:** multi-select stack picker + install-another loop ([#683](https://github.com/mdopp/servicebay/issues/683)) ([678f221](https://github.com/mdopp/servicebay/commit/678f22139795b0fa6c3b545503300c214d80bc04))


### Bug Fixes

* **install:** clean-install actually redeploys preserved services ([#698](https://github.com/mdopp/servicebay/issues/698)) ([4136a34](https://github.com/mdopp/servicebay/commit/4136a34f54427353c8a8f6ecf06b137d8ef46e0b))
* **wizard:** quick-win batch for 5 UX papercuts ([#697](https://github.com/mdopp/servicebay/issues/697)) ([323252b](https://github.com/mdopp/servicebay/commit/323252b873eb380bfb57f2a6d6539501d06aef8d))

## [4.7.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.7.0...servicebay-v4.7.1) (2026-05-19)


### Bug Fixes

* **install:** escape %s in AUTH_SECRET init systemd unit ([#679](https://github.com/mdopp/servicebay/issues/679)) ([531c20a](https://github.com/mdopp/servicebay/commit/531c20a48f74c6160c33cbe47ef015f2c93a19cc))

## [4.7.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.6.0...servicebay-v4.7.0) (2026-05-19)


### Features

* **banner:** explain core-stack-unhealthy with a causal chain ([#665](https://github.com/mdopp/servicebay/issues/665)) ([#678](https://github.com/mdopp/servicebay/issues/678)) ([b6b286e](https://github.com/mdopp/servicebay/commit/b6b286e4eab752891a1c9229282862d0c836df4c))
* **diagnose:** distinguish missing-prereq from pending-schedule ([#664](https://github.com/mdopp/servicebay/issues/664)) ([#677](https://github.com/mdopp/servicebay/issues/677)) ([ef225be](https://github.com/mdopp/servicebay/commit/ef225be32a98847fffc6953ee966b6356531dee2))
* **install:** preview stale proxy routes in clean-install confirm ([#667](https://github.com/mdopp/servicebay/issues/667)) ([#675](https://github.com/mdopp/servicebay/issues/675)) ([af7cc58](https://github.com/mdopp/servicebay/commit/af7cc58b579844745acfb8018293ff6e8d9a148a))
* **install:** public progress endpoint survives AUTH_SECRET rotation ([#663](https://github.com/mdopp/servicebay/issues/663)) ([#676](https://github.com/mdopp/servicebay/issues/676)) ([bd787fd](https://github.com/mdopp/servicebay/commit/bd787fd919143d424f6368e56861cfd2eb253f26))
* **install:** warn about dangerous wipe-group combinations ([#668](https://github.com/mdopp/servicebay/issues/668)) ([#674](https://github.com/mdopp/servicebay/issues/674)) ([30c027c](https://github.com/mdopp/servicebay/commit/30c027cee45bfe25484cbb1e3a02da5c609dfad8))
* **wizard:** capture publicDomain in network step ([#662](https://github.com/mdopp/servicebay/issues/662)) ([#673](https://github.com/mdopp/servicebay/issues/673)) ([4c1707a](https://github.com/mdopp/servicebay/commit/4c1707ad48b234f14d83f6b27c2028a64282e471))


### Bug Fixes

* **diagnose:** surface actual error on 'Containers stable' probe failure ([#661](https://github.com/mdopp/servicebay/issues/661)) ([#670](https://github.com/mdopp/servicebay/issues/670)) ([627c411](https://github.com/mdopp/servicebay/commit/627c411d213093083d9e9762526d6257c6d003d5))
* **install:** capture LAN IP synchronously in runner, not boot-timer ([#660](https://github.com/mdopp/servicebay/issues/660)) ([#669](https://github.com/mdopp/servicebay/issues/669)) ([dd4c0e3](https://github.com/mdopp/servicebay/commit/dd4c0e3c022d7dcdcdb3d8f5fef589b9c6f0ae9a))

## [4.6.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.5.0...servicebay-v4.6.0) (2026-05-19)


### Features

* **diagnose:** HTTP-status check on every public domain ([#611](https://github.com/mdopp/servicebay/issues/611)) ([#658](https://github.com/mdopp/servicebay/issues/658)) ([7797ee1](https://github.com/mdopp/servicebay/commit/7797ee1495f27210237f70d4526ee4e3f839226b))

## [4.5.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.4.0...servicebay-v4.5.0) (2026-05-19)


### Features

* **capabilities:** AdGuard DNS + credentials manifest handlers ([#631](https://github.com/mdopp/servicebay/issues/631)) ([#645](https://github.com/mdopp/servicebay/issues/645)) ([e90e304](https://github.com/mdopp/servicebay/commit/e90e3048bbc4c92f6be20f38041c2a67fdc79cc9))
* **capabilities:** Authelia + NPM handlers ([#630](https://github.com/mdopp/servicebay/issues/630)) ([#643](https://github.com/mdopp/servicebay/issues/643)) ([8f24f75](https://github.com/mdopp/servicebay/commit/8f24f75269c36ab753d2590f71ee3c502d64a697))
* **health:** delete readiness subsystem; healthcheck is the only signal ([#628](https://github.com/mdopp/servicebay/issues/628)) ([#649](https://github.com/mdopp/servicebay/issues/649)) ([16e89e9](https://github.com/mdopp/servicebay/commit/16e89e9070a9eb8607b6b63ef0b3bfecf8b7bc45))
* **health:** migrate settleWait + add CoreHealthBanner reader ([#627](https://github.com/mdopp/servicebay/issues/627)) ([#648](https://github.com/mdopp/servicebay/issues/648)) ([a0cd847](https://github.com/mdopp/servicebay/commit/a0cd847300f1c9474415e33240dbe1338c093cfe))
* **install:** cut runner.ts over to capability bus events ([#632](https://github.com/mdopp/servicebay/issues/632)) ([#646](https://github.com/mdopp/servicebay/issues/646)) ([2a9d244](https://github.com/mdopp/servicebay/commit/2a9d24459e91b374fa2d62131d1285a50e4438ff))
* **install:** stack runner + stack-level health aggregation ([#633](https://github.com/mdopp/servicebay/issues/633)) ([#650](https://github.com/mdopp/servicebay/issues/650)) ([bb0c0cb](https://github.com/mdopp/servicebay/commit/bb0c0cb21213cdb91e42d8b9f11d99199b254740))
* **install:** tier gate refuses feature install on degraded core ([#635](https://github.com/mdopp/servicebay/issues/635)) ([#652](https://github.com/mdopp/servicebay/issues/652)) ([82e831d](https://github.com/mdopp/servicebay/commit/82e831d2c2b864016076123b9aec20d118c35370))
* **stacks:** migrate existing templates to stack manifests ([#625](https://github.com/mdopp/servicebay/issues/625)) ([#647](https://github.com/mdopp/servicebay/issues/647)) ([461cb7a](https://github.com/mdopp/servicebay/commit/461cb7a2739681ea5aa33fbaf607bb7dfd7708e6))
* **stacks:** stack list/status/wipe API + StackCard + Settings → Stacks ([#634](https://github.com/mdopp/servicebay/issues/634)) ([#651](https://github.com/mdopp/servicebay/issues/651)) ([fb0e8d0](https://github.com/mdopp/servicebay/commit/fb0e8d0a865466c40fe2a7cba0bfb67cb6292d39))

## [4.4.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.3.0...servicebay-v4.4.0) (2026-05-19)


### Features

* **capabilities:** typed in-process capability bus core ([#629](https://github.com/mdopp/servicebay/issues/629)) ([#641](https://github.com/mdopp/servicebay/issues/641)) ([44624ca](https://github.com/mdopp/servicebay/commit/44624ca8537010261c355b51488e98045be66176))
* **health:** servicebay.healthcheck annotation + poller → twin.health ([#626](https://github.com/mdopp/servicebay/issues/626)) ([#640](https://github.com/mdopp/servicebay/issues/640)) ([af12c0e](https://github.com/mdopp/servicebay/commit/af12c0ef6f4ebccf742472ae522033bc3b3ef6f0))

## [4.3.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.2.3...servicebay-v4.3.0) (2026-05-18)


### Features

* **install:** persist install secrets at first generation ([#622](https://github.com/mdopp/servicebay/issues/622)) ([#636](https://github.com/mdopp/servicebay/issues/636)) ([d465b3d](https://github.com/mdopp/servicebay/commit/d465b3daa7b95138f4266ec673c24f9f976f60cd))
* **settings:** factory-reset UI + clear saved credentials ([#623](https://github.com/mdopp/servicebay/issues/623)) ([#637](https://github.com/mdopp/servicebay/issues/637)) ([b7bd1a6](https://github.com/mdopp/servicebay/commit/b7bd1a611284494d4419481e111bac12413e871b))
* **stacks:** stack.yml manifest schema + parser + consistency lint ([#624](https://github.com/mdopp/servicebay/issues/624)) ([#638](https://github.com/mdopp/servicebay/issues/638)) ([00ce955](https://github.com/mdopp/servicebay/commit/00ce95594033ceac4b856f34b966c0d0bcc60a21))

## [4.2.3](https://github.com/mdopp/servicebay/compare/servicebay-v4.2.2...servicebay-v4.2.3) (2026-05-18)


### Bug Fixes

* **install:** self-heal Authelia storage when encryption key isn't reused ([#619](https://github.com/mdopp/servicebay/issues/619)) ([2a173fe](https://github.com/mdopp/servicebay/commit/2a173fe4d04349b596faa128f943d8a90104d65f))

## [4.2.2](https://github.com/mdopp/servicebay/compare/servicebay-v4.2.1...servicebay-v4.2.2) (2026-05-18)


### Bug Fixes

* **install:** NPM readiness probe accepts 400 alongside 401 ([#617](https://github.com/mdopp/servicebay/issues/617)) ([5e124e7](https://github.com/mdopp/servicebay/commit/5e124e7f19b2d7dfa7e4a3f3b165a52b6bdb86a6))

## [4.2.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.2.0...servicebay-v4.2.1) (2026-05-18)


### Bug Fixes

* **install:** reuse saved secrets across clean installs that preserve identity ([#615](https://github.com/mdopp/servicebay/issues/615)) ([69d113d](https://github.com/mdopp/servicebay/commit/69d113d0b167e5eda05ba6b584e1790a1a1df1fe))

## [4.2.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.1.0...servicebay-v4.2.0) (2026-05-18)


### Features

* **install:** declarative readiness checks — closes [#613](https://github.com/mdopp/servicebay/issues/613) ([#614](https://github.com/mdopp/servicebay/issues/614)) ([053d9b6](https://github.com/mdopp/servicebay/commit/053d9b6d87aaa01b93bb2bf26658a758982cc778))


### Bug Fixes

* **lldap:** correct paths + podman-unshare in the seed-rejection hint ([e80e496](https://github.com/mdopp/servicebay/commit/e80e496262edea67cc83296ce47bed147d955955))

## [4.1.0](https://github.com/mdopp/servicebay/compare/servicebay-v4.0.1...servicebay-v4.1.0) (2026-05-18)


### Features

* **diagnose:** oidc_provider_reachable probe — closes the SSO blind spot ([f3c8dee](https://github.com/mdopp/servicebay/commit/f3c8dee64d5e6c9c6349d829426c537b9a863927))

## [4.0.1](https://github.com/mdopp/servicebay/compare/servicebay-v4.0.0...servicebay-v4.0.1) (2026-05-18)


### Bug Fixes

* **diagnose:** crash_loop probe checks RestartCount, not just ps Status ([5723e57](https://github.com/mdopp/servicebay/commit/5723e57e41d9d92bdfab5bc179ab6a0985ff8841))
* **media:** wait for Jellyfin's default user before /Startup/User ([c007162](https://github.com/mdopp/servicebay/commit/c007162fd9eb1f2edf8183cbb0f9cb7d30f82f7a))

## [4.0.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.47.0...servicebay-v4.0.0) (2026-05-18)


### ⚠ BREAKING CHANGES

* **media:** swap Navidrome for Jellyfin (Quick Connect for mobile SSO)

### Features

* **media:** swap Navidrome for Jellyfin (Quick Connect for mobile SSO) ([65663e6](https://github.com/mdopp/servicebay/commit/65663e671d0710769aecadc9f8681ed0d835243f))


### Bug Fixes

* **home-assistant:** declare token_endpoint_auth_method=client_secret_post ([5b1fa11](https://github.com/mdopp/servicebay/commit/5b1fa1171da74b8cfe16c030da76a01640bb67fb))
* **immich:** register app.immich:///oauth-callback for Android sign-in ([df0402f](https://github.com/mdopp/servicebay/commit/df0402f7bb273e83e18e53e47a849d247a593844))

## [3.47.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.46.3...servicebay-v3.47.0) (2026-05-18)


### Features

* **notifications:** send-test-email button in Email Notifications settings ([c384318](https://github.com/mdopp/servicebay/commit/c384318383005020cb703439d06cc76ad41716b1))


### Bug Fixes

* **health:** show FAIL rows in red and expand long messages on demand ([b7ced02](https://github.com/mdopp/servicebay/commit/b7ced02a39e6285d45523e8c4adfb48f664791ab))

## [3.46.3](https://github.com/mdopp/servicebay/compare/servicebay-v3.46.2...servicebay-v3.46.3) (2026-05-18)


### Bug Fixes

* **agent:** pipe stdin + timeout from exec payload to the subprocess ([c3bf3e9](https://github.com/mdopp/servicebay/commit/c3bf3e9f432bc62805c465fdd2aed629b309962b))

## [3.46.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.46.1...servicebay-v3.46.2) (2026-05-18)


### Bug Fixes

* **agent:** push proxy updates under proxyRoutes key, not legacy 'proxy' ([a581af7](https://github.com/mdopp/servicebay/commit/a581af73736e630208d29450317723712a5af503))

## [3.46.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.46.0...servicebay-v3.46.1) (2026-05-18)


### Bug Fixes

* **banner:** restore banner hangs at "2 of 3" — count only managed services ([b1ecb61](https://github.com/mdopp/servicebay/commit/b1ecb61821286ce26c21bec0b7f165c754777c1e))
* **services:** replace this.* with explicit class refs in lifecycle/listing ([d9a7897](https://github.com/mdopp/servicebay/commit/d9a78975e0d4abbd655fedf9a0e93629f7d63f72))

## [3.46.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.45.0...servicebay-v3.46.0) (2026-05-17)


### Features

* **errors:** typed DomainError hierarchy for SSH + AgentTimeout ([#598](https://github.com/mdopp/servicebay/issues/598)) ([c3bde25](https://github.com/mdopp/servicebay/commit/c3bde258c2500881a0d432a300513ad425cd4f56))
* **logger:** persist trace_id alongside log lines ([#597](https://github.com/mdopp/servicebay/issues/597)) ([1254a87](https://github.com/mdopp/servicebay/commit/1254a87d3d5cd3c4adc671b76146884bc3315fa0))
* **mcp:** split exec scope, downgrade update_config to mutate ([#591](https://github.com/mdopp/servicebay/issues/591)) ([f4d6304](https://github.com/mdopp/servicebay/commit/f4d63044ddfd1c0c23caacda7b15897f812d8b9f))
* **observability:** request-scoped trace IDs via AsyncLocalStorage ([#594](https://github.com/mdopp/servicebay/issues/594)) ([297a1af](https://github.com/mdopp/servicebay/commit/297a1afd99f2f04bb7e771453257b6b423a56b25))
* **security:** per-route requireSession() on every mutating handler ([#596](https://github.com/mdopp/servicebay/issues/596)) ([d328415](https://github.com/mdopp/servicebay/commit/d328415a5b670de85b0484943297dff41bcbb499))
* **settings:** enforce AppConfigSchema (Zod) on POST ([#595](https://github.com/mdopp/servicebay/issues/595)) ([4c3b5c0](https://github.com/mdopp/servicebay/commit/4c3b5c08e3e09c432d0495dd2d42f8f75b448750))
* **template:** add requiresApi version pinning for /api/system/* ([#588](https://github.com/mdopp/servicebay/issues/588)) ([13e41a3](https://github.com/mdopp/servicebay/commit/13e41a34b8ec79de5f777a495e343b07f7e720c5))


### Bug Fixes

* **auth:** validate OIDC issuer + stop logging response bodies ([#577](https://github.com/mdopp/servicebay/issues/577)) ([e101188](https://github.com/mdopp/servicebay/commit/e1011881c7618b35e5ae6fb7661b4d789589e5eb))
* **backup:** refuse symlinks at restore pre-check ([#590](https://github.com/mdopp/servicebay/issues/590), Option B) ([33a20cf](https://github.com/mdopp/servicebay/commit/33a20cf172ea6003212d0d1f2d7c5c80f71b5890))
* **backup:** safe tar extraction with traversal + symlink guards ([#580](https://github.com/mdopp/servicebay/issues/580)) ([d5de3ff](https://github.com/mdopp/servicebay/commit/d5de3fff68bec5638f50ebc9d034938dd498684f))
* **fritzbox:** reject loopback / link-local hosts ([#578](https://github.com/mdopp/servicebay/issues/578)) ([e9884d0](https://github.com/mdopp/servicebay/commit/e9884d03ec980c5f2ca30521885c9c0b895dffc3))
* **install:** drop cross-scope Requires= that blocked fresh boots ([#586](https://github.com/mdopp/servicebay/issues/586)) ([0d63622](https://github.com/mdopp/servicebay/commit/0d6362248822075dc18c67db449f3d2bc8b45a04))
* **install:** reuse saved NPM creds instead of prompting with rejected pwd ([bf09e5d](https://github.com/mdopp/servicebay/commit/bf09e5d26656b8e83e6fd7b159fa6b784831f924))
* **install:** show honest "kept" size + model quadlet-backup as own group ([d361c4a](https://github.com/mdopp/servicebay/commit/d361c4af03b5a2f5321b38885a628e8025bc4ca8))
* **mcp:** redact backtick / multi-line YAML / URL-query secrets ([#581](https://github.com/mdopp/servicebay/issues/581)) ([c0ddee5](https://github.com/mdopp/servicebay/commit/c0ddee569be519bae46a069d2016d23d34486e69))
* **wizard:** clearer error message + lint guard for stack lookups ([#582](https://github.com/mdopp/servicebay/issues/582)) ([fc13c5e](https://github.com/mdopp/servicebay/commit/fc13c5ef96f982e21c542bfcae55f3cfc26068d4))

## [3.45.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.44.0...servicebay-v3.45.0) (2026-05-17)


### Features

* **diagnose:** low-priority polish on the remaining 4 probes ([#547](https://github.com/mdopp/servicebay/issues/547)) ([#575](https://github.com/mdopp/servicebay/issues/575)) ([05a7666](https://github.com/mdopp/servicebay/commit/05a7666bfd3173be2c546f083615530e949612e1))

## [3.44.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.43.0...servicebay-v3.44.0) (2026-05-17)


### Features

* **diagnose:** pattern-aware audit on cert_request_failure + domain_external_reachability ([#547](https://github.com/mdopp/servicebay/issues/547)) ([#573](https://github.com/mdopp/servicebay/issues/573)) ([b52916d](https://github.com/mdopp/servicebay/commit/b52916d75efffa2d5af95dea50b0cabaf9413f9a))

## [3.43.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.42.1...servicebay-v3.43.0) (2026-05-17)


### Features

* **install:** granular preserve per group on Clean install ([#568](https://github.com/mdopp/servicebay/issues/568)) ([#571](https://github.com/mdopp/servicebay/issues/571)) ([01b8587](https://github.com/mdopp/servicebay/commit/01b85877985e19d1ecfcde5c9c42ca7a06ac3eab))

## [3.42.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.42.0...servicebay-v3.42.1) (2026-05-17)


### Bug Fixes

* **install:** pre-reinstall batch — AUTH_SECRET, cert reuse, Authelia auth-request, exposure: internal, Z-Wave udev, mobile Setup icon ([#567](https://github.com/mdopp/servicebay/issues/567)) ([1a7c44b](https://github.com/mdopp/servicebay/commit/1a7c44b0cde3e047e9a8cdb3d41ce8815270e9cf))

## [3.42.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.41.1...servicebay-v3.42.0) (2026-05-17)


### Features

* ai-stack templates (ollama + hermes) + logging/health-check docs ([#544](https://github.com/mdopp/servicebay/issues/544)) ([4c71ec4](https://github.com/mdopp/servicebay/commit/4c71ec42572c26cff22c11d26f8d81bca20bf00b))
* **diagnose:** inline fix actions on domain_unreachable items ([#551](https://github.com/mdopp/servicebay/issues/551)) ([0fcd1fa](https://github.com/mdopp/servicebay/commit/0fcd1fa6b262f92c4d80328accc470a414c611a3))
* **diagnose:** list specific rewrites in adguard_rewrites_missing OK message ([#553](https://github.com/mdopp/servicebay/issues/553)) ([1884b9c](https://github.com/mdopp/servicebay/commit/1884b9c97cedc2e776ae58a0e6a1a96a3ad44229))
* **diagnose:** reconcile + DHCP-reservation actions on lan_ip_changed ([#552](https://github.com/mdopp/servicebay/issues/552)) ([2898f3e](https://github.com/mdopp/servicebay/commit/2898f3e5c79e528af64e7fba8e2ee44f598c2d9a))
* **diagnose:** router-DNS probe recognises FritzBox-as-upstream pattern ([#546](https://github.com/mdopp/servicebay/issues/546)) ([37c414c](https://github.com/mdopp/servicebay/commit/37c414c87f22f968b614f3b0a1fbc72c35662be3))


### Bug Fixes

* **home-assistant:** default OIDC group names to match LLDAP seed ([#563](https://github.com/mdopp/servicebay/issues/563)) ([3c3b49d](https://github.com/mdopp/servicebay/commit/3c3b49dd93e78004205c6d140d06e32ab9e0486a))
* **lldap:** deep-link + sidebar URL find proxy host by port, not by service name ([#554](https://github.com/mdopp/servicebay/issues/554)) ([eadcabc](https://github.com/mdopp/servicebay/commit/eadcabc5cf74e71276e6272663f4797c390a16a3))
* **sso+portal:** batch of fixes for [#558](https://github.com/mdopp/servicebay/issues/558) [#559](https://github.com/mdopp/servicebay/issues/559) [#560](https://github.com/mdopp/servicebay/issues/560) [#561](https://github.com/mdopp/servicebay/issues/561) [#562](https://github.com/mdopp/servicebay/issues/562) ([#564](https://github.com/mdopp/servicebay/issues/564)) ([f837d1c](https://github.com/mdopp/servicebay/commit/f837d1c6afd0e357742d5256f1f07df0f3b3344c))
* **sso:** Authelia OIDC clients honour per-template token_endpoint_auth_method ([#555](https://github.com/mdopp/servicebay/issues/555)) ([2ad2404](https://github.com/mdopp/servicebay/commit/2ad2404f7da8048f1ae76f1a81a1f2d10576c859))

## [3.41.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.41.0...servicebay-v3.41.1) (2026-05-15)


### Bug Fixes

* **install:** wizard auto-open + NPM creds survive OS reinstall / clean-install ([#536](https://github.com/mdopp/servicebay/issues/536)) ([fd5fa83](https://github.com/mdopp/servicebay/commit/fd5fa83e9d228460b9c5801ff0cf2a1a63cbfc95))

## [3.41.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.40.9...servicebay-v3.41.0) (2026-05-15)


### Features

* **certs:** archive NPM data on reset + auto-restore on fresh install ([#534](https://github.com/mdopp/servicebay/issues/534)) ([bdf7395](https://github.com/mdopp/servicebay/commit/bdf73954dac3ccd567f63d6d4c06d49ca9bf999b))

## [3.40.9](https://github.com/mdopp/servicebay/compare/servicebay-v3.40.8...servicebay-v3.40.9) (2026-05-15)


### Bug Fixes

* **diagnose:** replace continuous letsdebug with DoH-based DNS routing ([#532](https://github.com/mdopp/servicebay/issues/532)) ([dac2cb6](https://github.com/mdopp/servicebay/commit/dac2cb6b1f42b0e65ed412abfd02f1f69a9ccbec))

## [3.40.8](https://github.com/mdopp/servicebay/compare/servicebay-v3.40.7...servicebay-v3.40.8) (2026-05-15)


### Bug Fixes

* **install:** auto-clear stackSetupPending on successful install ([#530](https://github.com/mdopp/servicebay/issues/530)) ([ec46cf0](https://github.com/mdopp/servicebay/commit/ec46cf0d8eab0f0897cfb378a8f83c711669e945))

## [3.40.7](https://github.com/mdopp/servicebay/compare/servicebay-v3.40.6...servicebay-v3.40.7) (2026-05-15)


### Bug Fixes

* **setup:** drop stale jobId pin so /setup picks up a new re-deploy ([#528](https://github.com/mdopp/servicebay/issues/528)) ([f378397](https://github.com/mdopp/servicebay/commit/f378397947bbd3a92b6dd2494013fdbf199e4649))

## [3.40.6](https://github.com/mdopp/servicebay/compare/servicebay-v3.40.5...servicebay-v3.40.6) (2026-05-15)


### Bug Fixes

* post-install polish (link scheme, device discovery, sidecar ports) ([#526](https://github.com/mdopp/servicebay/issues/526)) ([6cde339](https://github.com/mdopp/servicebay/commit/6cde33992b17bacde5daed07f3b01f1e239b9d9d))

## [3.40.5](https://github.com/mdopp/servicebay/compare/servicebay-v3.40.4...servicebay-v3.40.5) (2026-05-15)


### Bug Fixes

* **home-assistant:** pin auth_oidc default to v1.1.0 + quiet zwave restart race ([#524](https://github.com/mdopp/servicebay/issues/524)) ([b4e76c7](https://github.com/mdopp/servicebay/commit/b4e76c7f017ac7a4ecfd9e150d74dd57436533b6))

## [3.40.4](https://github.com/mdopp/servicebay/compare/servicebay-v3.40.3...servicebay-v3.40.4) (2026-05-15)


### Bug Fixes

* **home-assistant:** pin zwave-js WS port via ZWAVE_EXTERNAL_SETTINGS ([#522](https://github.com/mdopp/servicebay/issues/522)) ([95a7ee0](https://github.com/mdopp/servicebay/commit/95a7ee01e7f987a3b9aad9c4e4385ef613bcbeaa))

## [3.40.3](https://github.com/mdopp/servicebay/compare/servicebay-v3.40.2...servicebay-v3.40.3) (2026-05-15)


### Bug Fixes

* **installer:** hide Clean install on single-template re-deploys ([#520](https://github.com/mdopp/servicebay/issues/520)) ([c1c8f03](https://github.com/mdopp/servicebay/commit/c1c8f03e1f0593465d8375c409337498bb5119bc))

## [3.40.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.40.1...servicebay-v3.40.2) (2026-05-15)


### Bug Fixes

* **installer:** pass deployed services as dep satisfiers on single-template re-deploy ([#518](https://github.com/mdopp/servicebay/issues/518)) ([f952dd9](https://github.com/mdopp/servicebay/commit/f952dd92d24b1b9732d95ad08c6794c3ce35a8df))

## [3.40.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.40.0...servicebay-v3.40.1) (2026-05-15)


### Bug Fixes

* **installer:** auto-select node on single-node installs ([#516](https://github.com/mdopp/servicebay/issues/516)) ([106d1a3](https://github.com/mdopp/servicebay/commit/106d1a31227a79463cc52fe08e67062460fb7d6d))

## [3.40.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.39.0...servicebay-v3.40.0) (2026-05-15)


### Features

* **services:** one-click Update & restart from upgrade banner (closes [#510](https://github.com/mdopp/servicebay/issues/510)) ([#514](https://github.com/mdopp/servicebay/issues/514)) ([46303fa](https://github.com/mdopp/servicebay/commit/46303fa87e5ff5845c9faf61b0f6fdff0912291b))

## [3.39.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.38.0...servicebay-v3.39.0) (2026-05-15)


### Features

* **services:** surface pending template upgrades on the Services page (partial [#510](https://github.com/mdopp/servicebay/issues/510)) ([#512](https://github.com/mdopp/servicebay/issues/512)) ([127a715](https://github.com/mdopp/servicebay/commit/127a7150f1cbff3a17ac09f523e0c129e749439b))

## [3.38.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.37.0...servicebay-v3.38.0) (2026-05-14)


### Features

* **diagnose:** identify which container/service owns each unexpected port (closes [#497](https://github.com/mdopp/servicebay/issues/497)) ([#503](https://github.com/mdopp/servicebay/issues/503)) ([e2be224](https://github.com/mdopp/servicebay/commit/e2be224b0580b5d0f4f0768c781b7ac665bdde2c))
* **file-share:** per-user Samba accounts via LLDAP→tdbsam sync (closes [#494](https://github.com/mdopp/servicebay/issues/494)) ([#511](https://github.com/mdopp/servicebay/issues/511)) ([c0b94fb](https://github.com/mdopp/servicebay/commit/c0b94fbdbac3cb39cff932ecea57d3020b629d27))
* **home-assistant:** OIDC SSO via auth_oidc custom component (closes [#493](https://github.com/mdopp/servicebay/issues/493)) ([#509](https://github.com/mdopp/servicebay/issues/509)) ([c820ea5](https://github.com/mdopp/servicebay/commit/c820ea53ce063cab035e1abbc5c8bd9d1762e0e6))
* **reverse-proxy:** LAN→Public migration orchestrator + pre-flight (PR-1 of [#265](https://github.com/mdopp/servicebay/issues/265)) ([#506](https://github.com/mdopp/servicebay/issues/506)) ([fae2fe4](https://github.com/mdopp/servicebay/commit/fae2fe4ec35504971a629690d534d89acc88c698))
* **reverse-proxy:** UI for LAN→Public migration (PR-2 of [#265](https://github.com/mdopp/servicebay/issues/265)) ([#507](https://github.com/mdopp/servicebay/issues/507)) ([cec485e](https://github.com/mdopp/servicebay/commit/cec485e3ce98e2d710290182524b019141215ec6))
* **sso:** AdGuard + Syncthing admin UIs behind Authelia forward-auth (closes [#495](https://github.com/mdopp/servicebay/issues/495)) ([#508](https://github.com/mdopp/servicebay/issues/508)) ([bed9cbb](https://github.com/mdopp/servicebay/commit/bed9cbbea524d28dd6a1d69ad18232e4f461538a))


### Bug Fixes

* **health:** accept deterministic check IDs in history+run routes (closes [#498](https://github.com/mdopp/servicebay/issues/498)) ([#500](https://github.com/mdopp/servicebay/issues/500)) ([86b3c77](https://github.com/mdopp/servicebay/commit/86b3c775d148ea724abcae4bf311644b4e483755))
* **health:** npm_auth probe self-heals + refresh_now on Phase 3b probes (closes [#496](https://github.com/mdopp/servicebay/issues/496)) ([#502](https://github.com/mdopp/servicebay/issues/502)) ([95203d4](https://github.com/mdopp/servicebay/commit/95203d412abb8df1eaf81f0bd29f4127c62422c7))
* **health:** treat letsdebug `Complete + result:null` as a transport error (closes [#499](https://github.com/mdopp/servicebay/issues/499)) ([#501](https://github.com/mdopp/servicebay/issues/501)) ([dfe7873](https://github.com/mdopp/servicebay/commit/dfe78730e51d0e911a62001d3d9232f855faec57))

## [3.37.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.36.0...servicebay-v3.37.0) (2026-05-14)


### Features

* **diagnose:** live-update self-diagnose panel on health:update + fix dead 'pass' branch ([#490](https://github.com/mdopp/servicebay/issues/490)) ([7756514](https://github.com/mdopp/servicebay/commit/77565145fe0369959ce2c545c8ef774ae8d318ac))
* **health:** migrate cert_expiry, cert_request_failure, lan_ip, npm_auth into health-check types (Phase 3b, closes [#484](https://github.com/mdopp/servicebay/issues/484)) ([#492](https://github.com/mdopp/servicebay/issues/492)) ([cab591a](https://github.com/mdopp/servicebay/commit/cab591a043ddfe7a85fa9d9ab80fdc7938f8a239))

## [3.36.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.35.0...servicebay-v3.36.0) (2026-05-14)


### Features

* **health:** lift letsdebug into a real health-check type; diagnose probe becomes a thin reader ([#483](https://github.com/mdopp/servicebay/issues/483)) ([#488](https://github.com/mdopp/servicebay/issues/488)) ([cf10f13](https://github.com/mdopp/servicebay/commit/cf10f134f013a97830134bffa97e6392d7e9d281))

## [3.35.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.34.1...servicebay-v3.35.0) (2026-05-14)


### Features

* **diagnose:** per-row "Refresh now" + last-checked timestamp on letsdebug rows ([#482](https://github.com/mdopp/servicebay/issues/482), closes [#480](https://github.com/mdopp/servicebay/issues/480)) ([#485](https://github.com/mdopp/servicebay/issues/485)) ([d04c0d4](https://github.com/mdopp/servicebay/commit/d04c0d4ea90aa4981846c0502003f7eb1c9d2b3b))

## [3.34.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.34.0...servicebay-v3.34.1) (2026-05-14)


### Bug Fixes

* **letsdebug:** drop the 30s inter-submission delay — strict await serialises already ([#479](https://github.com/mdopp/servicebay/issues/479)) ([8e28407](https://github.com/mdopp/servicebay/commit/8e28407e28d3e7aea176d21cb90cd4ab662e3926))

## [3.34.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.33.2...servicebay-v3.34.0) (2026-05-14)


### Features

* **letsdebug:** background sweep + on-diagnose all-domain refresh + 429 backoff ([#477](https://github.com/mdopp/servicebay/issues/477)) ([9ce07d1](https://github.com/mdopp/servicebay/commit/9ce07d17c2150079fa5052d2604aca921c5b2ab9))

## [3.33.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.33.1...servicebay-v3.33.2) (2026-05-14)


### Bug Fixes

* **letsdebug:** parse Go-style PascalCase keys + downgrade transport errors ([#475](https://github.com/mdopp/servicebay/issues/475)) ([26c865f](https://github.com/mdopp/servicebay/commit/26c865f9cb77720567547f31f2e7c441622281b8))

## [3.33.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.33.0...servicebay-v3.33.1) (2026-05-14)


### Bug Fixes

* **docs:** correct lanIp comment to reflect single-domain rewrites ([e8f1cd1](https://github.com/mdopp/servicebay/commit/e8f1cd147966c19b1f94f77aae625bfe09725af2))

## [3.33.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.32.0...servicebay-v3.33.0) (2026-05-14)


### Features

* **routing:** use publicDomain for LAN-only services (drop home.arpa default) ([#471](https://github.com/mdopp/servicebay/issues/471)) ([ff69bb5](https://github.com/mdopp/servicebay/commit/ff69bb591378ca2f420491d9ded3a0dddfaf6bd8))

## [3.32.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.31.0...servicebay-v3.32.0) (2026-05-14)


### Features

* **diagnose:** per-domain unreachability probe with fix hints ([#468](https://github.com/mdopp/servicebay/issues/468)) ([5f2bbc0](https://github.com/mdopp/servicebay/commit/5f2bbc0cc3cf1482b9c52cac5046f844996b7e64))

## [3.31.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.30.4...servicebay-v3.31.0) (2026-05-14)


### Features

* **health:** per-domain reachability + letsdebug external probe ([#466](https://github.com/mdopp/servicebay/issues/466)) ([db64f3e](https://github.com/mdopp/servicebay/commit/db64f3e1be6e0250d7eeea3d3cae2091f44a29e1))

## [3.30.4](https://github.com/mdopp/servicebay/compare/servicebay-v3.30.3...servicebay-v3.30.4) (2026-05-14)


### Bug Fixes

* **proxy:** treat existing NPM proxy host as success, not 400 failure ([#464](https://github.com/mdopp/servicebay/issues/464)) ([d3e4610](https://github.com/mdopp/servicebay/commit/d3e46106a4f5238702090443c1f341e45161338b))

## [3.30.3](https://github.com/mdopp/servicebay/compare/servicebay-v3.30.2...servicebay-v3.30.3) (2026-05-13)


### Bug Fixes

* **wizard:** don't auto-open after install — route operator to /setup instead ([#462](https://github.com/mdopp/servicebay/issues/462)) ([0318aa0](https://github.com/mdopp/servicebay/commit/0318aa040dad5f22239c2868f64c740f6322c87c))

## [3.30.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.30.1...servicebay-v3.30.2) (2026-05-13)


### Bug Fixes

* **diagnose:** suppress crash_loop "young container" rule after a fresh install ([#460](https://github.com/mdopp/servicebay/issues/460)) ([bd7acaf](https://github.com/mdopp/servicebay/commit/bd7acaf5b237c2df296c7430576c5d12f0e50dcc))

## [3.30.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.30.0...servicebay-v3.30.1) (2026-05-13)


### Bug Fixes

* **immich:** oauth schema requires tokenEndpointAuthMethod + signing algos ([#458](https://github.com/mdopp/servicebay/issues/458)) ([44d9447](https://github.com/mdopp/servicebay/commit/44d94477761bb540881d495fd6549de250248149))

## [3.30.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.29.0...servicebay-v3.30.0) (2026-05-13)


### Features

* **setup:** bring done-step panels to /setup + Authelia OIDC localhost fallback ([#456](https://github.com/mdopp/servicebay/issues/456)) ([a94bde3](https://github.com/mdopp/servicebay/commit/a94bde3e631fc2f7ae710788f84c82e00828efcb))

## [3.29.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.28.1...servicebay-v3.29.0) (2026-05-13)


### Features

* **settings:** unified Auto-update window + boot-time safety lock ([#454](https://github.com/mdopp/servicebay/issues/454)) ([576c9ac](https://github.com/mdopp/servicebay/commit/576c9ac43afbd5f3039ecddb452c82118fbbe478))

## [3.28.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.28.0...servicebay-v3.28.1) (2026-05-13)


### Bug Fixes

* **immich:** probe /api/server/ping — /api/server-info doesn't exist ([#452](https://github.com/mdopp/servicebay/issues/452)) ([fe9bbcc](https://github.com/mdopp/servicebay/commit/fe9bbccdee43b8d6dd5ffb17f8470726d1ef95b0))

## [3.28.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.27.4...servicebay-v3.28.0) (2026-05-13)


### Features

* **setup:** non-blocking install workspace at /setup ([#450](https://github.com/mdopp/servicebay/issues/450)) ([5fbcfba](https://github.com/mdopp/servicebay/commit/5fbcfba994c49f7ae8f01a25a1fb28c5d1d3fb1d))

## [3.27.4](https://github.com/mdopp/servicebay/compare/servicebay-v3.27.3...servicebay-v3.27.4) (2026-05-13)


### Bug Fixes

* **install:** probe immich on LAN_IP — rootless+hostNetwork doesn't bridge loopback ([#448](https://github.com/mdopp/servicebay/issues/448)) ([a243e82](https://github.com/mdopp/servicebay/commit/a243e82dcb1e537bb63bda117f8d46c95d04e5d5))

## [3.27.3](https://github.com/mdopp/servicebay/compare/servicebay-v3.27.2...servicebay-v3.27.3) (2026-05-13)


### Bug Fixes

* **immich:** drop fragile wait_pod_running + keep install stream warm ([#446](https://github.com/mdopp/servicebay/issues/446)) ([31360ae](https://github.com/mdopp/servicebay/commit/31360ae1211878e5234ca1caf7044f4defbed439))

## [3.27.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.27.1...servicebay-v3.27.2) (2026-05-13)


### Bug Fixes

* **immich:** probe both 127.0.0.1 and [::1] in post-deploy wait_ready ([#441](https://github.com/mdopp/servicebay/issues/441)) ([bb68128](https://github.com/mdopp/servicebay/commit/bb6812858bdc9ce3350c42e4804b05ddcd34442f))
* Z-Wave device permissions + SSO OIDC wiring + MCP deploy API ([#444](https://github.com/mdopp/servicebay/issues/444)) ([805036f](https://github.com/mdopp/servicebay/commit/805036f641766882a0e6dcd9048fe2ded11a509d))

## [3.27.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.27.0...servicebay-v3.27.1) (2026-05-13)


### Bug Fixes

* **immich:** extend post-deploy budget + wait for pod Running first ([#438](https://github.com/mdopp/servicebay/issues/438)) ([90ed25a](https://github.com/mdopp/servicebay/commit/90ed25ab73b7f7e1256e24b5edd107c5c0f73f31))
* **immich:** preserve pgvecto.rs shared_preload_libraries in postgres args ([#439](https://github.com/mdopp/servicebay/issues/439)) ([2267230](https://github.com/mdopp/servicebay/commit/2267230f4cc12f9ea8775527fb1ac20d64dd6b32))

## [3.27.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.26.0...servicebay-v3.27.0) (2026-05-13)


### Features

* **access-requests:** auto-create LLDAP user on approve ([#425](https://github.com/mdopp/servicebay/issues/425)) ([1b8f907](https://github.com/mdopp/servicebay/commit/1b8f90777311ae5422fac7e906715affd68aaeb2)), closes [#406](https://github.com/mdopp/servicebay/issues/406)
* **access-requests:** collect username + firstName/lastName on portal form ([#424](https://github.com/mdopp/servicebay/issues/424)) ([b8685f6](https://github.com/mdopp/servicebay/commit/b8685f65c2a5104b45064b771639502407a6d38c)), closes [#405](https://github.com/mdopp/servicebay/issues/405)
* **access-requests:** confirmation email to requester on approve ([#426](https://github.com/mdopp/servicebay/issues/426)) ([0ab207e](https://github.com/mdopp/servicebay/commit/0ab207e4e024ecb41769e8ffaf6a5b00ea203c37)), closes [#407](https://github.com/mdopp/servicebay/issues/407)
* **access-requests:** deep-link admin email to settings page ([#423](https://github.com/mdopp/servicebay/issues/423)) ([3917b55](https://github.com/mdopp/servicebay/commit/3917b555f4db1693fdbf45f690642eea2d81f0be)), closes [#404](https://github.com/mdopp/servicebay/issues/404)
* **access-requests:** resend welcome email + polished template ([#434](https://github.com/mdopp/servicebay/issues/434)) ([eecc7af](https://github.com/mdopp/servicebay/commit/eecc7afd79b25db1a90be64936e857f0f8096211)), closes [#418](https://github.com/mdopp/servicebay/issues/418)
* **home-assistant:** Z-Wave JS UI always-on + browser-reachable ([#435](https://github.com/mdopp/servicebay/issues/435)) ([b6310e5](https://github.com/mdopp/servicebay/commit/b6310e592f9e37f1aacb07c9c2f3bd7d71c893bf))
* **portal:** auth-aware view via Authelia soft-verify ([#433](https://github.com/mdopp/servicebay/issues/433)) ([6cd9a47](https://github.com/mdopp/servicebay/commit/6cd9a47757bc269658e09055ca9cc3a69459651f))
* **services:** re-render YAML from template using current variables ([#436](https://github.com/mdopp/servicebay/issues/436)) ([7ab283e](https://github.com/mdopp/servicebay/commit/7ab283e220a1eaa22d8d6f9b6ac528bf24d1e59c))


### Bug Fixes

* **file-share:** correct syncthing exec name + silence UPnP logspam ([#432](https://github.com/mdopp/servicebay/issues/432)) ([9aedbfb](https://github.com/mdopp/servicebay/commit/9aedbfbad5855458fd46783a6da70cb77e3c7917)), closes [#415](https://github.com/mdopp/servicebay/issues/415)
* **file-share:** split portal tile into Files + Syncthing cards ([#431](https://github.com/mdopp/servicebay/issues/431)) ([c95c3e6](https://github.com/mdopp/servicebay/commit/c95c3e61a29fe7652591cb0e4d470557c0fa4542)), closes [#414](https://github.com/mdopp/servicebay/issues/414)
* **immich:** seed admin, wire OIDC, and switch pod to hostNetwork ([#428](https://github.com/mdopp/servicebay/issues/428)) ([178bea1](https://github.com/mdopp/servicebay/commit/178bea103e1c52c02c00383dbe728f26d2cd782c)), closes [#410](https://github.com/mdopp/servicebay/issues/410)
* **media:** switch Navidrome from reverse-proxy-auth to OIDC ([#430](https://github.com/mdopp/servicebay/issues/430)) ([0f8be9b](https://github.com/mdopp/servicebay/commit/0f8be9bf303999715c7cc30c317a4b79286b8d94)), closes [#413](https://github.com/mdopp/servicebay/issues/413)
* **vaultwarden:** switch pod to hostNetwork so SSO discovery works ([#427](https://github.com/mdopp/servicebay/issues/427)) ([32f0e0d](https://github.com/mdopp/servicebay/commit/32f0e0de36a33fa7f7f728dc8787e8d05ffec99e)), closes [#408](https://github.com/mdopp/servicebay/issues/408)

## [3.26.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.25.3...servicebay-v3.26.0) (2026-05-12)


### Features

* **install:** auto-restrict LAN-exposure proxy hosts via NPM access list ([#416](https://github.com/mdopp/servicebay/issues/416)) ([8863b52](https://github.com/mdopp/servicebay/commit/8863b5227a7fa484528cc912ca2eb3f5bc6ab976))

## [3.25.3](https://github.com/mdopp/servicebay/compare/servicebay-v3.25.2...servicebay-v3.25.3) (2026-05-12)


### Bug Fixes

* **wizard,diagnose:** replace static post-install instructions with self-checks ([#409](https://github.com/mdopp/servicebay/issues/409)) ([117e6c8](https://github.com/mdopp/servicebay/commit/117e6c85ae95f3821d9654ef7730b2ec79973220))

## [3.25.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.25.1...servicebay-v3.25.2) (2026-05-12)


### Bug Fixes

* **install:** poll /api/install/status instead of socket subscription ([#402](https://github.com/mdopp/servicebay/issues/402)) ([7dfa235](https://github.com/mdopp/servicebay/commit/7dfa2354bc327de969784558d2e58a155d4c202d))

## [3.25.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.25.0...servicebay-v3.25.1) (2026-05-12)


### Bug Fixes

* **install:** attach internal token on runner loopback fetches ([#400](https://github.com/mdopp/servicebay/issues/400)) ([1c049d3](https://github.com/mdopp/servicebay/commit/1c049d3122b4c765c08b5fddf350a7f13b11cc12))

## [3.25.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.24.1...servicebay-v3.25.0) (2026-05-12)


### Features

* **install:** move deploy loop server-side, survive browser disconnects ([#398](https://github.com/mdopp/servicebay/issues/398)) ([b696fd8](https://github.com/mdopp/servicebay/commit/b696fd83931e42a440bc3f3205c89caab0fd0568))

## [3.24.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.24.0...servicebay-v3.24.1) (2026-05-12)


### Bug Fixes

* **ui:** guard ServerIdentityWatcher against undefined socket ([#396](https://github.com/mdopp/servicebay/issues/396)) ([78499f2](https://github.com/mdopp/servicebay/commit/78499f27519194019c9e0c56765baf17a548412e))

## [3.24.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.23.0...servicebay-v3.24.0) (2026-05-12)


### Features

* **health:** coalesce boot-grace alert emails into one digest ([#394](https://github.com/mdopp/servicebay/issues/394)) ([77d85cb](https://github.com/mdopp/servicebay/commit/77d85cb5ce2d59aa8ee19cee22cce8356146e017))
* **install:** Abort/Start over + dependency-aware install order ([#392](https://github.com/mdopp/servicebay/issues/392)) ([0abb5ac](https://github.com/mdopp/servicebay/commit/0abb5ac499d521fe7f82c4649f8aab730c670214))
* **wizard,docs:** auto-check deps + uncheck-guard, document annotation ([#395](https://github.com/mdopp/servicebay/issues/395)) ([79695dc](https://github.com/mdopp/servicebay/commit/79695dc60809855590d69987aa54cb6be075c738))

## [3.23.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.22.1...servicebay-v3.23.0) (2026-05-12)


### Features

* **ui:** detect server restart + setup-revert, prompt reload ([#390](https://github.com/mdopp/servicebay/issues/390)) ([e4516a8](https://github.com/mdopp/servicebay/commit/e4516a881045fde9c6c9ae0987edd4ab89b2918d))

## [3.22.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.22.0...servicebay-v3.22.1) (2026-05-12)


### Bug Fixes

* **nginx:** drop letsencrypt_{email,agree} from cert-create meta ([#388](https://github.com/mdopp/servicebay/issues/388)) ([7718156](https://github.com/mdopp/servicebay/commit/77181564e6a3947397f91a16e7d89523e105130b))

## [3.22.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.21.0...servicebay-v3.22.0) (2026-05-12)


### Features

* **diagnose:** FritzBox reconnect action + fix-buttons in onboarding wizard ([#383](https://github.com/mdopp/servicebay/issues/383)) ([add9a56](https://github.com/mdopp/servicebay/commit/add9a56f181b657a43e64c93c86eea2f39ac3c8d))
* **install:** explicit portal-routing provision with retries ([#386](https://github.com/mdopp/servicebay/issues/386)) ([4e02f0c](https://github.com/mdopp/servicebay/commit/4e02f0ca1fe1f6879da05bfa164d5f91394e66a3))


### Bug Fixes

* **adguard:** use GET for /control/rewrite/list, not POST ([#385](https://github.com/mdopp/servicebay/issues/385)) ([6604352](https://github.com/mdopp/servicebay/commit/660435276640ef60989eee94d1e0a43fb87096a5))
* **diagnose:** read AdGuard creds from config.adguard, not stale templateSettings ([#384](https://github.com/mdopp/servicebay/issues/384)) ([2677471](https://github.com/mdopp/servicebay/commit/2677471ea20254b049a61feebcc85b4308ee1d48))

## [3.21.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.20.0...servicebay-v3.21.0) (2026-05-12)


### Features

* **diagnose:** adguard_rewrites_missing probe + reprovision action ([#379](https://github.com/mdopp/servicebay/issues/379)) ([9364e1b](https://github.com/mdopp/servicebay/commit/9364e1bddda8f4023113f0bae4f757d23c3521d6))
* **install:** per-template public/LAN exposure + auto LE cert + cert_request_failure probe ([#382](https://github.com/mdopp/servicebay/issues/382)) ([1284ac3](https://github.com/mdopp/servicebay/commit/1284ac32c2184156531c7c52c90001e9cc56e144))


### Bug Fixes

* **terminal:** route container:local:* through SSH in container mode ([#380](https://github.com/mdopp/servicebay/issues/380)) ([bd6e7d4](https://github.com/mdopp/servicebay/commit/bd6e7d4d3824c3a397a1dea9abcc8055bf172741))

## [3.20.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.19.3...servicebay-v3.20.0) (2026-05-11)


### Features

* **templates:** per-template migration scripts ([#352](https://github.com/mdopp/servicebay/issues/352) phase 3) ([#375](https://github.com/mdopp/servicebay/issues/375)) ([08ec8dc](https://github.com/mdopp/servicebay/commit/08ec8dc54fc6ac80d4eaf91995a50bfcbc5aa20e))

## [3.19.3](https://github.com/mdopp/servicebay/compare/servicebay-v3.19.2...servicebay-v3.19.3) (2026-05-11)


### Bug Fixes

* **install:** stop wizard device-poll runaway during install ([#376](https://github.com/mdopp/servicebay/issues/376)) ([f08f3d3](https://github.com/mdopp/servicebay/commit/f08f3d3c8c4316095404d3995b31628d969211fb))

## [3.19.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.19.1...servicebay-v3.19.2) (2026-05-11)


### Miscellaneous Chores

* trigger release for [#341](https://github.com/mdopp/servicebay/issues/341) phase-2 refactor ([#373](https://github.com/mdopp/servicebay/issues/373)) ([17790ba](https://github.com/mdopp/servicebay/commit/17790ba2a2763ad1bf7cdb00ca9e4f693a302d34))

## [3.19.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.19.0...servicebay-v3.19.1) (2026-05-11)


### Bug Fixes

* install regressions — nginx hostPort + wizard Mustache sections ([#370](https://github.com/mdopp/servicebay/issues/370)) ([2b21815](https://github.com/mdopp/servicebay/commit/2b218157279c15c5b2efc0cf1b6403022361184f))

## [3.19.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.18.2...servicebay-v3.19.0) (2026-05-11)


### Features

* **home-assistant:** self-heal trusted_proxies after HA backup-restore ([#368](https://github.com/mdopp/servicebay/issues/368)) ([79e60a9](https://github.com/mdopp/servicebay/commit/79e60a9515a5216fbf3f63a3935848b9d5111b14))
* **wizard:** hoist operator email into Domain step ([#365](https://github.com/mdopp/servicebay/issues/365)) ([#369](https://github.com/mdopp/servicebay/issues/369)) ([692c632](https://github.com/mdopp/servicebay/commit/692c632044e7c693c7934dea9d8928c27c6a7236))


### Bug Fixes

* **home-assistant:** seed configuration.yaml with trusted_proxies ([#366](https://github.com/mdopp/servicebay/issues/366)) ([86a7ca8](https://github.com/mdopp/servicebay/commit/86a7ca8aa3b1d0169baba5b413868bb40bf0ca77))
* **nginx:** bind NPM on hostNetwork so it reaches hostNetwork upstreams ([#364](https://github.com/mdopp/servicebay/issues/364)) ([917c9cb](https://github.com/mdopp/servicebay/commit/917c9cb939b8a8643f076af2e84b893ffb622d60))

## [3.18.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.18.1...servicebay-v3.18.2) (2026-05-11)


### Bug Fixes

* **file-share:** bind FileBrowser on 0.0.0.0 so NPM can reach it ([#362](https://github.com/mdopp/servicebay/issues/362)) ([8440141](https://github.com/mdopp/servicebay/commit/8440141a8029e6995bf060213003e17e5f9e3377))

## [3.18.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.18.0...servicebay-v3.18.1) (2026-05-11)


### Bug Fixes

* **filebrowser:** pre-start DB init must set auth.method=proxy ([#359](https://github.com/mdopp/servicebay/issues/359)) ([be62169](https://github.com/mdopp/servicebay/commit/be62169c0e8f80fa0dda89a1214cca94d7399dd3))

## [3.18.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.17.0...servicebay-v3.18.0) (2026-05-11)


### Features

* **templates:** extract voice stack from home-assistant ([#348](https://github.com/mdopp/servicebay/issues/348)) ([#351](https://github.com/mdopp/servicebay/issues/351)) ([bac8233](https://github.com/mdopp/servicebay/commit/bac823326cf8eb89c51def5025c38417daa926fa))
* **templates:** schema-version annotation + upgrade banner with CHANGELOG diff ([#353](https://github.com/mdopp/servicebay/issues/353), [#354](https://github.com/mdopp/servicebay/issues/354)) ([#357](https://github.com/mdopp/servicebay/issues/357)) ([1abc593](https://github.com/mdopp/servicebay/commit/1abc5935bb2a23da99540e781fce90dffd50d114))


### Bug Fixes

* **filebrowser:** use FB's JWT login flow instead of bare Remote-User ([#355](https://github.com/mdopp/servicebay/issues/355)) ([bc7f4bb](https://github.com/mdopp/servicebay/commit/bc7f4bb68dbab32c20fd869261c65cf875962a9e))

## [3.17.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.16.2...servicebay-v3.17.0) (2026-05-11)


### Features

* **adguard:** wildcard DNS rewrites for LAN + public domains ([#349](https://github.com/mdopp/servicebay/issues/349)) ([126f168](https://github.com/mdopp/servicebay/commit/126f16877ba134dab72325fedc75036f332fadc1))
* **reinstall:** welcome-back banner with live restore progress ([#337](https://github.com/mdopp/servicebay/issues/337)) ([#350](https://github.com/mdopp/servicebay/issues/350)) ([5d1450b](https://github.com/mdopp/servicebay/commit/5d1450b8252172b6f323b75a4da539c0b9867f46))


### Bug Fixes

* **filebrowser:** seed via HTTP API instead of CLI to avoid BoltDB lock ([#345](https://github.com/mdopp/servicebay/issues/345)) ([224a19e](https://github.com/mdopp/servicebay/commit/224a19e3c6d73a3539cd02c5558c8f4f7b27cd20))

## [3.16.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.16.1...servicebay-v3.16.2) (2026-05-11)


### Bug Fixes

* **file-share:** surface seed-attempt errors + bump per-call timeout ([#343](https://github.com/mdopp/servicebay/issues/343)) ([1385045](https://github.com/mdopp/servicebay/commit/1385045c45478962a18364e4e62e76cb555013c7))
* **wizard:** unify chrome + self-heal stale persisted state ([#341](https://github.com/mdopp/servicebay/issues/341) phase 1) ([#342](https://github.com/mdopp/servicebay/issues/342)) ([d3b5edb](https://github.com/mdopp/servicebay/commit/d3b5edb01d219beea86a879c758240460ad9c43c))

## [3.16.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.16.0...servicebay-v3.16.1) (2026-05-10)


### Bug Fixes

* **install:** chown merged config.json to core ([#331](https://github.com/mdopp/servicebay/issues/331) follow-up [#2](https://github.com/mdopp/servicebay/issues/2)) ([#339](https://github.com/mdopp/servicebay/issues/339)) ([60ada03](https://github.com/mdopp/servicebay/commit/60ada03657ca096e4887eaa47a0850a43eaad3d7))

## [3.16.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.15.1...servicebay-v3.16.0) (2026-05-10)


### Features

* **settings:** Gateway (FritzBox) edit section + fix wrong link ([#333](https://github.com/mdopp/servicebay/issues/333)) ([#335](https://github.com/mdopp/servicebay/issues/335)) ([7672a7f](https://github.com/mdopp/servicebay/commit/7672a7f7bd63bc8bcbaff4daf8ecd9d4b44fd38b))


### Bug Fixes

* **install:** enable setup-config-merge.service on first boot ([#331](https://github.com/mdopp/servicebay/issues/331) follow-up) ([#338](https://github.com/mdopp/servicebay/issues/338)) ([5174445](https://github.com/mdopp/servicebay/commit/5174445c5ce29498095e5d8d396811b3c82774c1))
* **install:** smart config-merge on re-install ([#331](https://github.com/mdopp/servicebay/issues/331)) ([#332](https://github.com/mdopp/servicebay/issues/332)) ([13ddb9d](https://github.com/mdopp/servicebay/commit/13ddb9d719400fe126c5135742d757910d54c6f2))

## [3.15.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.15.0...servicebay-v3.15.1) (2026-05-10)


### Bug Fixes

* **install:** single source of truth for persisted settings ([#327](https://github.com/mdopp/servicebay/issues/327)) ([f2b920c](https://github.com/mdopp/servicebay/commit/f2b920cdec0040026e6a401043b1c6fc4fe7ec11))

## [3.15.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.14.0...servicebay-v3.15.0) (2026-05-10)


### Features

* redact MCP secrets + LAN-only bootstrap token ([#321](https://github.com/mdopp/servicebay/issues/321), [#322](https://github.com/mdopp/servicebay/issues/322)) ([#323](https://github.com/mdopp/servicebay/issues/323)) ([5902578](https://github.com/mdopp/servicebay/commit/5902578971102818b3b3a3f816980bc69d7bc517))


### Bug Fixes

* file-share seed timeout, SSO defaults to true, portal polish ([#315](https://github.com/mdopp/servicebay/issues/315)) ([6b93142](https://github.com/mdopp/servicebay/commit/6b93142bc0048bc7da2cbcccb4fda8efcad382c9))
* **portal:** modal "How do I use this?" + OS-aware assets ([#324](https://github.com/mdopp/servicebay/issues/324), [#325](https://github.com/mdopp/servicebay/issues/325)) ([#326](https://github.com/mdopp/servicebay/issues/326)) ([2b75468](https://github.com/mdopp/servicebay/commit/2b75468e56e045e3a667a4d6963072d6a21c586f))
* surface install-time failures ([#317](https://github.com/mdopp/servicebay/issues/317), [#318](https://github.com/mdopp/servicebay/issues/318), [#319](https://github.com/mdopp/servicebay/issues/319)) ([#320](https://github.com/mdopp/servicebay/issues/320)) ([0e62128](https://github.com/mdopp/servicebay/commit/0e6212883ffe7a076d22ac555079f21b144b80ba))

## [3.14.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.13.0...servicebay-v3.14.0) (2026-05-10)


### Features

* **portal:** "request access" flow for visitors without an account ([#307](https://github.com/mdopp/servicebay/issues/307)) ([690632b](https://github.com/mdopp/servicebay/commit/690632b19a8178011617bbdf826f594db86d8e1e))
* **portal:** one-tap iOS profile + Audiobookshelf deep link ([#242](https://github.com/mdopp/servicebay/issues/242) follow-up) ([#310](https://github.com/mdopp/servicebay/issues/310)) ([453b1f3](https://github.com/mdopp/servicebay/commit/453b1f3d3c7c0ac907e516ff6c5fce11a0a349ba))
* **portal:** PWA install — Add to Home Screen on mobile ([#312](https://github.com/mdopp/servicebay/issues/312)) ([45f5e26](https://github.com/mdopp/servicebay/commit/45f5e264a3033004a8eb2ad97fc802cb55649084))
* **portal:** recommended_apps schema with platform badges + per-app notes ([#309](https://github.com/mdopp/servicebay/issues/309)) ([dd7758e](https://github.com/mdopp/servicebay/commit/dd7758ee34f0c2916d37be6edc6660ca66f99a7f))
* **portal:** switch from emoji icons to Lucide line-art ([#314](https://github.com/mdopp/servicebay/issues/314)) ([b760976](https://github.com/mdopp/servicebay/commit/b7609761e7f61987d11afbf4a4b647167c2f2176))
* **portal:** Syncthing QR setup asset for one-tap Android device pairing ([#311](https://github.com/mdopp/servicebay/issues/311)) ([56bb854](https://github.com/mdopp/servicebay/commit/56bb854e6888526aae6744734e972055e37b8732))
* **portal:** user-guides for vaultwarden, file-share, home-assistant, media, radicale ([#306](https://github.com/mdopp/servicebay/issues/306)) ([bb06391](https://github.com/mdopp/servicebay/commit/bb06391937fd3c2f751849d3c0d03a779a4f7980))


### Bug Fixes

* **portal:** use install-time subdomain not template default ([#313](https://github.com/mdopp/servicebay/issues/313)) ([e4a52ef](https://github.com/mdopp/servicebay/commit/e4a52efef930e8cb8f67406d79b6d3cfe8d3a9b2))

## [3.13.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.12.0...servicebay-v3.13.0) (2026-05-10)


### Features

* **credentials:** persist install manifest encrypted at rest ([#19](https://github.com/mdopp/servicebay/issues/19)/A1) ([#293](https://github.com/mdopp/servicebay/issues/293)) ([17a18a0](https://github.com/mdopp/servicebay/commit/17a18a0a509c2030b1d7a63708a250f5c9383dbb))
* **diagnose:** "Run stale checks now" action on health_checks probe ([#289](https://github.com/mdopp/servicebay/issues/289)) ([2a72771](https://github.com/mdopp/servicebay/commit/2a72771f810faff0006fbbb849e454d445a1511c))
* **diagnose:** "Show largest directories" action on disk probe ([#292](https://github.com/mdopp/servicebay/issues/292)) ([0c6f9ac](https://github.com/mdopp/servicebay/commit/0c6f9ac7b4e434a99f04a8613facd22463499f93))
* **diagnose:** action result details for multi-line output ([#291](https://github.com/mdopp/servicebay/issues/291)) ([c9096d3](https://github.com/mdopp/servicebay/commit/c9096d34acf3d6262a1618a3f666dd10265ed7c0))
* **diagnose:** cert_expiry probe with per-cert Renew action ([#298](https://github.com/mdopp/servicebay/issues/298)) ([3476cdd](https://github.com/mdopp/servicebay/commit/3476cddccef76c3ecad603f4ecd17f8db09af4f1))
* **diagnose:** inline form inputs for probe actions ([#250](https://github.com/mdopp/servicebay/issues/250), [#255](https://github.com/mdopp/servicebay/issues/255)) ([#280](https://github.com/mdopp/servicebay/issues/280)) ([b594636](https://github.com/mdopp/servicebay/commit/b594636b75b7f2b1e39114ee75ceff4a75a9324f))
* **diagnose:** per-container actions on crash_loop probe (B15) ([#285](https://github.com/mdopp/servicebay/issues/285)) ([7619f12](https://github.com/mdopp/servicebay/commit/7619f12333901485bc94905c81b1c7e4362e43da))
* **diagnose:** per-item dynamic actions for probes ([#251](https://github.com/mdopp/servicebay/issues/251)) ([#282](https://github.com/mdopp/servicebay/issues/282)) ([04f20a0](https://github.com/mdopp/servicebay/commit/04f20a0b994e7c8aded0eefcaad96a7e6db99050))
* **diagnose:** per-unit actions on failed_units probe ([#288](https://github.com/mdopp/servicebay/issues/288)) ([9f6a24b](https://github.com/mdopp/servicebay/commit/9f6a24be0662b961cc95ab7046f252b9468fb565))
* **diagnose:** persist post-deploy exit + B8 probe ([#252](https://github.com/mdopp/servicebay/issues/252)) ([#284](https://github.com/mdopp/servicebay/issues/284)) ([b2ec444](https://github.com/mdopp/servicebay/commit/b2ec444ac3e54cc30f650c756ead1bbbc40bdb39))
* **diagnose:** pods Start + podman engine Enable-socket actions ([#294](https://github.com/mdopp/servicebay/issues/294)) ([de1333c](https://github.com/mdopp/servicebay/commit/de1333c4d75b48a69c0747bb828d9c5016b0c2b7))
* **diagnose:** proxy_route_missing probe (B12) ([#286](https://github.com/mdopp/servicebay/issues/286)) ([03e0ec4](https://github.com/mdopp/servicebay/commit/03e0ec443f42d0d14d302dcf18b488b590322fd2))
* **portal:** apex + www routing, auto-provisioned ([#242](https://github.com/mdopp/servicebay/issues/242) follow-up) ([#305](https://github.com/mdopp/servicebay/issues/305)) ([a619ecd](https://github.com/mdopp/servicebay/commit/a619ecd32c8ae9885829275608e758383e4ab5c7))
* **portal:** v1 family-facing card grid ([#242](https://github.com/mdopp/servicebay/issues/242)) ([#304](https://github.com/mdopp/servicebay/issues/304)) ([0bd36f9](https://github.com/mdopp/servicebay/commit/0bd36f9b4dfef18b3f5cb50d5f05d25f16aa62ad))


### Bug Fixes

* **backup:** serialize appendHistory writes ([#302](https://github.com/mdopp/servicebay/issues/302)) ([8332f55](https://github.com/mdopp/servicebay/commit/8332f55356a304ef0af302a4e93522b8e3e00736))
* **config:** serialize updateConfig writes to prevent lost updates ([#299](https://github.com/mdopp/servicebay/issues/299)) ([b3bf872](https://github.com/mdopp/servicebay/commit/b3bf872e08f0d27740ec58b874bf0269c3933da8))
* **diagnose:** resolve dangling proxy host id by domain at dispatch ([#290](https://github.com/mdopp/servicebay/issues/290)) ([da2389a](https://github.com/mdopp/servicebay/commit/da2389ac44b2c2ad096708eba3934889fd6edd9c))
* **network:** serialize NetworkStore add/removeEdge writes ([#300](https://github.com/mdopp/servicebay/issues/300)) ([7404809](https://github.com/mdopp/servicebay/commit/7404809ba75c59276639c7452c5f68da4b6791c3))
* **nodes:** serialize node mutations + atomicWriteFile for crash-safety ([#301](https://github.com/mdopp/servicebay/issues/301)) ([03375ba](https://github.com/mdopp/servicebay/commit/03375ba9425791c2804fc7bd7c86ac2ca336fad0))
* **updater:** add 8s timeout to GitHub releases fetch ([#303](https://github.com/mdopp/servicebay/issues/303)) ([edfefcc](https://github.com/mdopp/servicebay/commit/edfefcc58415eed844e43a1803c0b716c4b80412))
* **wizard:** settle-wait reads stale digitalTwin from closure ([#287](https://github.com/mdopp/servicebay/issues/287)) ([1e18be1](https://github.com/mdopp/servicebay/commit/1e18be1d60c522954c158758fa41c6472e61ecaf))


### Performance Improvements

* **diagnose:** parallelize independent exec probes ([#296](https://github.com/mdopp/servicebay/issues/296)) ([e8fa131](https://github.com/mdopp/servicebay/commit/e8fa131baa24d451ae53162bcbc0d144ad905e70))

## [3.12.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.11.0...servicebay-v3.12.0) (2026-05-10)


### Features

* **wizard:** two-mode domain prompt — public default, lan fallback (D19-PR5) ([#278](https://github.com/mdopp/servicebay/issues/278)) ([4032cb0](https://github.com/mdopp/servicebay/commit/4032cb0f76c67fbfb4eead90bffb048743e0d030))

## [3.11.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.10.0...servicebay-v3.11.0) (2026-05-10)


### Features

* **adguard:** wildcard DNS rewrite client (D19-PR4) ([#274](https://github.com/mdopp/servicebay/issues/274)) ([f00e065](https://github.com/mdopp/servicebay/commit/f00e065a75896201d612898a9b0daa4215e15ac0))
* **diagnose:** lan_ip_changed_since_install probe (D19-PR9) ([#277](https://github.com/mdopp/servicebay/issues/277)) ([c23aa17](https://github.com/mdopp/servicebay/commit/c23aa17e5afb2fc37b3d0d52101a4e76d37c3077))
* **diagnose:** verify-from-this-device action endpoint (D19-PR7) ([#276](https://github.com/mdopp/servicebay/issues/276)) ([c7855b1](https://github.com/mdopp/servicebay/commit/c7855b100ef2a2d4148f4f002ec99102563f0ecb))
* **mode:** two-mode model + public-domain Settings page (D19-PR3) ([#271](https://github.com/mdopp/servicebay/issues/271)) ([804e9c8](https://github.com/mdopp/servicebay/commit/804e9c87e0e20d8147fc7ebc1935f956dc0ad30f))

## [3.10.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.9.3...servicebay-v3.10.0) (2026-05-10)


### Features

* **agent:** tag bootstrap-window errors separately (A4) ([#245](https://github.com/mdopp/servicebay/issues/245)) ([4d5b89e](https://github.com/mdopp/servicebay/commit/4d5b89e5ca2735648dc18212bbbb4a39d5cb485c))
* **diagnose:** npm_data_stale probe with reset action (B6) ([#270](https://github.com/mdopp/servicebay/issues/270)) ([6aad275](https://github.com/mdopp/servicebay/commit/6aad27587b21340383c9f1d95eaedce5421e824f))
* **diagnose:** probe-actions schema + dispatcher (F1) ([#243](https://github.com/mdopp/servicebay/issues/243)) ([0e549f0](https://github.com/mdopp/servicebay/commit/0e549f00e34a7ed35ce02476cca13d672a89c2e8))
* **templates:** infrastructure-tier flag + locked wizard include (D19-PR1) ([#267](https://github.com/mdopp/servicebay/issues/267)) ([ea1a0d7](https://github.com/mdopp/servicebay/commit/ea1a0d72cb5b130847f31b5af484201ebb224fe6))
* **ui:** persistent Local-only mode badge in header (A5) ([#247](https://github.com/mdopp/servicebay/issues/247)) ([4c74690](https://github.com/mdopp/servicebay/commit/4c74690c7ecb81b76332e450a460bc172697fd54))
* **wizard:** auto-retry transient deploy failures (A2) ([#246](https://github.com/mdopp/servicebay/issues/246)) ([c79d8d1](https://github.com/mdopp/servicebay/commit/c79d8d1fb2dff68bd851d20aab14f58af87f2d27))
* **wizard:** rename 'Install a Stack' → 'Install services' (C16) ([#257](https://github.com/mdopp/servicebay/issues/257)) ([56329ab](https://github.com/mdopp/servicebay/commit/56329abeca2a53faf15f967979fb221f4e4af774))


### Bug Fixes

* **file-share:** replace fixed 8s sleep with pod-readiness poll (A3) ([#244](https://github.com/mdopp/servicebay/issues/244)) ([3449138](https://github.com/mdopp/servicebay/commit/3449138e0b86fcbc2aa120e7ed3c0f2967a88da6))
* five fresh-install issues found via MCP diagnostics ([#238](https://github.com/mdopp/servicebay/issues/238)) ([b05e6be](https://github.com/mdopp/servicebay/commit/b05e6be1877390ca03990fc9a5dc9845aee5559c))

## [3.9.3](https://github.com/mdopp/servicebay/compare/servicebay-v3.9.2...servicebay-v3.9.3) (2026-05-09)


### Bug Fixes

* **install:** authenticate post-deploy callbacks via internal token ([#236](https://github.com/mdopp/servicebay/issues/236)) ([b6a1385](https://github.com/mdopp/servicebay/commit/b6a13853fa03b74ffb679de2abe86c9ad8a98a45))

## [3.9.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.9.1...servicebay-v3.9.2) (2026-05-09)


### Bug Fixes

* **agent:** apply multiplexing + exec_stream to v4 agent (the one shipped) ([#234](https://github.com/mdopp/servicebay/issues/234)) ([85f1975](https://github.com/mdopp/servicebay/commit/85f19752e39f00447c17105caa01288418154f15))

## [3.9.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.9.0...servicebay-v3.9.1) (2026-05-09)


### Bug Fixes

* **install:** set SB_API_URL so post-deploy scripts can reach back ([#232](https://github.com/mdopp/servicebay/issues/232)) ([4af6261](https://github.com/mdopp/servicebay/commit/4af6261723f6588396626f2732ad8106facfe1c8))

## [3.9.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.8.1...servicebay-v3.9.0) (2026-05-09)


### Features

* **install:** stream post-deploy stdout + multiplex agent commands ([#230](https://github.com/mdopp/servicebay/issues/230)) ([190b9bc](https://github.com/mdopp/servicebay/commit/190b9bce5f2a55b7037f29cf3f8371a94e88ef15))

## [3.8.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.8.0...servicebay-v3.8.1) (2026-05-09)


### Bug Fixes

* **install:** thread items + variables through express install chain ([#228](https://github.com/mdopp/servicebay/issues/228)) ([5732665](https://github.com/mdopp/servicebay/commit/5732665ec1d99178f741d4a2594333d91f87631b))

## [3.8.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.7.1...servicebay-v3.8.0) (2026-05-09)


### Features

* **install:** express install-confirm screen as default landing ([#227](https://github.com/mdopp/servicebay/issues/227)) ([8620085](https://github.com/mdopp/servicebay/commit/86200858d8fcc037abc9d2be8f43b593436c6060))


### Bug Fixes

* **install:** make wizard resilient to agent reconnect + script timeouts ([#225](https://github.com/mdopp/servicebay/issues/225)) ([dc00950](https://github.com/mdopp/servicebay/commit/dc00950b8c4a026734725a4d61a3cc72cffb3a41))

## [3.7.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.7.0...servicebay-v3.7.1) (2026-05-09)


### Bug Fixes

* **post-deploy:** drop single quotes around tilde paths so bash expands ~ ([#224](https://github.com/mdopp/servicebay/issues/224)) ([bf24ae1](https://github.com/mdopp/servicebay/commit/bf24ae12cccc15aa600ecb3affd7f2fbc9cf8bfd))
* **wizard:** only collapse pull-progress lines, not post-deploy.py output ([#222](https://github.com/mdopp/servicebay/issues/222)) ([a30c346](https://github.com/mdopp/servicebay/commit/a30c3460434fc40e770fe01e9bb1c4c8c0c13607))

## [3.7.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.6.7...servicebay-v3.7.0) (2026-05-08)


### Features

* **templates:** per-template post-deploy.py scripts (phase 1: media) ([#217](https://github.com/mdopp/servicebay/issues/217)) ([8d9fbd5](https://github.com/mdopp/servicebay/commit/8d9fbd5891184d95eac5dea9e6fc8157a9424668))
* **templates:** post-deploy.py for auth + nginx-web (phase 2 / part 2) ([#220](https://github.com/mdopp/servicebay/issues/220)) ([c79da83](https://github.com/mdopp/servicebay/commit/c79da83fbfa2a725aa12749f1ef3339473071640))
* **templates:** post-deploy.py for file-share + adguard (phase 2 / part 1) ([#219](https://github.com/mdopp/servicebay/issues/219)) ([db5cea2](https://github.com/mdopp/servicebay/commit/db5cea2ae7227d390318a8f447ce6b949194b37e))

## [3.6.7](https://github.com/mdopp/servicebay/compare/servicebay-v3.6.6...servicebay-v3.6.7) (2026-05-08)


### Bug Fixes

* **wizard:** preserve mustache placeholders in extraFiles paths (the authelia-config bug) ([#215](https://github.com/mdopp/servicebay/issues/215)) ([b8077c5](https://github.com/mdopp/servicebay/commit/b8077c5e3cb572a7c6b40a398d564d0fcbb544a2))

## [3.6.6](https://github.com/mdopp/servicebay/compare/servicebay-v3.6.5...servicebay-v3.6.6) (2026-05-08)


### Bug Fixes

* **wizard:** multi-doc YAML resolver + skip post-install steps for failed deploys ([#213](https://github.com/mdopp/servicebay/issues/213)) ([0c5119a](https://github.com/mdopp/servicebay/commit/0c5119ad816b1f3b50662d879be525e5f948b729))

## [3.6.5](https://github.com/mdopp/servicebay/compare/servicebay-v3.6.4...servicebay-v3.6.5) (2026-05-08)


### Bug Fixes

* **install:** setup-raid deadlock + syncthing PUID + extraFiles consistency guard ([#211](https://github.com/mdopp/servicebay/issues/211)) ([215ac50](https://github.com/mdopp/servicebay/commit/215ac50ceddfdf96247baf7951a65e1a867b80ac))

## [3.6.4](https://github.com/mdopp/servicebay/compare/servicebay-v3.6.3...servicebay-v3.6.4) (2026-05-08)


### Bug Fixes

* **install:** syncthing runAsUser+PVC combo, mustache strict-render, settle wait, real crash logs ([#209](https://github.com/mdopp/servicebay/issues/209)) ([cd7cd4c](https://github.com/mdopp/servicebay/commit/cd7cd4cd4469d14d747d61b19b3c53df23c7eae5))

## [3.6.3](https://github.com/mdopp/servicebay/compare/servicebay-v3.6.2...servicebay-v3.6.3) (2026-05-08)


### Bug Fixes

* **stacks:** sync full-stack README with merged templates, drop dead web-stack, lock with consistency rule ([#207](https://github.com/mdopp/servicebay/issues/207)) ([3424c9b](https://github.com/mdopp/servicebay/commit/3424c9bdc7d7af8733070d9ff8e411aa0b1d5266))

## [3.6.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.6.1...servicebay-v3.6.2) (2026-05-08)


### Bug Fixes

* **install:** drive OIDC client_id from variables.meta, add consistency rule ([#201](https://github.com/mdopp/servicebay/issues/201)) ([d504339](https://github.com/mdopp/servicebay/commit/d50433938471fc4511b384f208729354e80b68cd))
* **install:** make extra-file write failures fatal, MCP deploy_service accepts extraFiles, install-nginx self-marks done ([#205](https://github.com/mdopp/servicebay/issues/205)) ([3b81538](https://github.com/mdopp/servicebay/commit/3b81538c0b5793c12a9a240af75a47634ef3a0ca))
* **radicale+diagnose:** self-seed radicale config in-pod, suppress benign first-boot failures ([#203](https://github.com/mdopp/servicebay/issues/203)) ([a37a521](https://github.com/mdopp/servicebay/commit/a37a521d9f92b2a85cb4f2acc276e41704c964ad))
* **reliability:** podman-volume syncthing-config + auto-migrate orphan units on upgrade ([#204](https://github.com/mdopp/servicebay/issues/204)) ([f5f8964](https://github.com/mdopp/servicebay/commit/f5f8964db021f9d8630e2b3c49b484a0d2a97e3b))

## [3.6.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.6.0...servicebay-v3.6.1) (2026-05-08)


### Bug Fixes

* **diagnose+ui:** gate restart-loop probe by system uptime, drop duplicate network legend ([#197](https://github.com/mdopp/servicebay/issues/197)) ([30bd0bf](https://github.com/mdopp/servicebay/commit/30bd0bfd4412aa265947272efd01ad88b5627755))

## [3.6.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.5.0...servicebay-v3.6.0) (2026-05-08)


### Features

* **wizard:** humanise variable labels — drop redundant prefix + description noise ([#190](https://github.com/mdopp/servicebay/issues/190)) ([d95e3ec](https://github.com/mdopp/servicebay/commit/d95e3ec444e49737922437d3b7487f9ae8f4cdf6))


### Bug Fixes

* **network:** correctly de-duplicate proxied domains off the nginx node ([#195](https://github.com/mdopp/servicebay/issues/195)) ([7e80b4e](https://github.com/mdopp/servicebay/commit/7e80b4e0f7d1768de1083f0b879ce9fb03aa3346))
* **ux:** replace Backup Sync target type chip row with radio cards ([#194](https://github.com/mdopp/servicebay/issues/194)) ([bcadf5c](https://github.com/mdopp/servicebay/commit/bcadf5c8c6b65f8e5856914b87bb28d2b54615e8))
* **wizard:** show missing dep badges for navidrome/file-share + flag nginx-web when domain is set ([#196](https://github.com/mdopp/servicebay/issues/196)) ([31f5089](https://github.com/mdopp/servicebay/commit/31f5089b04e5164595c7f90d99b82df870f1e398))
* **wizard:** use digital twin for install status strip + clipboard fallback for HTTP ([#192](https://github.com/mdopp/servicebay/issues/192)) ([f0f8833](https://github.com/mdopp/servicebay/commit/f0f883315bcf00be78512dce304855942da2a9f5))

## [3.5.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.4.2...servicebay-v3.5.0) (2026-05-08)


### Features

* **wizard:** domain prompt at top of services step + LAN-only opt-out + USB auto-pick single device ([#185](https://github.com/mdopp/servicebay/issues/185)) ([0003f4d](https://github.com/mdopp/servicebay/commit/0003f4d4ee3ad0d0d2ab761393e8e3770b1f88b6))
* **wizard:** per-service status strip during install + bigger log panel ([#186](https://github.com/mdopp/servicebay/issues/186)) ([e71b09c](https://github.com/mdopp/servicebay/commit/e71b09cca6ef230190737f41f73c62159dfde956))
* **wizard:** server-side install lock + concurrent-install guard ([#184](https://github.com/mdopp/servicebay/issues/184)) ([272a3b8](https://github.com/mdopp/servicebay/commit/272a3b83a857510c496de5dd6316a6f3be61e5a0))
* **wizard:** tab-split configure step (Subdomains / Settings / Ports) ([#187](https://github.com/mdopp/servicebay/issues/187)) ([0b13aa5](https://github.com/mdopp/servicebay/commit/0b13aa575d65091fd7da0f14a68ef0949a0c366d))
* **wizard:** visible service dependencies + auto-include of hard deps ([#188](https://github.com/mdopp/servicebay/issues/188)) ([476e624](https://github.com/mdopp/servicebay/commit/476e62412e43b44858e4035cd1a516c4a0b91820))


### Bug Fixes

* **install:** copy src/content/help + CHANGELOG.md into the runtime image ([#183](https://github.com/mdopp/servicebay/issues/183)) ([41027b1](https://github.com/mdopp/servicebay/commit/41027b1f4a7e3fb70b9252b928cc15300cf2062a))
* restart-directive injection for single-image stacks + radicale via env + syncthing privileged ([#181](https://github.com/mdopp/servicebay/issues/181)) ([7c087cc](https://github.com/mdopp/servicebay/commit/7c087cc3428f5188c205bdd5d3d14ea2d31283c4))

## [3.4.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.4.1...servicebay-v3.4.2) (2026-05-07)


### Bug Fixes

* health checks tick across bundle boundaries + radicale dumb-init + SELinux on bind mounts ([#178](https://github.com/mdopp/servicebay/issues/178)) ([69b59ac](https://github.com/mdopp/servicebay/commit/69b59ac31aab9aa5721c238aa783b617fcce2926))

## [3.4.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.4.0...servicebay-v3.4.1) (2026-05-07)


### Bug Fixes

* **installer:** wait 90s for NPM to seed admin user before declaring failure ([#177](https://github.com/mdopp/servicebay/issues/177)) ([310c00d](https://github.com/mdopp/servicebay/commit/310c00ddc20fa577b8d56bffea9694ef7f2465e1))

## [3.4.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.3.0...servicebay-v3.4.0) (2026-05-07)


### Features

* **security:** MCP audit log + Recent activity panel in settings ([#173](https://github.com/mdopp/servicebay/issues/173)) ([90b49e1](https://github.com/mdopp/servicebay/commit/90b49e1de8f135ddd2616fb7262e0eac64a216bc))
* **security:** scoped API tokens for MCP — named, revocable, with explicit scopes ([#174](https://github.com/mdopp/servicebay/issues/174)) ([97e6939](https://github.com/mdopp/servicebay/commit/97e69395f8b8b8aaf9a91bbdc151c8b38ca96673))
* **security:** soft-delete services to a trash bucket, restorable for 7 days ([#171](https://github.com/mdopp/servicebay/issues/171)) ([4ed3798](https://github.com/mdopp/servicebay/commit/4ed37983984c940ef42424866217fb836285df02))

## [3.3.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.2.0...servicebay-v3.3.0) (2026-05-07)


### Features

* **security:** MCP read-only mode + exec denylist + auto-snapshot before destructive ops ([#169](https://github.com/mdopp/servicebay/issues/169)) ([d9e6a24](https://github.com/mdopp/servicebay/commit/d9e6a24ade6b916825314cd0bd3c3f6879ae5c3a))

## [3.2.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.1.3...servicebay-v3.2.0) (2026-05-07)


### Features

* exponential restart backoff for crash-loops + auto self-test on install ([#167](https://github.com/mdopp/servicebay/issues/167)) ([f75a261](https://github.com/mdopp/servicebay/commit/f75a261a1bb679092a65f3cc9f685c2ec1a51ff2))

## [3.1.3](https://github.com/mdopp/servicebay/compare/servicebay-v3.1.2...servicebay-v3.1.3) (2026-05-07)


### Bug Fixes

* schedule new health checks, accurate disk metric, installer race, watcher spam, ghost-node clickability ([#166](https://github.com/mdopp/servicebay/issues/166)) ([0245a5a](https://github.com/mdopp/servicebay/commit/0245a5a77ea17b4553533295204949d0ec878dbb))
* **templates:** radicale entrypoint chain + filebrowser containerPort ([#164](https://github.com/mdopp/servicebay/issues/164)) ([20bb6dd](https://github.com/mdopp/servicebay/commit/20bb6dd678d1fe4fba3242c99e425e2f1d2346ee))

## [3.1.2](https://github.com/mdopp/servicebay/compare/servicebay-v3.1.1...servicebay-v3.1.2) (2026-05-07)


### Bug Fixes

* **templates,network:** rootless UID mapping in pods + NPM self-ref edges ([#162](https://github.com/mdopp/servicebay/issues/162)) ([d5dbb32](https://github.com/mdopp/servicebay/commit/d5dbb322d712bde7e25605f1f22194f9e938390a))

## [3.1.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.1.0...servicebay-v3.1.1) (2026-05-07)


### Bug Fixes

* **installer:** bootstrap NPM admin credentials on first install ([#160](https://github.com/mdopp/servicebay/issues/160)) ([184b3ca](https://github.com/mdopp/servicebay/commit/184b3ca64b1afa89db835c9c7c7aca967ca267cb))

## [3.1.0](https://github.com/mdopp/servicebay/compare/servicebay-v3.0.1...servicebay-v3.1.0) (2026-05-07)


### Features

* **updates:** readable release notes, What's-new modal, email-on-new-release ([#157](https://github.com/mdopp/servicebay/issues/157)) ([151dd64](https://github.com/mdopp/servicebay/commit/151dd64a4ea754ab658ed22523cc88deb54db85c))

## [3.0.1](https://github.com/mdopp/servicebay/compare/servicebay-v3.0.0...servicebay-v3.0.1) (2026-05-07)


### Bug Fixes

* **installer:** persist PUBLIC_DOMAIN + detect USBs without root ([#154](https://github.com/mdopp/servicebay/issues/154)) ([3afd7fc](https://github.com/mdopp/servicebay/commit/3afd7fcea3195ffac444d341a581c6bb5173509b))
* **security:** only set Secure cookie flag on HTTPS requests ([#156](https://github.com/mdopp/servicebay/issues/156)) ([95c461e](https://github.com/mdopp/servicebay/commit/95c461e5400bca4defd00cc656187ed8a785ed50))

## [3.0.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.11.0...servicebay-v3.0.0) (2026-05-07)


### ⚠ BREAKING CHANGES

* **ui:** API routes, MCP tool names, and Socket.IO events renamed from monitoring → health. Safe because there are no live installations yet.

### Features

* **ui:** add error/loading/not-found boundaries ([#151](https://github.com/mdopp/servicebay/issues/151)) ([8b47090](https://github.com/mdopp/servicebay/commit/8b47090012a091ee501241989c0e0e65b69b42f8))
* **ui:** UX pass + rename Monitoring → Health across all surfaces ([#153](https://github.com/mdopp/servicebay/issues/153)) ([c9f2f63](https://github.com/mdopp/servicebay/commit/c9f2f63a3d23c9b4395364cab065b247dab0ddae))


### Bug Fixes

* **security:** central route param validation, shell-quote agent fs, sanitize API errors ([#152](https://github.com/mdopp/servicebay/issues/152)) ([3a4c74e](https://github.com/mdopp/servicebay/commit/3a4c74ee40db2167e8e69aeb36a60662236a9c37))
* **security:** persist rate-limit, equalize login timing, drop vulnerable deps ([#149](https://github.com/mdopp/servicebay/issues/149)) ([491a956](https://github.com/mdopp/servicebay/commit/491a9568cd06ee0960aa891a2b1a8fec0a332e3a))

## [2.11.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.10.0...servicebay-v2.11.0) (2026-05-07)


### Features

* **filebrowser:** pre-promote LLDAP admin → FB admin (zero-config split) ([#146](https://github.com/mdopp/servicebay/issues/146)) ([dba5daf](https://github.com/mdopp/servicebay/commit/dba5daf3c2f501cc0adb820145895a98dd660978))


### Bug Fixes

* **security+zero-config:** cookie hardening, login rate-limit, CSRF, port-collision check ([#147](https://github.com/mdopp/servicebay/issues/147)) ([6f09a29](https://github.com/mdopp/servicebay/commit/6f09a292fa4530798e2260386c58805e3d2f364a))

## [2.10.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.9.0...servicebay-v2.10.0) (2026-05-07)


### Features

* **install:** bake PUBLIC_DOMAIN into config + auto-wire OIDC secrets ([#141](https://github.com/mdopp/servicebay/issues/141)) ([cf8c562](https://github.com/mdopp/servicebay/commit/cf8c56206dc03563a2876d78f48188f2a23d7884))
* **templates:** add filebrowser + radicale, both LDAP/SSO-wired ([#145](https://github.com/mdopp/servicebay/issues/145)) ([1b9452b](https://github.com/mdopp/servicebay/commit/1b9452be3a208fa6b1c6894c67ade31856c36818))
* **wizard:** end-of-install credentials summary + Bitwarden CSV export ([#143](https://github.com/mdopp/servicebay/issues/143)) ([c78cf9c](https://github.com/mdopp/servicebay/commit/c78cf9ca607aba1bb55bf3a6182854c8ebde0fa7))


### Bug Fixes

* **security:** close C1 + C3 + H6 from the post-2.5 audit ([#144](https://github.com/mdopp/servicebay/issues/144)) ([cb71bb2](https://github.com/mdopp/servicebay/commit/cb71bb265aab27bb9738dca9ea5fdf213e3baecd))

## [2.9.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.8.0...servicebay-v2.9.0) (2026-05-07)


### Features

* **media:** auto-seed Audiobookshelf + Navidrome admin via API ([#135](https://github.com/mdopp/servicebay/issues/135)) ([e673508](https://github.com/mdopp/servicebay/commit/e67350862fb103607fb223a2e358598d2ec93a62))
* **templates:** SSO integration for media servers + AdGuard ([#139](https://github.com/mdopp/servicebay/issues/139)) ([df907ba](https://github.com/mdopp/servicebay/commit/df907ba5c57a46cdd87f9800fdf33e852300d0a3))


### Bug Fixes

* **templates:** redis-cache deploy, full-stack contents ([#137](https://github.com/mdopp/servicebay/issues/137)) ([1b5ee57](https://github.com/mdopp/servicebay/commit/1b5ee5710017e4a9503067d13f88b53bbbdedcad))

## [2.8.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.7.0...servicebay-v2.8.0) (2026-05-06)


### Features

* **wizard:** show auto-generated secrets in configure step ([#133](https://github.com/mdopp/servicebay/issues/133)) ([0e78776](https://github.com/mdopp/servicebay/commit/0e7877683cadfc93d11aabe4dca3b042934c1197))

## [2.7.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.6.0...servicebay-v2.7.0) (2026-05-06)


### Features

* **templates:** add navidrome (music) + audiobookshelf ([#131](https://github.com/mdopp/servicebay/issues/131)) ([b394179](https://github.com/mdopp/servicebay/commit/b39417914d6b8f52bebce299c081f3520d17197f))

## [2.6.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.5.2...servicebay-v2.6.0) (2026-05-06)


### Features

* **wizard:** clean-install option to wipe existing service data ([#128](https://github.com/mdopp/servicebay/issues/128)) ([2ea84cd](https://github.com/mdopp/servicebay/commit/2ea84cd983cdf4e87e6131e329b4506cc44e5041))

## [2.5.2](https://github.com/mdopp/servicebay/compare/servicebay-v2.5.1...servicebay-v2.5.2) (2026-05-06)


### Bug Fixes

* **install:** unbreak LLDAP key handling, Authelia jwks, wizard ordering ([#126](https://github.com/mdopp/servicebay/issues/126)) ([3212108](https://github.com/mdopp/servicebay/commit/32121088d853a1d9ee6bc7227cb906e391bf1b49))

## [2.5.1](https://github.com/mdopp/servicebay/compare/servicebay-v2.5.0...servicebay-v2.5.1) (2026-05-06)


### Bug Fixes

* **install:** zero-config LLDAP, Authelia OIDC + AdGuard pre-seed ([#125](https://github.com/mdopp/servicebay/issues/125)) ([f6edf22](https://github.com/mdopp/servicebay/commit/f6edf226a1523a292b91d0929c1b7beeca68c75e))
* **onboarding:** wait for LLDAP + NPM to be ready before post-install steps ([9cc52da](https://github.com/mdopp/servicebay/commit/9cc52daa46ab7c75af49b8d03357386ce74c8255))
* real wait-for-ready logic + bootstrap NPM admin creds at deploy time ([261dff0](https://github.com/mdopp/servicebay/commit/261dff0be04e8f354c57f3aa95fadc6b7fd8cfe0))
* real wait-for-ready logic + bootstrap NPM admin creds at deploy time ([0d7e0b7](https://github.com/mdopp/servicebay/commit/0d7e0b7724726abda3c040a72a6bce731518a8b9))

## [2.5.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.4.0...servicebay-v2.5.0) (2026-05-05)


### Features

* in-app self-test — surface common gotchas without leaving the UI ([73f6d25](https://github.com/mdopp/servicebay/commit/73f6d25db47d78c1f4acca6187afc51f27139aa7))
* in-app self-test — surface common gotchas without leaving the UI ([cd82a68](https://github.com/mdopp/servicebay/commit/cd82a68b1cf73697d00db1d91ab5ed6e95418412))


### Bug Fixes

* **agent:** use --no-block on systemctl + bump default cmd timeout 10→30s ([64e40d2](https://github.com/mdopp/servicebay/commit/64e40d289620b4dbd3d1a237922f54a2146e90b3))
* **agent:** use --no-block on systemctl + bump default cmd timeout 10→30s ([c1d270e](https://github.com/mdopp/servicebay/commit/c1d270e16c47503f4d0bf7c4128fc38c35a296a7))

## [2.4.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.3.0...servicebay-v2.4.0) (2026-05-05)


### Features

* **onboarding:** show why-this-service descriptions in stack picker ([2dcbd97](https://github.com/mdopp/servicebay/commit/2dcbd976afe4b307e13993852df97f233aeac135))
* **onboarding:** show why-this-service descriptions in stack picker ([9321f9b](https://github.com/mdopp/servicebay/commit/9321f9b79415ccab7465b64dde40128b5a1183ea))


### Bug Fixes

* **image:** ship agent.py + quadlet_parser.py in the production image ([c1dbdf1](https://github.com/mdopp/servicebay/commit/c1dbdf11e6d9522a1f2805dda9bef3278863fed7))
* **image:** ship agent.py + quadlet_parser.py in the production image ([8ffb5e8](https://github.com/mdopp/servicebay/commit/8ffb5e8838c486fbf0d04baf737d927ae2fec163))
* **installer:** set AUTH_SECRET + bootstrap admin password in Quadlet env, add diagnose script ([ddcfa8a](https://github.com/mdopp/servicebay/commit/ddcfa8abc1aceffb65ba9df13ec74309f3310e16))
* **installer:** set AUTH_SECRET + bootstrap admin password in Quadlet, add diagnose script ([a2a91bf](https://github.com/mdopp/servicebay/commit/a2a91bf8f3413215dc651407a5a272a513555c0f))

## [2.3.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.2.0...servicebay-v2.3.0) (2026-05-05)


### Features

* stored NPM credentials so reverse-proxy auto-sync just works ([d8b2b15](https://github.com/mdopp/servicebay/commit/d8b2b15dbb0c059b2d00a8df6e5fb1b336450f95))
* unify service creation under /registry ([02dd6d7](https://github.com/mdopp/servicebay/commit/02dd6d7f577f654298e8cbfb05e1170677bcf388))

## [2.2.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.1.0...servicebay-v2.2.0) (2026-05-04)


### Features

* better defaults + friction cuts (auto-update, login hint, failed-service nudge) ([1cf7a1d](https://github.com/mdopp/servicebay/commit/1cf7a1d9cc67cc7bee7f1de6404c69d17290cd96))
* better defaults + friction cuts (auto-update, login hint, failed-service nudge) ([d11b807](https://github.com/mdopp/servicebay/commit/d11b8073f7a2aa1c4db96f50548f0784ba10c7c8))
* **onboarding:** collapse wizard from 8 steps to 5 ([b7abf4c](https://github.com/mdopp/servicebay/commit/b7abf4c3b5c03920b8264a6e2ad0176119598b4a))
* **onboarding:** collapse wizard from 8 steps to 5 ([0028b54](https://github.com/mdopp/servicebay/commit/0028b54ed76f72e6d564c8a9acbc7629b1f21c7e))

## [2.1.0](https://github.com/mdopp/servicebay/compare/servicebay-v2.0.0...servicebay-v2.1.0) (2026-05-04)


### Features

* expand MCP tool surface for mutating ops; rename /monitor/[name] to /services/[name] ([aafd595](https://github.com/mdopp/servicebay/commit/aafd595f326330ff6d8d232821ac01a0fd240feb))
* expand MCP tool surface; rename /monitor/[name] to /services/[name] ([6ffdca0](https://github.com/mdopp/servicebay/commit/6ffdca019e989af508d96c65541a7b874d5ce61c))
* simplify settings IA — 4 tabs, primary "restore latest" backup CTA ([cfc47aa](https://github.com/mdopp/servicebay/commit/cfc47aae2eb40741e8bf992d31859f3812a80e97))
* simplify settings IA — 4 tabs, primary restore-latest backup CTA ([fabd073](https://github.com/mdopp/servicebay/commit/fabd0739ba81e169ee071fac48019a296c9ff892))


### Bug Fixes

* **dev:** make local container dev environment work end-to-end ([5b8e771](https://github.com/mdopp/servicebay/commit/5b8e7711f692801f6751fb5bb430c3c13d9fd641))
* **dev:** make local container dev environment work end-to-end ([1f270df](https://github.com/mdopp/servicebay/commit/1f270df5c83b8a88c5f26dd0bb604228a01f685f))

## [2.0.0](https://github.com/mdopp/servicebay/compare/servicebay-v1.0.0...servicebay-v2.0.0) (2026-05-03)


### ⚠ BREAKING CHANGES

* split settings page into URL-routed tabs

### Features

* frontend usability hardening pass ([630bb1c](https://github.com/mdopp/servicebay/commit/630bb1cbee8cca5c0fa36395b5fff73e9cef26f4))
* frontend usability hardening pass ([6b55413](https://github.com/mdopp/servicebay/commit/6b55413dec5288a9cfc3036937c0cf295b1b7cc7))


### Code Refactoring

* split settings page into URL-routed tabs ([68af1bf](https://github.com/mdopp/servicebay/commit/68af1bfecbd38151fda461aa2dd0f415218539e2))

## [1.0.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.25.0...servicebay-v1.0.0) (2026-05-03)


### ⚠ BREAKING CHANGES

* monitoring HTTP checks now refuse private/loopback/ link-local addresses by default. Set MONITORING_ALLOW_INTERNAL=1 to re-enable home-lab targets (localhost, 192.168.x.x, etc.). Monitoring check targets and identifiers (container, service, host) are now rejected if they contain shell metacharacters; checks created with malformed targets stop running until edited.
* AUTH_SECRET environment variable is now required (>= 32 characters). Server refuses to start without it. Plaintext config.auth.password is replaced by config.auth.passwordHash; existing deployments must reset the admin password on first login or set SERVICEBAY_PASSWORD for one-time bootstrap.

### Features

* enforce auth on all API and Socket.IO surfaces ([ac36f2d](https://github.com/mdopp/servicebay/commit/ac36f2d5c1ca3187d9ed367229b37669d9c0dacc))
* graceful shutdown and atomic state writes ([007e149](https://github.com/mdopp/servicebay/commit/007e149e7c06aca334ef01ed269e23373bb59230))
* graceful shutdown and atomic state writes ([c9f138c](https://github.com/mdopp/servicebay/commit/c9f138c6a38fdadd95005b2de39ffc7b48f45b43))
* validate API and agent inputs with zod ([a942f4e](https://github.com/mdopp/servicebay/commit/a942f4e295f18e82f0f94bcfbc9f2a884aea5d8f))


### Bug Fixes

* move middleware.ts into src/ so Next picks it up ([60f4849](https://github.com/mdopp/servicebay/commit/60f48490846bc690daef75be10f29093dc197815))
* split auth helpers so server.ts doesn't pull in next/headers ([1aa9496](https://github.com/mdopp/servicebay/commit/1aa9496abb9faf014cf0ef7dd9a3a2e55f671948))

## [0.25.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.24.0...servicebay-v0.25.0) (2026-03-11)


### Features

* replace podman pull CLI with Podman REST API for streaming progress ([dbdbbda](https://github.com/mdopp/servicebay/commit/dbdbbda15ca1cf7733ca395a1ab7f2634316ba6f))
* streaming image pull progress via Podman REST API ([4791d29](https://github.com/mdopp/servicebay/commit/4791d2921e7a8716c6b02bc9ea09e37450f44189))

## [0.24.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.23.0...servicebay-v0.24.0) (2026-03-10)


### Features

* add configurable backup sync with monitoring and multiple fixes ([144eb94](https://github.com/mdopp/servicebay/commit/144eb941942f48f4159f55d756545b4f1844391d))
* add lldap and authelia to full-stack ([743cdbf](https://github.com/mdopp/servicebay/commit/743cdbf226ce574b0d8719bdfe0705e6fa04a157))
* add SSO (Authelia + LLDAP + OIDC) with user/group management ([c40552b](https://github.com/mdopp/servicebay/commit/c40552b177deab39e695b5ee03fbf14574a1194c))
* backup sync, monitoring, and post-install fixes ([41797d1](https://github.com/mdopp/servicebay/commit/41797d1f6a7e1223c7868eb1ab8a48233b063089))


### Bug Fixes

* hostNetwork port declarations break podman ([5464ba7](https://github.com/mdopp/servicebay/commit/5464ba7ffa88b0bf031b522f1ea35f62d25a2ef4))
* increase waitFor timeouts in OnboardingWizard tests for slow CI runners ([1b0ca86](https://github.com/mdopp/servicebay/commit/1b0ca86b5d81c6e6ec86437fb9d36379324d66df))
* network graph shows wrong gateway target IP ([17fb363](https://github.com/mdopp/servicebay/commit/17fb36356b54bfac4ba6c1b29bccf539f2f91ab7))
* only show gateway edges when port forwarding targets this node ([1e88b8e](https://github.com/mdopp/servicebay/commit/1e88b8e94cc56deecb66ac2750448536e0c6d56f))
* overhaul onboarding install flow ([f431a7a](https://github.com/mdopp/servicebay/commit/f431a7a8daabfe58efc9667f4e86f20c8101a673))
* overhaul onboarding install flow for reliable first-time setup ([e6e6d64](https://github.com/mdopp/servicebay/commit/e6e6d64553a3878f8a11ecb0d35dede7d7196878))
* registry sync fails on shallow sparse clones ([68af950](https://github.com/mdopp/servicebay/commit/68af950543a9bdbb7c391f7b545278ccd5f797a1))
* servicebay.ports annotation overrides runtime ports for hostNetwork pods ([81cb73f](https://github.com/mdopp/servicebay/commit/81cb73fb90e75508910d0cafb01cd531bf13910d))
* servicebay.ports merges with runtime ports instead of replacing them ([b3990f3](https://github.com/mdopp/servicebay/commit/b3990f354b90138db646c43a216576ae375db143))
* use actual admin port for NPM 'Open Admin UI' button ([5aad22f](https://github.com/mdopp/servicebay/commit/5aad22f9e272761223a996f3ce0f30e2454fc472))
* use servicebay.ports annotation for hostNetwork pods ([bb53151](https://github.com/mdopp/servicebay/commit/bb53151d79e4b14f8a668c2d9b0d26613c9027ee))

## [0.23.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.22.0...servicebay-v0.23.0) (2026-03-10)


### Features

* add AdGuard template, full-stack definition, and fix PORT variable collisions ([98a17eb](https://github.com/mdopp/servicebay/commit/98a17eb48a6d9cf195088ef55f414d076e45f1c3))
* add GRUB menu entry for USB boot reinstall option ([a721d2c](https://github.com/mdopp/servicebay/commit/a721d2c12b9ab2dfa17dae6ee188283abe1ed410))
* add GRUB USB boot menu for reinstall ([e62e688](https://github.com/mdopp/servicebay/commit/e62e688fe1eaadfde42a35dca12728703495aa63))
* add stack selection wizard on first boot ([5699957](https://github.com/mdopp/servicebay/commit/5699957a4b6a3d0572d17480b607f8a27019fe5e))
* auto-configure nginx proxy hosts with per-service settings and post-install checklist ([f0d689d](https://github.com/mdopp/servicebay/commit/f0d689de89068790a554192059728a443eb7c1b4))
* replace filebrowser with webdav in file-share ([12b268f](https://github.com/mdopp/servicebay/commit/12b268fb1d754c3bd5a6a3610c5b3306adb68cb7))
* replace filebrowser with webdav in file-share template ([ce148ce](https://github.com/mdopp/servicebay/commit/ce148ce75a323de32f2d7248d7eec374d64c2e09))
* stack selection wizard on first boot ([37a70d4](https://github.com/mdopp/servicebay/commit/37a70d4579d6beb157331c5aed5e45c6b9c82cf5))
* webdav file-share, RAID fixes, and hostname setup ([#83](https://github.com/mdopp/servicebay/issues/83)) ([fa238f1](https://github.com/mdopp/servicebay/commit/fa238f1414afc2d7ab255db96f2163680c2e07ce))


### Bug Fixes

* filebrowser deploy with known credentials ([29dc8f5](https://github.com/mdopp/servicebay/commit/29dc8f59836e933bf177bb98232d763e3c92f979))
* handle agent read_file response format ([7296ca6](https://github.com/mdopp/servicebay/commit/7296ca6b0577db9b35c13a23f9e73623cb1deaee))
* handle agent read_file response format correctly ([14ee149](https://github.com/mdopp/servicebay/commit/14ee149ddb6cef161912fda98f6c5616f589a372))
* initialize filebrowser with known credentials and fix hostNetwork templates ([9c89fba](https://github.com/mdopp/servicebay/commit/9c89fbab09ba02bb715939533a9fe60df97c458b))
* monitoring runner test mocks for ping checks ([9194f38](https://github.com/mdopp/servicebay/commit/9194f3840a46653470bd8d077f1e3308fde13e10))
* prompt for NPM credentials when default auth fails ([77f1279](https://github.com/mdopp/servicebay/commit/77f12795a587745d74f87b92e2d7ef1f15ac2617))
* prompt for NPM credentials when default auth fails during proxy setup ([17ba563](https://github.com/mdopp/servicebay/commit/17ba5638c9dafb99184fa9af1585e561a0ff86ad))
* stack wizard robustness ([807d296](https://github.com/mdopp/servicebay/commit/807d296bf839421e776da45da1a1cd5699a0ca96))
* stack wizard robustness — skip installed, domain prompt, NPM retry, post-install steps ([b3463c6](https://github.com/mdopp/servicebay/commit/b3463c6b334e9c12bf05a1a2c944afffad1ed762))

## [0.22.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.21.1...servicebay-v0.22.0) (2026-03-09)


### Features

* move system info into monitoring tabs, compact node selectors ([#77](https://github.com/mdopp/servicebay/issues/77)) ([3882629](https://github.com/mdopp/servicebay/commit/3882629de9704e95f763444d40e5f60a9e487684))


### Performance Improvements

* parallelize network map building and cache YAML port parsing ([#75](https://github.com/mdopp/servicebay/issues/75)) ([d296d8d](https://github.com/mdopp/servicebay/commit/d296d8df89095e7de8109185389d18df9b795918))

## [0.21.1](https://github.com/mdopp/servicebay/compare/servicebay-v0.21.0...servicebay-v0.21.1) (2026-03-09)


### Bug Fixes

* merge YAML ports with runtime ports as source of truth ([8c27882](https://github.com/mdopp/servicebay/commit/8c27882d4d0ba7289040170a513e3ac6088d7f80))
* merge YAML-defined ports with runtime-detected ports ([3f2782c](https://github.com/mdopp/servicebay/commit/3f2782cabf3d5b0fcd8aeff48c1e0921a3bf5433))

## [0.21.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.20.3...servicebay-v0.21.0) (2026-03-09)


### Features

* add server name setting for custom display name ([#70](https://github.com/mdopp/servicebay/issues/70)) ([5520f3e](https://github.com/mdopp/servicebay/commit/5520f3ee435b48599926ad6353339f048a698e1f))

## [0.20.3](https://github.com/mdopp/servicebay/compare/servicebay-v0.20.2...servicebay-v0.20.3) (2026-03-09)


### Bug Fixes

* add explicit port declarations to file-share template ([#68](https://github.com/mdopp/servicebay/issues/68)) ([b04d14e](https://github.com/mdopp/servicebay/commit/b04d14ed48c23d6b79ea5dba1a8136e94f09ba08))

## [0.20.2](https://github.com/mdopp/servicebay/compare/servicebay-v0.20.1...servicebay-v0.20.2) (2026-03-08)


### Bug Fixes

* pre-pull images, fix volume ownership, and handle privileged ports on deploy ([#66](https://github.com/mdopp/servicebay/issues/66)) ([bda7455](https://github.com/mdopp/servicebay/commit/bda7455e95101e27ad5464d27b9cf735830c0f91))

## [0.20.1](https://github.com/mdopp/servicebay/compare/servicebay-v0.20.0...servicebay-v0.20.1) (2026-03-08)


### Bug Fixes

* use stateless MCP transport pattern to fix 500 errors ([#64](https://github.com/mdopp/servicebay/issues/64)) ([af370f0](https://github.com/mdopp/servicebay/commit/af370f00c4629a99da504c8c1e84b8ff1769f471))

## [0.20.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.19.0...servicebay-v0.20.0) (2026-03-08)


### Features

* add MCP server for AI-powered ServiceBay control ([441f1ec](https://github.com/mdopp/servicebay/commit/441f1ecd426347541c5d1d26975b46d7e8dbc137))
* add MCP server with 29 tools for AI-powered ServiceBay control ([163192d](https://github.com/mdopp/servicebay/commit/163192da84e6ef4f36681f2cbac04f0b8ec1f193))


### Bug Fixes

* force agent refresh after service delete/save for instant Twin update ([624c640](https://github.com/mdopp/servicebay/commit/624c640d8e6494d388f687d65fabf00f5e3b9092))
* run filebrowser as root to fix /db permission denied ([a3e3bc2](https://github.com/mdopp/servicebay/commit/a3e3bc202c567641d17310d297e4388644f969dd))

## [0.19.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.18.4...servicebay-v0.19.0) (2026-03-08)


### Features

* add file-share template (FileBrowser + Syncthing + Samba) ([#57](https://github.com/mdopp/servicebay/issues/57)) ([cfedd4a](https://github.com/mdopp/servicebay/commit/cfedd4a63799de4463ee9223833b0ddec33d6f3f))
* smart variable inputs in installer (dropdowns, secrets, device picker) ([#60](https://github.com/mdopp/servicebay/issues/60)) ([b127110](https://github.com/mdopp/servicebay/commit/b1271100de9541254b53ab336354d2b4d9da6e91))


### Bug Fixes

* defer monitoring store mkdir to avoid build-time EACCES ([d030efa](https://github.com/mdopp/servicebay/commit/d030efa006c99de3ea439b1ac76d19b25f1cdeb5))
* enable podman.socket and unprivileged ports during deployment ([#59](https://github.com/mdopp/servicebay/issues/59)) ([1efa62e](https://github.com/mdopp/servicebay/commit/1efa62e46e5e75794f44603c06e3c99377a5b909))
* enable podman.socket on every agent connect, not just deploys ([#61](https://github.com/mdopp/servicebay/issues/61)) ([f2586d2](https://github.com/mdopp/servicebay/commit/f2586d22adac3096dd3d51069e1a1021a8fb187d))
* prefix unused connection params with underscore for lint ([ecfe4cc](https://github.com/mdopp/servicebay/commit/ecfe4cc5ad9761f98902404009efaf5195014945))
* remove test:agent step from CI workflow ([091f35b](https://github.com/mdopp/servicebay/commit/091f35b2e82772eec30bd0ff47feeafbf81e4ee1))
* remove unused connection param from getBackupDir ([ec7a9e8](https://github.com/mdopp/servicebay/commit/ec7a9e8c4e52df8c2a50cf905f073d36c94a43e4))
* remove unused connection param from getSystemdDir ([81cc56a](https://github.com/mdopp/servicebay/commit/81cc56af4a6ca2104c51112f4078e9a3b7f7f8c7))

## [0.18.4](https://github.com/mdopp/servicebay/compare/servicebay-v0.18.3...servicebay-v0.18.4) (2026-03-08)


### Bug Fixes

* Mustache HTML-escaping breaking YAML templates, ghost services after delete ([9c3705e](https://github.com/mdopp/servicebay/commit/9c3705e1e07def5b8652cec45436b7c9f8b50b50))

## [0.18.3](https://github.com/mdopp/servicebay/compare/servicebay-v0.18.2...servicebay-v0.18.3) (2026-03-08)


### Bug Fixes

* installer modal fields disappearing and show all variables transparently ([1f8a2dd](https://github.com/mdopp/servicebay/commit/1f8a2dd59d7547e19ba0b8c43af6f82aa875fb48))

## [0.18.2](https://github.com/mdopp/servicebay/compare/servicebay-v0.18.1...servicebay-v0.18.2) (2026-03-08)


### Bug Fixes

* show hostname or IP in browser tab title instead of just "ServiceBay" ([fd247e7](https://github.com/mdopp/servicebay/commit/fd247e7c8927f66f29bb7f58e25d73819fdc8d6c))

## [0.18.1](https://github.com/mdopp/servicebay/compare/servicebay-v0.18.0...servicebay-v0.18.1) (2026-03-08)


### Bug Fixes

* pre-fill global template settings in installer modal ([cf9bd41](https://github.com/mdopp/servicebay/commit/cf9bd4129b47f973b754d71a8470d073587c766d))

## [0.18.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.17.6...servicebay-v0.18.0) (2026-03-08)


### Features

* add comprehensive SSH error logging to prevent silent failures ([78b82f2](https://github.com/mdopp/servicebay/commit/78b82f24262f17cc9161a281e98a8d9759089226))
* add container mode support with SSH execution to host ([41a6451](https://github.com/mdopp/servicebay/commit/41a6451f37a9d228d4b904aa016ce84bb9398f66))
* add edit button for managed services and gateway, show node source info ([86cc63e](https://github.com/mdopp/servicebay/commit/86cc63e6df600cbaa10fb8204e61de6b5c4e1f48))
* add edit capability to network map sidebar ([bf3c7b7](https://github.com/mdopp/servicebay/commit/bf3c7b7116b2a28d9f3c341413e4969e853b9b02))
* add fixed-width column for log tags ([e32e9c3](https://github.com/mdopp/servicebay/commit/e32e9c367ac6d43b925babcc3632fe5bfdb27da2))
* add FritzBox internet connection check (TR-064) ([17ab8a2](https://github.com/mdopp/servicebay/commit/17ab8a24b8d748b1ac6aad3bed72196251780b58))
* add help system with markdown support for all plugins ([80365e5](https://github.com/mdopp/servicebay/commit/80365e557fcdcc3f9b4f784f98b18fc92907950a))
* add internet gateway and reverse proxy creation flows ([05c5912](https://github.com/mdopp/servicebay/commit/05c591242a2e094209631ec1485fb65719282b80))
* add log level control to settings page ([a68d983](https://github.com/mdopp/servicebay/commit/a68d983fb288625358b3f91122695889ea5cdeaf))
* add managed services and external links to network map ([e748986](https://github.com/mdopp/servicebay/commit/e74898634a59b62186c624a1f59fd84f1fb9cb43))
* add manual check for updates button ([16df537](https://github.com/mdopp/servicebay/commit/16df537aa50e8b211fb1cf2ee51a1dc50853caf2))
* add onboarding wizard for initial setup ([e85d5b7](https://github.com/mdopp/servicebay/commit/e85d5b7e0b1d52bdc08d0bd0bf15216784f79827))
* add responsive layout for mobile logs ([884dc40](https://github.com/mdopp/servicebay/commit/884dc40c87d60905b7feecd20b173d6d5c63343e))
* add uninstall script to clean up legacy installations ([e34ebf5](https://github.com/mdopp/servicebay/commit/e34ebf569dd58ad01336130da721eb28393d9578))
* add update progress tracking ([1711ac2](https://github.com/mdopp/servicebay/commit/1711ac2a6c6ea384e05f8ea82b0a59c68f8d6752))
* **agent:** Enhance agent logging for syncs and commands ([206a7fb](https://github.com/mdopp/servicebay/commit/206a7fbf423c351fc6135e8a31e9dd424a5ea53f))
* **agent:** Log full payload for SYNC_PARTIAL events ([1080b13](https://github.com/mdopp/servicebay/commit/1080b13c75181c79eb43d12af5c20a1c18cbcb86))
* Allow manual editing of service descriptions ([08aa897](https://github.com/mdopp/servicebay/commit/08aa8976e1f1f8b31844f656ee00479333147f4a))
* **architecture:** implement V4 Phase 1 (SSH Pool & Ephemeral Agent) ([19a3ff7](https://github.com/mdopp/servicebay/commit/19a3ff7772459a594dcc0ddcb2a5c9ecc3cfa063))
* auto-backup and restore Quadlet services across reinstalls ([c510d6a](https://github.com/mdopp/servicebay/commit/c510d6aeb9519180ff72c45e87033d481320611e))
* backup restore workflow for FCOS install, fix nginx status detection ([65b9033](https://github.com/mdopp/servicebay/commit/65b9033d2538a3bda8fe95443533d9a5e1577cf0))
* build log viewer and health monitor frontend components ([ecccd40](https://github.com/mdopp/servicebay/commit/ecccd404f5e8bb20e0c44c3674be23ce1a87737a))
* complete unattended install with boot loop prevention and settings persistence ([7645078](https://github.com/mdopp/servicebay/commit/764507808b4a60b530ffdb24e2bb556dfea5c571))
* comprehensive UX improvements ([18eb763](https://github.com/mdopp/servicebay/commit/18eb763ee115a16315488bf6f6f93fe89f166124))
* comprehensive UX improvements across all plugins ([ce54c3c](https://github.com/mdopp/servicebay/commit/ce54c3c86d345bc8e1e975750aa92ce5cf59c550))
* **config:** persist selected release channel in local config ([10e8fa9](https://github.com/mdopp/servicebay/commit/10e8fa99c6009606673975c4b890d5f27398c53b))
* CPU hardware info and Shell/SSH robustness fixes ([1ba87d5](https://github.com/mdopp/servicebay/commit/1ba87d5d0f45f32027bee1aa0066d4a2b353d81f))
* create log management and health API endpoints ([e00cc68](https://github.com/mdopp/servicebay/commit/e00cc68d812b6d0a6b1b12add10529490084ded0))
* dark mode screenshots with improved sanitization ([e318f12](https://github.com/mdopp/servicebay/commit/e318f125751265ce9def6c927d04202b7f49daac))
* display target version during installation ([f89724b](https://github.com/mdopp/servicebay/commit/f89724b3abe8531ecac2e99dffa391346c4faef9))
* enforce ssh-only control ([775b1c9](https://github.com/mdopp/servicebay/commit/775b1c91bba0a5852fa717efc196470775b97bc3))
* enhance agent health tracking with connection status and error metrics ([f15ef15](https://github.com/mdopp/servicebay/commit/f15ef1538a04bfc675344556a62ba11a015f4f13))
* enhance installer with ip detection and improve ssh error troubleshooting ([46cc882](https://github.com/mdopp/servicebay/commit/46cc88266a3794476244d0e246c85c0cbe3f031c))
* Enhance Network Graph visualization and unify node display ([71d03c5](https://github.com/mdopp/servicebay/commit/71d03c5de9bc8332f9e04f1961f9eca4f2c74854))
* enhance service discovery pipeline ([6ab0266](https://github.com/mdopp/servicebay/commit/6ab0266a53904dd8ce513e540b510a50d31cfbd3))
* Enhance service list with editable links, unified status dots, and clickable ports ([8bca352](https://github.com/mdopp/servicebay/commit/8bca352d6e7f4ae07c1112c06e19c3029117e3e7))
* enhance UX with loading toasts and refactor registry ([ba79c5f](https://github.com/mdopp/servicebay/commit/ba79c5f5763b08f85cedde994782dbf117ad9851))
* enrich twin and network metadata ([5ba0f79](https://github.com/mdopp/servicebay/commit/5ba0f790fc0d593a535e1b181a6e2c07171d1a9f))
* ensure servicebay and gateway always appear, add gateway monitoring ([01972e3](https://github.com/mdopp/servicebay/commit/01972e3489ed7abe595ff0957d732bb1c4eaddee))
* FCOS installer dependency check, templates, nginx export/import ([b52378f](https://github.com/mdopp/servicebay/commit/b52378fc5a9f43a10adefef38b2ef3f720e2fd50))
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
* implement smart auto-refresh to reduce flickering ([df5c750](https://github.com/mdopp/servicebay/commit/df5c7508ffaee3e27ea6b9bf3662346cf3f71b2e))
* improve managed bundle linking and network ui ([b632081](https://github.com/mdopp/servicebay/commit/b63208164e6507f7a87ec9f5fd7761600590894c))
* improve network map layout spacing and add status tooltips ([6c11428](https://github.com/mdopp/servicebay/commit/6c11428aa8d05713c4e8fec15bc25f88909bd915))
* improve network sidebar details and hide system containers ([40a458f](https://github.com/mdopp/servicebay/commit/40a458f1bdae0494e8ef1988b23e41d68ea0fcf6))
* improve nginx config export UX and support importing from full backups ([ef49fe4](https://github.com/mdopp/servicebay/commit/ef49fe411c16dfa3170fb677f3450be365c2dc37))
* improve unmanaged bundle review ([d53e438](https://github.com/mdopp/servicebay/commit/d53e4389a911ff70c4e2e4f177708025457497be))
* include nginx reverse proxy config in full system backup ([ed1a6e9](https://github.com/mdopp/servicebay/commit/ed1a6e99259f1cf028ea2c2384b5895df4d5607a))
* **installer:** Add version selection prompt ([3b91bc2](https://github.com/mdopp/servicebay/commit/3b91bc28a2972be110719cf9c464ee78b32d62a9))
* integrate agent health into DigitalTwinStore ([7509d3c](https://github.com/mdopp/servicebay/commit/7509d3cb93a9800506572813995d3fc19db7a49a))
* Integrate external services hub into services list and unify creation flow (Closes [#5](https://github.com/mdopp/servicebay/issues/5)) ([10ae420](https://github.com/mdopp/servicebay/commit/10ae42052c87e6fc21f28a89f941ab308e21de8d))
* introduce base image for faster builds ([7c30e29](https://github.com/mdopp/servicebay/commit/7c30e29367951a9cec414eef939d054003e24e32))
* merge nginx managed service with nginx config node ([d6efcd9](https://github.com/mdopp/servicebay/commit/d6efcd92ab82639ea4fd0d07cdff975b8342d1c7))
* merge unmanaged service bundles that share the same pod ([1f5d9da](https://github.com/mdopp/servicebay/commit/1f5d9daf8a5caf13e07ac27db112ed364f0e950f))
* merge update logic into install.sh ([6288146](https://github.com/mdopp/servicebay/commit/62881469b3cc68e7cdf58c94373c5a21c48c0dc8))
* mobile navigation, monitoring UI improvements, and updates refactor ([89a2c9d](https://github.com/mdopp/servicebay/commit/89a2c9da3bf90a881204e9b94b08531855f711e1))
* monitoring and logging improvements ([1aa78e7](https://github.com/mdopp/servicebay/commit/1aa78e72f0acc5592877fc6653a0ac5c7a47c734))
* **monitoring:** enhance agent reliability and monitoring UI ([4896008](https://github.com/mdopp/servicebay/commit/4896008cab7a203bd8fe2631787ace2964e831ce))
* **network:** implement dual-state visualization for Services and Pods ([edb168e](https://github.com/mdopp/servicebay/commit/edb168ecad4e8e066fc6f19f726e96bfd6dcc6d1))
* **network:** optimize graph generation and handle missing nodes ([835ee4c](https://github.com/mdopp/servicebay/commit/835ee4cd2c9402ed9efbf88c8e7c12a0d29486e4))
* optimize install script to use separate deps bundle ([a0f6999](https://github.com/mdopp/servicebay/commit/a0f6999cdecc0f6a23ac1265742d873a59328612))
* optimized update bundle ([039d61c](https://github.com/mdopp/servicebay/commit/039d61ccd2d9c2ba79bc3092818c73af92e1e054))
* persist ssh keys in data volume and auto-configure host remote access ([28c7742](https://github.com/mdopp/servicebay/commit/28c7742284e1e880cac49dc92254acf1c7d4a563))
* prompt for port during installation ([9c5c5d8](https://github.com/mdopp/servicebay/commit/9c5c5d8dbdee155966836e5e3e71465ddb1da243))
* real-time monitoring, live logs, history system, and deployment fixes ([f2711f0](https://github.com/mdopp/servicebay/commit/f2711f0959ec3436b7ad9843395f9e8278204239))
* rebrand to ServiceBay, add auth, setup CI/CD ([1d19632](https://github.com/mdopp/servicebay/commit/1d1963258ebad8f24c94ff0df55145b59b7836e0))
* redesign restore overlay with collapsible sections and service grouping ([d514bea](https://github.com/mdopp/servicebay/commit/d514beaf65d628fe54558e1c791a73580c8a4251))
* refine backup restore previews ([f6a0bd6](https://github.com/mdopp/servicebay/commit/f6a0bd6cf7c5b99cf830adf47e3b919577b55eec))
* **release:** add dev/test release channels and installer selection ([eb24d48](https://github.com/mdopp/servicebay/commit/eb24d4843d40f24f4a2fda34de5dd608ad73cda8))
* replace browser confirm dialogs with custom ConfirmModal ([b0f5c45](https://github.com/mdopp/servicebay/commit/b0f5c45443468916c592292f167b698bfa2c37ca))
* sanitize sensitive data in screenshot captures ([9792e29](https://github.com/mdopp/servicebay/commit/9792e29dc3d498657c2b37e65228f2411f6213fb))
* **security:** Implement configuration encryption and automatic migration ([821db55](https://github.com/mdopp/servicebay/commit/821db55c50dfa7602d7af29b57a5e5f9ba030212))
* selective file restore for service data with category-based UI ([7762c70](https://github.com/mdopp/servicebay/commit/7762c706dfb394b3ec9625777565d1a84670ccb9))
* **service-form:** add copy-all, scrollbar and replace alerts with toasts ([15d1ba4](https://github.com/mdopp/servicebay/commit/15d1ba4dc4e850f9bbaeaf9ca7e2af14d26e392b))
* **service-form:** add responsive mobile layout for volume helper ([4f1fdfa](https://github.com/mdopp/servicebay/commit/4f1fdfa938f799dc0b8f2673737c6ec1ba5574b0))
* **service-form:** moved volume helpers to sidebar layout ([811056b](https://github.com/mdopp/servicebay/commit/811056b656cabbdd07aa46da7fd87f3a1ac3c73c))
* **settings:** add node status diagnostics and edit capability ([8764c4a](https://github.com/mdopp/servicebay/commit/8764c4ae5ae3d00b09273ee56e9b7c0fe7daa01d))
* **settings:** add release channel selector to UI ([47207a4](https://github.com/mdopp/servicebay/commit/47207a4f53db5e47892d5c3527383b14c4f2f347))
* **settings:** add system connections management ([58c0017](https://github.com/mdopp/servicebay/commit/58c0017502b3b436c9a44525d56c919c41f87beb))
* show hostname in external link nodes ([dfeed3c](https://github.com/mdopp/servicebay/commit/dfeed3cb60a0e3d9993297afca0cfe2f17bfa7d6))
* show restore target path and node in service data UI ([b964f63](https://github.com/mdopp/servicebay/commit/b964f63f3df7c8464a17e0b2967a967abce93831))
* split base image into prod and dev variants ([034f558](https://github.com/mdopp/servicebay/commit/034f558d97056b8704cd68fa1aeb999fd0bd3c20))
* standardise data fetching with cache provider and notifications ([6924aa7](https://github.com/mdopp/servicebay/commit/6924aa75da7df394d921043789de3fe098bf1da9))
* support .container files and fix gateway visibility ([6e102ae](https://github.com/mdopp/servicebay/commit/6e102ae3862a890a66e3aad8e18f04c0a9685e77))
* support axel for accelerated downloads in install script ([d6f09de](https://github.com/mdopp/servicebay/commit/d6f09dee5c594c05d3d613cbd08b027a6b61a53f))
* surface referenced service urls ([1ae7c04](https://github.com/mdopp/servicebay/commit/1ae7c045e0b0f591adb70f76848466a69db879cd))
* **ui:** container actions, overlays, and ESC handling\n\n- Add shared container action overlays and ESC handling to all plugins\n- Refactor AttachedContainerList and ServiceActionBar for consistent UX\n- Add and update hooks (useContainerActions, useServiceActions)\n- Update types and serviceViewModel for container context\n- Improve overlay stacking and event propagation\n- Update ServiceForm and escape key logic for reliability ([53d2793](https://github.com/mdopp/servicebay/commit/53d279364d0765cce68164aece5dd08df270172c))
* **ui:** fix mobile layout and add version info ([61f0b9d](https://github.com/mdopp/servicebay/commit/61f0b9d96dc9ea6664afc95029e9e83cc44cc3f3))
* **ui:** improve overlay ESC handling and FileViewer UX\n\n- FileViewerOverlay now closes on ESC without closing underlying overlays\n- Overlay stacking and event propagation improved for all modals/drawers\n- Updated README to document overlay/ESC UX improvements ([a20a980](https://github.com/mdopp/servicebay/commit/a20a980e50377e5933940d488068a5100e02a635))
* **ui:** replace node selection dropdown with tabs ([b6b3ee3](https://github.com/mdopp/servicebay/commit/b6b3ee344c5adcf8a1fa68c992ee1562664569ee))
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

* add agent session tracking and cleanup ([9922bda](https://github.com/mdopp/servicebay/commit/9922bda28a7fac41e3471fcb7dd685682e11f839))
* add build tools check and error handling for native modules ([06d149a](https://github.com/mdopp/servicebay/commit/06d149a1d57630e308d9120f490f76e864f9303e))
* add diagnostic logging for reverse-proxy mount detection in backup ([8dab1f7](https://github.com/mdopp/servicebay/commit/8dab1f701299132dff33df72c406d6c46986a502))
* add diagnostics to nginx config export to debug empty results ([#43](https://github.com/mdopp/servicebay/issues/43)) ([22d869e](https://github.com/mdopp/servicebay/commit/22d869eb907553c659a60b08cca0d22fdba594c3))
* add explicit Error type to stream error handler ([aaf7950](https://github.com/mdopp/servicebay/commit/aaf7950f09f446a2902a0a860e9f93d98e4581a3))
* add fallback port in install-nginx script for empty SERVICEBAY_PORT ([7bd6b4f](https://github.com/mdopp/servicebay/commit/7bd6b4fb621ba95287c3491d6bdf152c86d2c620))
* add isManual property to NetworkEdge type definition ([9f62bbd](https://github.com/mdopp/servicebay/commit/9f62bbd713adb6006b0db28afb39bf5943036c32))
* add network map to sidebar ([8e50533](https://github.com/mdopp/servicebay/commit/8e505334217b2bc2d93eb383c2460bf6beb3ac6c))
* add packages:write permission to release workflow ([119a233](https://github.com/mdopp/servicebay/commit/119a233d281768388854318b3a1ae86ab6e07614))
* add podman to base image and resolve peer deps ([651999c](https://github.com/mdopp/servicebay/commit/651999c7cd4251c56d63f45dbe125245b3271313))
* add write permissions to release workflow ([dcc6bbb](https://github.com/mdopp/servicebay/commit/dcc6bbb71c4d355964cb413d35a975c049cda1fa))
* **agent:** correctly assign inherited ports to service object ([78d3336](https://github.com/mdopp/servicebay/commit/78d33362d610c893466b659de8b16c44a6600844))
* **agent:** guard logger binding ([d156f43](https://github.com/mdopp/servicebay/commit/d156f433da32e978d833a7d77c46c08f935338a9))
* **agent:** inject XDG_RUNTIME_DIR for local agent spawn to support systemctl ([6781629](https://github.com/mdopp/servicebay/commit/678162910e41fcf459adc15c0496661bfbccd348))
* **agent:** properly terminate podman events subprocess on shutdown to prevent leaks ([f7d21f7](https://github.com/mdopp/servicebay/commit/f7d21f74c3bf5e2bb6f3e8c8b5beb667a32d7065))
* allow husky to fail in production builds ([6097b00](https://github.com/mdopp/servicebay/commit/6097b00819e140ed4462b39f6227cd06da35a13c))
* allow user input in curl-pipe-bash installation ([3da0e97](https://github.com/mdopp/servicebay/commit/3da0e97b779cd38f8cf3cb544d81231fc66072f3))
* auto-install missing deps and check ~/.cargo/bin in CoreOS installer ([fb39488](https://github.com/mdopp/servicebay/commit/fb394880e701e54059b3c1c63d3ff00b807fe19b))
* **build:** remove unused ts directive and fix services api logic ([e40eb31](https://github.com/mdopp/servicebay/commit/e40eb3197d93973c5b3031f3f87f5a7bb262be34))
* bundle dependencies in release to avoid compilation on host ([99b1035](https://github.com/mdopp/servicebay/commit/99b103546fc80529019f21a14ddeec9367f1add8))
* bundle server.ts with esbuild to include local dependencies ([210947f](https://github.com/mdopp/servicebay/commit/210947ff0fc61cc6666df04b54961419d4a14aa5))
* **cache:** ensure getCache is stable and reads latest state to prevent unnecessary re-fetching ([83b376d](https://github.com/mdopp/servicebay/commit/83b376d85ec2496055a4ed347663556c2e3e428e))
* **ci:** Remove redundant 'run' argument from test command ([83c89a8](https://github.com/mdopp/servicebay/commit/83c89a853398dd5b4fdd42e089ea9dc91db9e217))
* **ci:** trigger release workflow on push and manual dispatch ([40c9ec6](https://github.com/mdopp/servicebay/commit/40c9ec6b4a5c6a24467cc8eb42794734a1f407cb))
* clean up install-nginx oneshot service after successful nginx install ([88d34c7](https://github.com/mdopp/servicebay/commit/88d34c77d8f70eeb52f37d8b55483623603af3cf))
* **containers:** deduplicate containers when local machine is also configured as remote node ([1b0c8c2](https://github.com/mdopp/servicebay/commit/1b0c8c267b47bf74595c7a6710f545091071a84f))
* correct log parser regex to handle milliseconds ([ced0f50](https://github.com/mdopp/servicebay/commit/ced0f508352713c2314b07b77a4fb16d1dc768d9))
* correct nodes.test.ts assertion for auto-seeded default node ([9feff46](https://github.com/mdopp/servicebay/commit/9feff464f99592f8bb551acdd1255fa1bc5ec74a))
* deploy nginx to target node and start service after install ([e93a97e](https://github.com/mdopp/servicebay/commit/e93a97e09c3761a9357fd0b8c004b589f1068ffe))
* **discovery:** prevent managed .container Quadlets from appearing as unmanaged ([bd0fac3](https://github.com/mdopp/servicebay/commit/bd0fac3f0b3e0898eaf0ea682c9ceeb099ef2cd8))
* display correct port in install success message during updates ([1ff8735](https://github.com/mdopp/servicebay/commit/1ff8735b67fac2634cd73266fcbaf85c6ce4be9f))
* **docker:** copy package.json to runtime image for version detection ([c56cdcb](https://github.com/mdopp/servicebay/commit/c56cdcbc4509311ee97d3246b99831bb042217ae))
* **docker:** explicitly install openssh-keygen to ensure availability ([40ccf60](https://github.com/mdopp/servicebay/commit/40ccf60b5a40a5538d6b7f7d19be4de761949163))
* **docker:** install missing runtime dependencies (iproute2, procps, systemd) ([578a07b](https://github.com/mdopp/servicebay/commit/578a07bd64d5d45421a46da65c7bdad4768f37e7))
* **docker:** install openssh-client to provide ssh-keygen in runner image ([7a65799](https://github.com/mdopp/servicebay/commit/7a65799a9cd6f245a6e046415c7e3fd1bbafcc8c))
* **docker:** install podman cli to enable self-update and host management ([8468f43](https://github.com/mdopp/servicebay/commit/8468f431935f116b594d6c61ebd1f18110c31240))
* drop os.hostname() fallback for browser title, use plain "ServiceBay" ([b2a77d6](https://github.com/mdopp/servicebay/commit/b2a77d6b864fb771414c0260285e286c91a73e31))
* dump mount object keys and try multiple property name variants ([7f857e3](https://github.com/mdopp/servicebay/commit/7f857e398f6033993ce56674700e51b5de051ec4))
* ensure deps tarball is created correctly in release workflow ([2e14cbc](https://github.com/mdopp/servicebay/commit/2e14cbc9dc74a12d84eb26942a15d7af1ba02a90))
* ensure logs loading state is cleared if response body is null ([e117d9f](https://github.com/mdopp/servicebay/commit/e117d9f14d09d7ffc432658d513d98ac73ed8294))
* ensure remote backup staging dir exists ([1a1762b](https://github.com/mdopp/servicebay/commit/1a1762b682f72b99188bbfbdbd04988cdd091f77))
* Ensure service description is fetched even if service is inactive ([49c4efd](https://github.com/mdopp/servicebay/commit/49c4efdfd4ef3a4859f3c16fd99546f259dfa2df))
* exclude .next directory from vitest ([0821201](https://github.com/mdopp/servicebay/commit/08212013798a1cbb88092b9fd87429dedf2e8cca))
* explicit node handling in network graph generation ([fe76b30](https://github.com/mdopp/servicebay/commit/fe76b3052802c47421d8cc856e02e3112eac3fec))
* extend timeout for long-running commands (image pull during update) ([1a65743](https://github.com/mdopp/servicebay/commit/1a65743de30c168b338dfc18fffa0976dc9ff606))
* FCOS installer - added intermediate directory entries to ensure correct user ownership of ~/.config ([d4af79d](https://github.com/mdopp/servicebay/commit/d4af79d69bc1e87a8da543beae2950621a28f0b1))
* FCOS installer - added podman.socket enablement and restart policy ([2419278](https://github.com/mdopp/servicebay/commit/2419278ddbfa211f307832ad995f89e810ad5f38))
* fetch templates from GitHub registry instead of built-in only ([74974bf](https://github.com/mdopp/servicebay/commit/74974bff5ecd6a31a7619f996e886cddcb578798))
* **frontend:** enable Service Monitor to display Gateway network data ([8c07355](https://github.com/mdopp/servicebay/commit/8c07355ed7d6dc2920864815ebcf150e09ef2d1f))
* **frontend:** ensure reverse proxy and servicebay cards appear for agent v4 services ([e6bbc4d](https://github.com/mdopp/servicebay/commit/e6bbc4d34e2cb52b85fdaf3931696e4b55b4bc5f))
* **frontend:** ensure reverse proxy card appears for agent v4 services ([a07f0cc](https://github.com/mdopp/servicebay/commit/a07f0cc9c1ea56448e490cf25b87089f0b9545d2))
* **frontend:** improve Gateway and Proxy node details ([37a7778](https://github.com/mdopp/servicebay/commit/37a7778a1feb400424882a162d9b099e923561af))
* **frontend:** improve Network Graph visibility in dark mode ([943d4fd](https://github.com/mdopp/servicebay/commit/943d4fd07c5351d3dd5a2fb9d15e8eb1b6f1a1c9))
* **frontend:** resolve aliasing for Nginx managed status and fix broken test ([030bec3](https://github.com/mdopp/servicebay/commit/030bec30a783ddec68339c82ed8678a00b69d577))
* **frontend:** update Network Graph styles for Gateway node ([f0083db](https://github.com/mdopp/servicebay/commit/f0083dbf7449a3a190858719dfc0dcd210ac1107))
* handle multi-doc yaml and localized auth prompts ([856c0b1](https://github.com/mdopp/servicebay/commit/856c0b1195aa7f070a0fee89091dac261c2e698b))
* handle native nginx installs in conf.d resolution ([30c0d56](https://github.com/mdopp/servicebay/commit/30c0d568246c8bc7d6ec91e6c86aeb2689420644))
* handle systemctl enable failure for transient units in install script ([d564e86](https://github.com/mdopp/servicebay/commit/d564e86e5b17350070a16fef08d68155bbdd13e7))
* hostname, login debug, install config backup ([6833b32](https://github.com/mdopp/servicebay/commit/6833b32ce30ae73a195a8d46ead2279e75680697))
* improve dependency check robustness and clarity ([09c287f](https://github.com/mdopp/servicebay/commit/09c287fd253a715b303b6346e7504aa8c1785ab3))
* improve network map colors for dark mode ([96e228d](https://github.com/mdopp/servicebay/commit/96e228d9a273a0e71efc8bb12bcd86bb6eaad572))
* improve pod reference detection for bundle merging ([52560ca](https://github.com/mdopp/servicebay/commit/52560caa342bdb1166b7d12fd3b9df3e059b817e))
* include next.config.ts and typescript in release bundle ([2e340a6](https://github.com/mdopp/servicebay/commit/2e340a67340dc0704c309a600b64fce39daa2f22))
* include package-lock.json in release commit ([b1d9865](https://github.com/mdopp/servicebay/commit/b1d98659003510bfdecc06d44982df58ec29d0a0))
* include package.json in release and run npm install ([15514a3](https://github.com/mdopp/servicebay/commit/15514a3ae1b5a6d000d29ea557608cc120e0efd9))
* include socket.io and node-pty in standalone build ([b74cf49](https://github.com/mdopp/servicebay/commit/b74cf498cf8b7b1f4ef8b9776a39c924d5b9e6a3))
* inject type into rawData for containers and services, improve system container filter ([1b7d92c](https://github.com/mdopp/servicebay/commit/1b7d92ca97fd1e0dee605a6f8fdc1c105f347812))
* install typescript in runner and fix permissions ([7ba8925](https://github.com/mdopp/servicebay/commit/7ba89258e5a46c4c79f200654ba85b9d37879f5a))
* **install:** display command to reveal hidden password ([6c50e77](https://github.com/mdopp/servicebay/commit/6c50e77b405853bdac013dee618f62077733c5fe))
* log mount details and accept all mount types for proxy backup ([570e5b8](https://github.com/mdopp/servicebay/commit/570e5b8350ead770851dfa41732b1876e723271b))
* monitor podman.socket instead of podman.service ([8fa7685](https://github.com/mdopp/servicebay/commit/8fa7685e3fcf83a4166a184676bd27950a90de99))
* move nginx config export/import from registry to Settings &gt; Backups ([#40](https://github.com/mdopp/servicebay/issues/40)) ([0bb6a95](https://github.com/mdopp/servicebay/commit/0bb6a95291c6be8fca50326c0bc9ab6f13f3302d))
* **network:** enforce strict localhost routing and improve port mapping logic ([3550e37](https://github.com/mdopp/servicebay/commit/3550e37f759ca4180b711a03bdd84530e1448b44))
* **network:** fallback to Quadlet definition for graph discovery ([5e07df3](https://github.com/mdopp/servicebay/commit/5e07df33b41c11dfa521a36f2fbd7f1ad634a962))
* **network:** handle Nginx targets by Name/Label and improve raw data robustness ([c999242](https://github.com/mdopp/servicebay/commit/c999242e99174cc5cfe5aebe26f1c7d1ca22f520))
* **network:** improve graph layout, grouping and styling ([2b0b7c1](https://github.com/mdopp/servicebay/commit/2b0b7c19cdddaf6bde4d92578e8726fc8217cc30))
* **network:** improve Nginx target resolution and localhost visualization ([b11aafe](https://github.com/mdopp/servicebay/commit/b11aafed03e806e576b9fdc6b52c98714e615602))
* **network:** resolve duplicated code block in service.ts caused by merge error ([6d1832d](https://github.com/mdopp/servicebay/commit/6d1832d2679be7c443bf79e9bd2a7b504d04ebf0))
* **network:** resolve incorrect network graph layout and edges ([5106fb2](https://github.com/mdopp/servicebay/commit/5106fb2972602b6492f3c8ee07143fd18ad88216))
* **network:** resolve missing raw data for Gateway node ([f04c600](https://github.com/mdopp/servicebay/commit/f04c600c37b897f6de751a86c79b2d9837dc00b4))
* nginx config export/import now targets correct node ([827f71e](https://github.com/mdopp/servicebay/commit/827f71e5fb0611531af07cd7402a63baa15509c9))
* nginx config export/import targets correct node ([9060679](https://github.com/mdopp/servicebay/commit/9060679ca2a7915b368c87a7114413e18e75ece0))
* **nodes:** disable auto-migration and fix circular dependency ([d1a8e02](https://github.com/mdopp/servicebay/commit/d1a8e02adc2ce82a05670ba6b7207b965e7e7db1))
* optimize curl download with retries and compression ([1ae681e](https://github.com/mdopp/servicebay/commit/1ae681e63a61b2331f4b28e74fbe7daeb52449f2))
* overwrite installation instead of delete-and-restore to preserve node_modules safely ([b204b81](https://github.com/mdopp/servicebay/commit/b204b81c33d0443cb47c39460308d855f0102b8e))
* parse proxy hostPath volumes from YAML files instead of container mounts ([3f61fce](https://github.com/mdopp/servicebay/commit/3f61fceab1669ba01eef8c7d25b28bb0c19ff95f))
* populate rawData for external links and show details in network sidebar ([da07c59](https://github.com/mdopp/servicebay/commit/da07c5934a0980918a01ce57a7be6f1b24c0b923))
* prevent duplicate Local node in network graph generation ([10c7c41](https://github.com/mdopp/servicebay/commit/10c7c41710e03724fa16a313732f47380db79bc4))
* prevent install-nginx oneshot from being detected as reverse proxy ([a80f45b](https://github.com/mdopp/servicebay/commit/a80f45b499e00c5d802175281eaefce0e758dbb9))
* read from /dev/tty in install script to support curl | bash ([316d69a](https://github.com/mdopp/servicebay/commit/316d69ac610ddafb419f8c7636c95f46760169f4))
* read from /dev/tty in uninstall script to support curl | bash ([e5cdff1](https://github.com/mdopp/servicebay/commit/e5cdff1effe0c5d88b2adc1e81419ea75703d50d))
* read nginx backup paths from Digital Twin container mounts ([d2d79d6](https://github.com/mdopp/servicebay/commit/d2d79d6b7b0892c88af1e0ec81746e2c43399490))
* **release:** generate latest and semver tags on Release-Please commits ([6fd918b](https://github.com/mdopp/servicebay/commit/6fd918b9999dd5ee3d98d7a33b6a059d0a8e3966))
* remove deleted UpdatesPlugin from registry ([b8671e4](https://github.com/mdopp/servicebay/commit/b8671e4214155a0ce74c9e2789496e60e1f3f13e))
* remove duplicate Local node entries in selectors ([d1728b6](https://github.com/mdopp/servicebay/commit/d1728b68a4a3e19633f3a75b7c2e37b9803263a5))
* remove implicit local node handling from network graph ([20c083f](https://github.com/mdopp/servicebay/commit/20c083f53b83d93267376343c9cccf970b46378d))
* remove prepare script before npm install in installer ([79b395f](https://github.com/mdopp/servicebay/commit/79b395fbb8cc194e5d3ef3b65d4b5f3ddd7c2b48))
* remove reverse DNS for title, use systemd %H to pass host hostname ([9dc92df](https://github.com/mdopp/servicebay/commit/9dc92df0ee9520e9149171bbb62f74360c57a657))
* remove stray command from release script ([220c8fd](https://github.com/mdopp/servicebay/commit/220c8fdb6424c4bc0d4116c96dfdcef040923181))
* remove unused backend helpers ([5257429](https://github.com/mdopp/servicebay/commit/52574292aa1ff2c8580b3aa7c96fb48ca1edf98c))
* remove unused config fetch causing build error ([570b9bc](https://github.com/mdopp/servicebay/commit/570b9bc0bd635232e08c3ad2493f3a83f17bfb57))
* remove unused remoteStream variable from watcher ([d529547](https://github.com/mdopp/servicebay/commit/d5295472eac733e606791a069055cb6ac27601df))
* resolve build errors in unmanaged bundles ([773c92d](https://github.com/mdopp/servicebay/commit/773c92d2e9682862fc815e9364d71dfdb1d7f19e))
* resolve hydration mismatch in Terminal plugin ([7b5d268](https://github.com/mdopp/servicebay/commit/7b5d26878413976f39f93da76d47f1108aea9576))
* resolve indentation issues in agent.py linking logic ([69c068b](https://github.com/mdopp/servicebay/commit/69c068b290b34acb260625f7e4252bf8f918d772))
* resolve linter errors and suppress explicit any ([948407e](https://github.com/mdopp/servicebay/commit/948407ebbe5e465db2732204bf61216a651c377c))
* resolve missing Reverse Proxy ports and linting errors ([2da19c4](https://github.com/mdopp/servicebay/commit/2da19c4d56d266dff51cea4c201f3ea3d4264893))
* resolve nginx conf.d path from Digital Twin YAML, not DATA_DIR ([#41](https://github.com/mdopp/servicebay/issues/41)) ([17fc4a8](https://github.com/mdopp/servicebay/commit/17fc4a8f0ae2069e1ddd40c380c74891ff22ba22))
* resolve real host hostname when agent runs in container ([#38](https://github.com/mdopp/servicebay/issues/38)) ([890ccd6](https://github.com/mdopp/servicebay/commit/890ccd633f72eec72cf668bf953a04d6d76fb9f8))
* resolve server name from config, env var, or reverse DNS on LAN IP ([373578a](https://github.com/mdopp/servicebay/commit/373578a70eba0ccdc9f76f72ea6ba76de9e71240))
* resolve syntax error in agent.py and remove deprecated husky config ([4db57fd](https://github.com/mdopp/servicebay/commit/4db57fd880c7bd80e4851e9e52f31b152408801b))
* resolve type error in service injection ([59fe75f](https://github.com/mdopp/servicebay/commit/59fe75f93d7e063f62ae43ec05816bc125016ace))
* resolve typescript error in executor error handling ([fd93239](https://github.com/mdopp/servicebay/commit/fd93239c6cfb95f507d9ec082e739074c87d0ed1))
* resolve updater process hang and local hostname lookup issues ([3c4c266](https://github.com/mdopp/servicebay/commit/3c4c266f397aa5483a723a37c87e3ca2c649a5c6))
* restart update via systemctl and surface pull output ([57d6b5c](https://github.com/mdopp/servicebay/commit/57d6b5c184d5cf09264631cccbc60287d70f5c52))
* restore local node support in graph generation ([e3764d2](https://github.com/mdopp/servicebay/commit/e3764d2c0c4d22f60354241dc11505e5cbd5648b))
* return 401 JSON for expired sessions on API routes instead of HTML redirect ([8b79962](https://github.com/mdopp/servicebay/commit/8b79962a0218440b66714f4cc37150607ce8ce82))
* revert curl progress bar to show download details ([b19857e](https://github.com/mdopp/servicebay/commit/b19857e2625948b0d56fcd121ebb10ef08be455a))
* robust install script and updater hidden files ([51b4e39](https://github.com/mdopp/servicebay/commit/51b4e39a9f5140eb0aeb719d275f0f25f16a627f))
* run container as root to fix volume permission issues with bind mounts ([563944d](https://github.com/mdopp/servicebay/commit/563944dd5e3db61be88f76ba52915d380dcd581c))
* scan all SSH nodes for nginx config during backup, add logging ([28caf9c](https://github.com/mdopp/servicebay/commit/28caf9cc1f2eafa07e48356f4cc1d6979ec3fb2e))
* security hardening and architecture fixes from review ([d518add](https://github.com/mdopp/servicebay/commit/d518add9f11384c0bbf5573bbb0999f90e8e5e70))
* **services:** deduplicate service aliases and add gateway ports ([4dda151](https://github.com/mdopp/servicebay/commit/4dda15165475db75fe512104dd5e5ee8189b9337))
* **services:** resolve missing ports for stopped and proxy services ([719e568](https://github.com/mdopp/servicebay/commit/719e5684f9ee4e35f8149d4967732d93451bb8cb))
* show full diagnostics inline for nginx config export/import errors ([25d4a2c](https://github.com/mdopp/servicebay/commit/25d4a2ce05ac2bea9afd75c23fbaa57674042c34))
* skip nginx install if already present from Quadlet backup ([a2f52e4](https://github.com/mdopp/servicebay/commit/a2f52e48f43e84f5e6b3a7f69bb2ce40e2e65108))
* **ssh:** provide descriptive error message on authentication failure ([5509425](https://github.com/mdopp/servicebay/commit/5509425984b2d940b81109f2484365aee74064fc))
* stabilize services plugin test selectors ([a7898c9](https://github.com/mdopp/servicebay/commit/a7898c955e758c23ee3c21b28195cd289319eab9))
* stabilize structured log rendering ([d2ca2c0](https://github.com/mdopp/servicebay/commit/d2ca2c088d5419756db000d923762bd80d90876d))
* support .kube and .container quadlet files in nginx conf.d resolution ([d1dc963](https://github.com/mdopp/servicebay/commit/d1dc963b0495c812769c9e0c0528313667c6b461))
* support Nginx Proxy Manager volume layout for config export ([288b8fb](https://github.com/mdopp/servicebay/commit/288b8fb545261e91d1074662ecf39114fbcb3685))
* switch to Nginx Proxy Manager and fix auto-install timing ([ba0ccaa](https://github.com/mdopp/servicebay/commit/ba0ccaa7ce70424fce58d4dc7316294278e62753))
* **ui:** consolidate terminal headers ([484dbeb](https://github.com/mdopp/servicebay/commit/484dbeb1b050d17b9bd8d7d2b867f4a6e3cd0d9e))
* **ui:** ensure update check notification always displays result or error ([a86db79](https://github.com/mdopp/servicebay/commit/a86db79b7d13c671465019567008c6d06bc32923))
* **ui:** prevent network sidebar header overflow ([cbf18ca](https://github.com/mdopp/servicebay/commit/cbf18cab2c100796bac330eaae00ae8e2a5a3e06))
* unblock build errors ([ccec38a](https://github.com/mdopp/servicebay/commit/ccec38ad08f8533797e562c441af8d1932c2e309))
* update Dockerfile to run custom server.ts with tsx ([abcb896](https://github.com/mdopp/servicebay/commit/abcb896556d65e0d501f1aaf6b4c9451efffa867))
* **updater:** harden version parsing and add beta channel to release workflow ([25cfb9e](https://github.com/mdopp/servicebay/commit/25cfb9eb5479aec419cbf030bc5f588abf976107))
* **updater:** remove specific service argument from podman auto-update ([6f89ccb](https://github.com/mdopp/servicebay/commit/6f89ccbca0babb647201ff1ca322d17d6c347271))
* **updater:** robust error handling for update checks and better UI feedback ([697b70d](https://github.com/mdopp/servicebay/commit/697b70d14b1ae63f4ba5d491bedf4edec1cbfa3d))
* use configured domain name for browser tab title instead of hostname ([9337907](https://github.com/mdopp/servicebay/commit/9337907e0c201a36345f2ac125cbed9ddd2848ff))
* use correct systemd path for agent-based operations ([f9ce34c](https://github.com/mdopp/servicebay/commit/f9ce34c9442bbdaeb8988670e31212d571fc585e))
* use global variable for Socket.IO instance in updater to support Next.js bundling ([91ac382](https://github.com/mdopp/servicebay/commit/91ac3821690e23dbf345a8a0ceed281c82645724))


### Performance Improvements

* Implement detailed network progress reporting and fix double-fetch issues ([3947816](https://github.com/mdopp/servicebay/commit/3947816c08b623fd699b11e314f0e2ffcdf62f5e))
* skip auto-refresh of services list if cache exists ([d8ab4f0](https://github.com/mdopp/servicebay/commit/d8ab4f09de3086dc96fdaef902e4919dc7d7b075))

## [0.17.6](https://github.com/mdopp/servicebay/compare/servicebay-v0.17.5...servicebay-v0.17.6) (2026-03-08)


### Bug Fixes

* switch to Nginx Proxy Manager and fix auto-install timing ([ba0ccaa](https://github.com/mdopp/servicebay/commit/ba0ccaa7ce70424fce58d4dc7316294278e62753))

## [0.17.5](https://github.com/mdopp/servicebay/compare/servicebay-v0.17.4...servicebay-v0.17.5) (2026-03-08)


### Bug Fixes

* auto-install missing deps and check ~/.cargo/bin in CoreOS installer ([fb39488](https://github.com/mdopp/servicebay/commit/fb394880e701e54059b3c1c63d3ff00b807fe19b))

## [0.17.4](https://github.com/mdopp/servicebay/compare/servicebay-v0.17.3...servicebay-v0.17.4) (2026-03-08)


### Bug Fixes

* clean up install-nginx oneshot service after successful nginx install ([88d34c7](https://github.com/mdopp/servicebay/commit/88d34c77d8f70eeb52f37d8b55483623603af3cf))

## [0.17.3](https://github.com/mdopp/servicebay/compare/servicebay-v0.17.2...servicebay-v0.17.3) (2026-03-08)


### Bug Fixes

* support .kube and .container quadlet files in nginx conf.d resolution ([d1dc963](https://github.com/mdopp/servicebay/commit/d1dc963b0495c812769c9e0c0528313667c6b461))

## [0.17.2](https://github.com/mdopp/servicebay/compare/servicebay-v0.17.1...servicebay-v0.17.2) (2026-03-08)


### Bug Fixes

* handle native nginx installs in conf.d resolution ([30c0d56](https://github.com/mdopp/servicebay/commit/30c0d568246c8bc7d6ec91e6c86aeb2689420644))
* return 401 JSON for expired sessions on API routes instead of HTML redirect ([8b79962](https://github.com/mdopp/servicebay/commit/8b79962a0218440b66714f4cc37150607ce8ce82))

## [0.17.1](https://github.com/mdopp/servicebay/compare/servicebay-v0.17.0...servicebay-v0.17.1) (2026-03-08)


### Bug Fixes

* support Nginx Proxy Manager volume layout for config export ([288b8fb](https://github.com/mdopp/servicebay/commit/288b8fb545261e91d1074662ecf39114fbcb3685))

## [0.17.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.16.4...servicebay-v0.17.0) (2026-03-08)


### Features

* improve nginx config export UX and support importing from full backups ([ef49fe4](https://github.com/mdopp/servicebay/commit/ef49fe411c16dfa3170fb677f3450be365c2dc37))


### Bug Fixes

* show full diagnostics inline for nginx config export/import errors ([25d4a2c](https://github.com/mdopp/servicebay/commit/25d4a2ce05ac2bea9afd75c23fbaa57674042c34))

## [0.16.4](https://github.com/mdopp/servicebay/compare/servicebay-v0.16.3...servicebay-v0.16.4) (2026-03-08)


### Bug Fixes

* add diagnostics to nginx config export to debug empty results ([#43](https://github.com/mdopp/servicebay/issues/43)) ([22d869e](https://github.com/mdopp/servicebay/commit/22d869eb907553c659a60b08cca0d22fdba594c3))

## [0.16.3](https://github.com/mdopp/servicebay/compare/servicebay-v0.16.2...servicebay-v0.16.3) (2026-03-08)


### Bug Fixes

* resolve nginx conf.d path from Digital Twin YAML, not DATA_DIR ([#41](https://github.com/mdopp/servicebay/issues/41)) ([17fc4a8](https://github.com/mdopp/servicebay/commit/17fc4a8f0ae2069e1ddd40c380c74891ff22ba22))

## [0.16.2](https://github.com/mdopp/servicebay/compare/servicebay-v0.16.1...servicebay-v0.16.2) (2026-03-08)


### Bug Fixes

* move nginx config export/import from registry to Settings &gt; Backups ([#40](https://github.com/mdopp/servicebay/issues/40)) ([0bb6a95](https://github.com/mdopp/servicebay/commit/0bb6a95291c6be8fca50326c0bc9ab6f13f3302d))
* resolve real host hostname when agent runs in container ([#38](https://github.com/mdopp/servicebay/issues/38)) ([890ccd6](https://github.com/mdopp/servicebay/commit/890ccd633f72eec72cf668bf953a04d6d76fb9f8))

## [0.16.1](https://github.com/mdopp/servicebay/compare/servicebay-v0.16.0...servicebay-v0.16.1) (2026-03-08)


### Bug Fixes

* nginx config export/import now targets correct node ([827f71e](https://github.com/mdopp/servicebay/commit/827f71e5fb0611531af07cd7402a63baa15509c9))
* nginx config export/import targets correct node ([9060679](https://github.com/mdopp/servicebay/commit/9060679ca2a7915b368c87a7114413e18e75ece0))

## [0.16.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.15.0...servicebay-v0.16.0) (2026-03-08)


### Features

* comprehensive UX improvements ([18eb763](https://github.com/mdopp/servicebay/commit/18eb763ee115a16315488bf6f6f93fe89f166124))
* comprehensive UX improvements across all plugins ([ce54c3c](https://github.com/mdopp/servicebay/commit/ce54c3c86d345bc8e1e975750aa92ce5cf59c550))


### Bug Fixes

* add fallback port in install-nginx script for empty SERVICEBAY_PORT ([7bd6b4f](https://github.com/mdopp/servicebay/commit/7bd6b4fb621ba95287c3491d6bdf152c86d2c620))

## [0.15.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.14.0...servicebay-v0.15.0) (2026-03-07)


### Features

* show restore target path and node in service data UI ([b964f63](https://github.com/mdopp/servicebay/commit/b964f63f3df7c8464a17e0b2967a967abce93831))


### Bug Fixes

* deploy nginx to target node and start service after install ([e93a97e](https://github.com/mdopp/servicebay/commit/e93a97e09c3761a9357fd0b8c004b589f1068ffe))

## [0.14.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.13.0...servicebay-v0.14.0) (2026-03-07)


### Features

* selective file restore for service data with category-based UI ([7762c70](https://github.com/mdopp/servicebay/commit/7762c706dfb394b3ec9625777565d1a84670ccb9))


### Bug Fixes

* remove reverse DNS for title, use systemd %H to pass host hostname ([9dc92df](https://github.com/mdopp/servicebay/commit/9dc92df0ee9520e9149171bbb62f74360c57a657))

## [0.13.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.12.6...servicebay-v0.13.0) (2026-03-07)


### Features

* redesign restore overlay with collapsible sections and service grouping ([d514bea](https://github.com/mdopp/servicebay/commit/d514beaf65d628fe54558e1c791a73580c8a4251))


### Bug Fixes

* drop os.hostname() fallback for browser title, use plain "ServiceBay" ([b2a77d6](https://github.com/mdopp/servicebay/commit/b2a77d6b864fb771414c0260285e286c91a73e31))
* resolve server name from config, env var, or reverse DNS on LAN IP ([373578a](https://github.com/mdopp/servicebay/commit/373578a70eba0ccdc9f76f72ea6ba76de9e71240))
* security hardening and architecture fixes from review ([d518add](https://github.com/mdopp/servicebay/commit/d518add9f11384c0bbf5573bbb0999f90e8e5e70))
* use configured domain name for browser tab title instead of hostname ([9337907](https://github.com/mdopp/servicebay/commit/9337907e0c201a36345f2ac125cbed9ddd2848ff))

## [0.12.6](https://github.com/mdopp/servicebay/compare/servicebay-v0.12.5...servicebay-v0.12.6) (2026-03-07)


### Bug Fixes

* parse proxy hostPath volumes from YAML files instead of container mounts ([3f61fce](https://github.com/mdopp/servicebay/commit/3f61fceab1669ba01eef8c7d25b28bb0c19ff95f))

## [0.12.5](https://github.com/mdopp/servicebay/compare/servicebay-v0.12.4...servicebay-v0.12.5) (2026-03-07)


### Bug Fixes

* dump mount object keys and try multiple property name variants ([7f857e3](https://github.com/mdopp/servicebay/commit/7f857e398f6033993ce56674700e51b5de051ec4))

## [0.12.4](https://github.com/mdopp/servicebay/compare/servicebay-v0.12.3...servicebay-v0.12.4) (2026-03-07)


### Bug Fixes

* log mount details and accept all mount types for proxy backup ([570e5b8](https://github.com/mdopp/servicebay/commit/570e5b8350ead770851dfa41732b1876e723271b))

## [0.12.3](https://github.com/mdopp/servicebay/compare/servicebay-v0.12.2...servicebay-v0.12.3) (2026-03-07)


### Bug Fixes

* add diagnostic logging for reverse-proxy mount detection in backup ([8dab1f7](https://github.com/mdopp/servicebay/commit/8dab1f701299132dff33df72c406d6c46986a502))

## [0.12.2](https://github.com/mdopp/servicebay/compare/servicebay-v0.12.1...servicebay-v0.12.2) (2026-03-07)


### Bug Fixes

* read nginx backup paths from Digital Twin container mounts ([d2d79d6](https://github.com/mdopp/servicebay/commit/d2d79d6b7b0892c88af1e0ec81746e2c43399490))

## [0.12.1](https://github.com/mdopp/servicebay/compare/servicebay-v0.12.0...servicebay-v0.12.1) (2026-03-07)


### Bug Fixes

* scan all SSH nodes for nginx config during backup, add logging ([28caf9c](https://github.com/mdopp/servicebay/commit/28caf9cc1f2eafa07e48356f4cc1d6979ec3fb2e))

## [0.12.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.11.0...servicebay-v0.12.0) (2026-03-07)


### Features

* backup restore workflow for FCOS install, fix nginx status detection ([65b9033](https://github.com/mdopp/servicebay/commit/65b9033d2538a3bda8fe95443533d9a5e1577cf0))
* include nginx reverse proxy config in full system backup ([ed1a6e9](https://github.com/mdopp/servicebay/commit/ed1a6e99259f1cf028ea2c2384b5895df4d5607a))

## [0.11.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.10.3...servicebay-v0.11.0) (2026-03-07)


### Features

* auto-backup and restore Quadlet services across reinstalls ([c510d6a](https://github.com/mdopp/servicebay/commit/c510d6aeb9519180ff72c45e87033d481320611e))
* complete unattended install with boot loop prevention and settings persistence ([7645078](https://github.com/mdopp/servicebay/commit/764507808b4a60b530ffdb24e2bb556dfea5c571))
* FCOS installer dependency check, templates, nginx export/import ([b52378f](https://github.com/mdopp/servicebay/commit/b52378fc5a9f43a10adefef38b2ef3f720e2fd50))


### Bug Fixes

* skip nginx install if already present from Quadlet backup ([a2f52e4](https://github.com/mdopp/servicebay/commit/a2f52e48f43e84f5e6b3a7f69bb2ce40e2e65108))
* use correct systemd path for agent-based operations ([f9ce34c](https://github.com/mdopp/servicebay/commit/f9ce34c9442bbdaeb8988670e31212d571fc585e))

## [0.10.3](https://github.com/mdopp/servicebay/compare/servicebay-v0.10.2...servicebay-v0.10.3) (2026-01-20)


### Bug Fixes

* extend timeout for long-running commands (image pull during update) ([1a65743](https://github.com/mdopp/servicebay/commit/1a65743de30c168b338dfc18fffa0976dc9ff606))
* restart update via systemctl and surface pull output ([57d6b5c](https://github.com/mdopp/servicebay/commit/57d6b5c184d5cf09264631cccbc60287d70f5c52))

## [0.10.2](https://github.com/mdopp/servicebay/compare/servicebay-v0.10.1...servicebay-v0.10.2) (2026-01-20)


### Bug Fixes

* prevent duplicate Local node in network graph generation ([10c7c41](https://github.com/mdopp/servicebay/commit/10c7c41710e03724fa16a313732f47380db79bc4))

## [0.10.1](https://github.com/mdopp/servicebay/compare/servicebay-v0.10.0...servicebay-v0.10.1) (2026-01-20)


### Bug Fixes

* remove duplicate Local node entries in selectors ([d1728b6](https://github.com/mdopp/servicebay/commit/d1728b68a4a3e19633f3a75b7c2e37b9803263a5))

## [0.10.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.9.0...servicebay-v0.10.0) (2026-01-20)


### Features

* dark mode screenshots with improved sanitization ([e318f12](https://github.com/mdopp/servicebay/commit/e318f125751265ce9def6c927d04202b7f49daac))
* enforce ssh-only control ([775b1c9](https://github.com/mdopp/servicebay/commit/775b1c91bba0a5852fa717efc196470775b97bc3))
* sanitize sensitive data in screenshot captures ([9792e29](https://github.com/mdopp/servicebay/commit/9792e29dc3d498657c2b37e65228f2411f6213fb))


### Bug Fixes

* add explicit Error type to stream error handler ([aaf7950](https://github.com/mdopp/servicebay/commit/aaf7950f09f446a2902a0a860e9f93d98e4581a3))
* correct nodes.test.ts assertion for auto-seeded default node ([9feff46](https://github.com/mdopp/servicebay/commit/9feff464f99592f8bb551acdd1255fa1bc5ec74a))
* remove unused remoteStream variable from watcher ([d529547](https://github.com/mdopp/servicebay/commit/d5295472eac733e606791a069055cb6ac27601df))

## [0.9.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.8.0...servicebay-v0.9.0) (2026-01-19)


### Features

* add comprehensive SSH error logging to prevent silent failures ([78b82f2](https://github.com/mdopp/servicebay/commit/78b82f24262f17cc9161a281e98a8d9759089226))
* add container mode support with SSH execution to host ([41a6451](https://github.com/mdopp/servicebay/commit/41a6451f37a9d228d4b904aa016ce84bb9398f66))
* enhance service discovery pipeline ([6ab0266](https://github.com/mdopp/servicebay/commit/6ab0266a53904dd8ce513e540b510a50d31cfbd3))
* enrich twin and network metadata ([5ba0f79](https://github.com/mdopp/servicebay/commit/5ba0f790fc0d593a535e1b181a6e2c07171d1a9f))
* improve managed bundle linking and network ui ([b632081](https://github.com/mdopp/servicebay/commit/b63208164e6507f7a87ec9f5fd7761600590894c))
* improve unmanaged bundle review ([d53e438](https://github.com/mdopp/servicebay/commit/d53e4389a911ff70c4e2e4f177708025457497be))
* merge unmanaged service bundles that share the same pod ([1f5d9da](https://github.com/mdopp/servicebay/commit/1f5d9daf8a5caf13e07ac27db112ed364f0e950f))
* refine backup restore previews ([f6a0bd6](https://github.com/mdopp/servicebay/commit/f6a0bd6cf7c5b99cf830adf47e3b919577b55eec))
* surface referenced service urls ([1ae7c04](https://github.com/mdopp/servicebay/commit/1ae7c045e0b0f591adb70f76848466a69db879cd))
* **ui:** container actions, overlays, and ESC handling\n\n- Add shared container action overlays and ESC handling to all plugins\n- Refactor AttachedContainerList and ServiceActionBar for consistent UX\n- Add and update hooks (useContainerActions, useServiceActions)\n- Update types and serviceViewModel for container context\n- Improve overlay stacking and event propagation\n- Update ServiceForm and escape key logic for reliability ([53d2793](https://github.com/mdopp/servicebay/commit/53d279364d0765cce68164aece5dd08df270172c))
* **ui:** improve overlay ESC handling and FileViewer UX\n\n- FileViewerOverlay now closes on ESC without closing underlying overlays\n- Overlay stacking and event propagation improved for all modals/drawers\n- Updated README to document overlay/ESC UX improvements ([a20a980](https://github.com/mdopp/servicebay/commit/a20a980e50377e5933940d488068a5100e02a635))


### Bug Fixes

* add agent session tracking and cleanup ([9922bda](https://github.com/mdopp/servicebay/commit/9922bda28a7fac41e3471fcb7dd685682e11f839))
* **agent:** guard logger binding ([d156f43](https://github.com/mdopp/servicebay/commit/d156f433da32e978d833a7d77c46c08f935338a9))
* ensure remote backup staging dir exists ([1a1762b](https://github.com/mdopp/servicebay/commit/1a1762b682f72b99188bbfbdbd04988cdd091f77))
* improve pod reference detection for bundle merging ([52560ca](https://github.com/mdopp/servicebay/commit/52560caa342bdb1166b7d12fd3b9df3e059b817e))
* remove unused backend helpers ([5257429](https://github.com/mdopp/servicebay/commit/52574292aa1ff2c8580b3aa7c96fb48ca1edf98c))
* resolve build errors in unmanaged bundles ([773c92d](https://github.com/mdopp/servicebay/commit/773c92d2e9682862fc815e9364d71dfdb1d7f19e))
* resolve hydration mismatch in Terminal plugin ([7b5d268](https://github.com/mdopp/servicebay/commit/7b5d26878413976f39f93da76d47f1108aea9576))
* stabilize services plugin test selectors ([a7898c9](https://github.com/mdopp/servicebay/commit/a7898c955e758c23ee3c21b28195cd289319eab9))
* stabilize structured log rendering ([d2ca2c0](https://github.com/mdopp/servicebay/commit/d2ca2c088d5419756db000d923762bd80d90876d))
* unblock build errors ([ccec38a](https://github.com/mdopp/servicebay/commit/ccec38ad08f8533797e562c441af8d1932c2e309))

## [0.8.0](https://github.com/mdopp/servicebay/compare/servicebay-v0.7.1...servicebay-v0.8.0) (2026-01-14)


### Features

* add fixed-width column for log tags ([e32e9c3](https://github.com/mdopp/servicebay/commit/e32e9c367ac6d43b925babcc3632fe5bfdb27da2))
* add log level control to settings page ([a68d983](https://github.com/mdopp/servicebay/commit/a68d983fb288625358b3f91122695889ea5cdeaf))
* add responsive layout for mobile logs ([884dc40](https://github.com/mdopp/servicebay/commit/884dc40c87d60905b7feecd20b173d6d5c63343e))
* **agent:** Enhance agent logging for syncs and commands ([206a7fb](https://github.com/mdopp/servicebay/commit/206a7fbf423c351fc6135e8a31e9dd424a5ea53f))
* **agent:** Log full payload for SYNC_PARTIAL events ([1080b13](https://github.com/mdopp/servicebay/commit/1080b13c75181c79eb43d12af5c20a1c18cbcb86))
* build log viewer and health monitor frontend components ([ecccd40](https://github.com/mdopp/servicebay/commit/ecccd404f5e8bb20e0c44c3674be23ce1a87737a))
* create log management and health API endpoints ([e00cc68](https://github.com/mdopp/servicebay/commit/e00cc68d812b6d0a6b1b12add10529490084ded0))
* enhance agent health tracking with connection status and error metrics ([f15ef15](https://github.com/mdopp/servicebay/commit/f15ef1538a04bfc675344556a62ba11a015f4f13))
* implement smart auto-refresh to reduce flickering ([df5c750](https://github.com/mdopp/servicebay/commit/df5c7508ffaee3e27ea6b9bf3662346cf3f71b2e))
* integrate agent health into DigitalTwinStore ([7509d3c](https://github.com/mdopp/servicebay/commit/7509d3cb93a9800506572813995d3fc19db7a49a))
* monitoring and logging improvements ([1aa78e7](https://github.com/mdopp/servicebay/commit/1aa78e72f0acc5592877fc6653a0ac5c7a47c734))
* **monitoring:** enhance agent reliability and monitoring UI ([4896008](https://github.com/mdopp/servicebay/commit/4896008cab7a203bd8fe2631787ace2964e831ce))
* **ui:** fix mobile layout and add version info ([61f0b9d](https://github.com/mdopp/servicebay/commit/61f0b9d96dc9ea6664afc95029e9e83cc44cc3f3))
* **ui:** replace node selection dropdown with tabs ([b6b3ee3](https://github.com/mdopp/servicebay/commit/b6b3ee344c5adcf8a1fa68c992ee1562664569ee))


### Bug Fixes

* correct log parser regex to handle milliseconds ([ced0f50](https://github.com/mdopp/servicebay/commit/ced0f508352713c2314b07b77a4fb16d1dc768d9))

## [0.7.1](https://github.com/mdopp/servicebay/compare/servicebay-v0.7.0...servicebay-v0.7.1) (2026-01-13)


### Bug Fixes

* **release:** generate latest and semver tags on Release-Please commits ([6fd918b](https://github.com/mdopp/servicebay/commit/6fd918b9999dd5ee3d98d7a33b6a059d0a8e3966))

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
- **Settings**: New "Template Settings" section to configure global stack variables (e.g., `DATA_DIR`), enabling portable and reusable service templates.
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
