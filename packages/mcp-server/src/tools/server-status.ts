/**
 * mba_server_status — health/liveness probe for the global MBA service.
 *
 * Thin wrapper over GET /status. Returns the service version, uptime, and
 * the on-disk paths it owns.
 */
import {
  fetchStatus,
  type MbaServiceClientOptions,
  type MbaStatusResult,
} from "../service-client.js";

export type ServerStatusOutput =
  | (MbaStatusResult & { readonly error?: undefined })
  | { readonly error: string };

export function createServerStatusHandler(
  clientOpts: MbaServiceClientOptions = {},
): () => Promise<ServerStatusOutput> {
  return async () => {
    const res = await fetchStatus(clientOpts);
    if (!res.ok) return { error: res.error };
    return res.data;
  };
}
