import type { SecretStore } from "../src/secret-store";
import {
  resolveSecret,
  SECRET_ID_GATEWAY_CLIENT_ID,
  SECRET_ID_GATEWAY_REFRESH_TOKEN,
  ENV_GATEWAY_CLIENT_ID,
} from "../src/secret-store";
import { makeTokenManager, makeGatewayFetch } from "../src/gateway-fetch";
import type { GatewayCredsResolver } from "../src/PouchDbSyncEngine";

/**
 * Build the daemon's GatewayCredsResolver: the seam the PouchDbSyncEngine calls
 * at sync start to decide gateway (Bearer) vs Phase-A (legacy Basic) mode.
 *
 * Mode is decided per-call (not at construction) so a fresh `--login` between
 * restarts naturally promotes the daemon to gateway mode without re-wiring:
 *   - client_id available (env > store) AND a refresh token is stored
 *       -> returns a Bearer-injecting fetch (token manager + makeGatewayFetch).
 *   - either credential missing
 *       -> returns null, so the engine falls back to the legacy Basic-auth URL.
 *
 * Building the token manager is cheap and side-effect-free; the actual refresh
 * round-trip happens lazily on the first request through the returned fetch.
 */
/**
 * Resolve the public gateway client_id by the locked precedence env > store.
 *
 * There is no in-vault legacy for the gateway client_id (it is not a secret and
 * predates no file), so the `legacy` fallback is "" — an absent client_id yields
 * "" and the caller treats that as "not in gateway mode". Shared by the resolver
 * and the phantom-check wiring so the two never diverge on which client_id wins.
 */
export async function resolveGatewayClientId(opts: {
  store: SecretStore;
  env?: Record<string, string | undefined>;
}): Promise<string> {
  return resolveSecret({
    envName: ENV_GATEWAY_CLIENT_ID,
    env: opts.env ?? process.env,
    store: opts.store,
    id: SECRET_ID_GATEWAY_CLIENT_ID,
    legacy: "",
  });
}

export function buildGatewayCredsResolver(opts: {
  gatewayUrl: string;
  store: SecretStore;
  env?: Record<string, string | undefined>;
}): GatewayCredsResolver {
  const { gatewayUrl, store } = opts;
  const env = opts.env ?? process.env;

  return async (): Promise<typeof fetch | null> => {
    // client_id: env override wins (operator/CI), else the persisted value.
    const clientId = await resolveGatewayClientId({ store, env });
    if (!clientId) return null;

    // No refresh token means the daemon has not logged in — stay on the legacy
    // path rather than throwing, so an un-migrated daemon keeps syncing.
    const refreshToken = await store.get(SECRET_ID_GATEWAY_REFRESH_TOKEN);
    if (!refreshToken) return null;

    const tokenManager = makeTokenManager({ gatewayUrl, clientId, store });
    return makeGatewayFetch({ tokenManager });
  };
}
