# Changelog

All notable changes to this project will be documented in this file.

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
