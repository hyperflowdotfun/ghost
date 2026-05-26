/**
 * Registry constants — where Ghost publishes its package and where
 * `ghost update` / the version-check service fetch from. Operators can
 * override via the `GHOST_REGISTRY` env var (useful for testing or for
 * pointing a CI fleet at an internal mirror).
 */

export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/";

export const PACKAGE_NAME = "@hyperflow.fun/ghost";

/**
 * Resolve the registry URL. Returns with a trailing slash so endpoints
 * can be composed via plain concatenation.
 */
export function getRegistryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["GHOST_REGISTRY"];
  const url = raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_REGISTRY_URL;
  return url.endsWith("/") ? url : `${url}/`;
}
