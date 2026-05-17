/**
 * Versioned contract between templates and the internal `/api/system/*`
 * endpoints they call from `post-deploy.py` (#588).
 *
 * Templates declare which API version they need via per-API annotations:
 *
 *   metadata:
 *     annotations:
 *       servicebay.requires-api.lldap: "1"
 *       servicebay.requires-api.authelia: "1"
 *
 * Before invoking `post-deploy.py`, ServiceManager.deployKubeService
 * calls `assertApiCompat(manifest)` — if any requested version exceeds
 * what core ships, the deploy fails-fast with a clear error instead of
 * silently breaking against a renamed endpoint.
 *
 * Bumping a version:
 *   1. Change SUPPORTED_API_VERSIONS below.
 *   2. Update every bundled template that calls the affected API.
 *   3. Document the break in CHANGELOG.
 */

export type TemplateApiName = 'lldap' | 'authelia' | 'portal';
export type TemplateApiVersions = Partial<Record<TemplateApiName, number>>;

/**
 * Current API surface this core ships. Bump only when the wire shape of
 * `/api/system/<api>/*` changes (rename, payload field rename, status-
 * code semantics shift). Tests pin this constant so a bump can't slip
 * into a release without a deliberate decision.
 */
export const SUPPORTED_API_VERSIONS: Readonly<Record<TemplateApiName, number>> = {
  lldap: 1,
  authelia: 1,
  portal: 1,
};

/** Throws with a clear message if the template needs an API version core can't satisfy. */
export function assertApiCompat(
  templateName: string,
  requested: TemplateApiVersions | undefined,
): void {
  if (!requested) return;
  for (const [api, need] of Object.entries(requested) as Array<[TemplateApiName, number]>) {
    if (!(api in SUPPORTED_API_VERSIONS)) {
      throw new Error(
        `Template "${templateName}" requests unknown API "${api}". ` +
        `Supported APIs: ${Object.keys(SUPPORTED_API_VERSIONS).join(', ')}.`,
      );
    }
    const supported = SUPPORTED_API_VERSIONS[api];
    if (typeof need !== 'number' || need < 1) {
      throw new Error(
        `Template "${templateName}" requests invalid version "${need}" for API "${api}".`,
      );
    }
    if (need > supported) {
      throw new Error(
        `Template "${templateName}" needs ${api} API v${need}; ` +
        `this ServiceBay ships v${supported}. ` +
        `Upgrade ServiceBay or pin the template to an older version.`,
      );
    }
  }
}
