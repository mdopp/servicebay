/**
 * Probe barrel (#592). Side-effect imports — each probe self-registers
 * via `registerProbe(...)` at module load. Importing this barrel from
 * `CheckRunner.run` ensures every probe is in the registry before
 * dispatch.
 *
 * Adding a new probe: drop a file in this directory + add it here.
 */

import './basic';
import './domain';
import './letsdebug';
import './lanIpDrift';
import './npmAuthProbe';
import './certExpiry';
import './certRequestFailure';
import './nginxConfigValid';
// dnsRouting no longer self-registers a probe type (#1564 collapsed the
// per-domain `dns_routing` rows into the canonical `domain` check). Its
// `resolveDnsRouting` helper is imported directly by the `domain` probe.
