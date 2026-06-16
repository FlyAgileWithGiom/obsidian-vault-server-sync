import type { SecretStore } from "./secret-store";
import {
  SECRET_ID_GATEWAY_CLIENT_ID,
  SECRET_ID_GATEWAY_CLIENT_SECRET,
} from "./secret-store";

// Cap how much of a non-credential provision error body we surface (reaches logs/UI).
const PROVISION_ERROR_BODY_MAX = 200;

/**
 * Provision response shape from POST /credentials/provision (mcp-gateway PR #2).
 *
 * 201 (first-time creation):
 *   { client_id, client_secret, token_endpoint, vault_db: null }
 * 200 (already provisioned — secret not returned again):
 *   { client_id, secret_already_provisioned: true }
 * 401 → bad bootstrap token
 * 403 → user_id mismatch
 * 503 → provisioning disabled on the gateway
 */
interface ProvisionResponse201 {
  client_id: string;
  client_secret: string;
  token_endpoint: string;
  vault_db: null;
}

interface ProvisionResponse200 {
  client_id: string;
  secret_already_provisioned: true;
}

export type ProvisionResult = "created" | "already-provisioned";

/**
 * Options for provisionGatewayCredential.
 *
 * `fetch` is injectable so unit tests can pass a mock without stubbing the
 * global — same pattern as the token manager tests in gateway-fetch.test.ts.
 */
export interface ProvisionOpts {
  gatewayUrl: string;
  bootstrapToken: string;
  userId: string;
  store: SecretStore;
  fetch?: typeof globalThis.fetch;
}

/**
 * Provision (or detect an already-provisioned) gateway credential.
 *
 * Calls POST {gatewayUrl}/credentials/provision with the bootstrap token and
 * the user's Clerk sub (`userId`). On first-time creation (HTTP 201), stores
 * `client_id` and `client_secret` in the secret store and returns "created".
 * On re-provision (HTTP 200 + secret_already_provisioned), the secret is NOT
 * re-returned so we do NOT touch the store — the existing stored secret is
 * still valid — and returns "already-provisioned".
 *
 * Throws for error responses, with the HTTP status in the message:
 *   401 → bad bootstrap token
 *   403 → user_id does not match the allowed owner
 *   503 → provisioning disabled
 *   other non-2xx → generic error
 *
 * Why injectable fetch: the function is runtime-agnostic (browser + Node). Tests
 * supply a mock fetch to assert the exact request shape without a live gateway.
 */
export async function provisionGatewayCredential(opts: ProvisionOpts): Promise<ProvisionResult> {
  const { gatewayUrl, bootstrapToken, userId, store } = opts;
  const fetchFn = opts.fetch ?? globalThis.fetch;

  const url = `${gatewayUrl.replace(/\/$/, "")}/credentials/provision`;

  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bootstrapToken}`,
    },
    body: JSON.stringify({ user_id: userId }),
  });

  if (!resp.ok) {
    // 401/403 mean a bad/forbidden bootstrap token — surface no body (it may echo
    // the submitted token). For other errors, cap the body; this reaches logs/UI.
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        `Gateway /credentials/provision returned ${resp.status} (bootstrap token rejected)`,
      );
    }
    const detail = (await resp.text().catch(() => "")).slice(0, PROVISION_ERROR_BODY_MAX);
    throw new Error(
      `Gateway /credentials/provision returned ${resp.status}: ${detail}`,
    );
  }

  if (resp.status === 201) {
    const data = (await resp.json()) as ProvisionResponse201;
    // Store both credentials so the token manager can pick them up on next start.
    // Write unconditionally: a 201 always delivers a fresh secret.
    await store.set(SECRET_ID_GATEWAY_CLIENT_ID, data.client_id);
    await store.set(SECRET_ID_GATEWAY_CLIENT_SECRET, data.client_secret);
    return "created";
  }

  // HTTP 200 with { client_id, secret_already_provisioned: true }.
  // The secret is NOT re-returned; the store already holds the valid credentials.
  // Do NOT overwrite — an incorrect overwrite here would invalidate the stored secret.
  const data = (await resp.json()) as ProvisionResponse200;
  if (data.secret_already_provisioned) {
    return "already-provisioned";
  }

  // Unexpected 2xx shape — treat as created but warn. Should not happen in practice.
  // (Defensive: the gateway contract defines only 200 and 201 as success codes.)
  console.warn("[vault-sync] provision: unexpected 2xx body from gateway — treating as created");
  return "created";
}
