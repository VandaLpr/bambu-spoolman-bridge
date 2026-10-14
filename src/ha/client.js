// Home Assistant websocket client (home-assistant-js-websocket on Node's built-in WebSocket).
// The library reconnects on its own and restores subscriptions after a reconnect.

import {
  callService,
  createConnection,
  createLongLivedTokenAuth,
  ERR_INVALID_AUTH,
  getServices,
  subscribeEntities,
} from 'home-assistant-js-websocket';

export async function connectHa({ url, token, log }) {
  let conn;
  try {
    // setupRetry -1: keep retrying until HA is reachable (e.g. both containers booting).
    conn = await createConnection({ auth: createLongLivedTokenAuth(url, token), setupRetry: -1 });
  } catch (e) {
    if (e === ERR_INVALID_AUTH) throw new Error('Home Assistant rejected HA_TOKEN');
    throw new Error(`could not connect to Home Assistant at ${url} (code ${e})`);
  }
  log.info(`connected to Home Assistant ${conn.haVersion}`);
  conn.addEventListener('disconnected', () => log.warn('Home Assistant connection lost; reconnecting'));
  conn.addEventListener('ready', () => log.info('Home Assistant connection restored'));
  conn.addEventListener('reconnect-error', (_c, err) => log.error(`Home Assistant reconnect failed (code ${err})`));

  return {
    isConnected: () => conn.connected,
    subscribeEntities: (cb) => subscribeEntities(conn, cb),
    getServices: () => getServices(conn),
    callService: (domain, service, data, target) => callService(conn, domain, service, data, target),
    pressButton: (entityId) => callService(conn, 'button', 'press', undefined, { entity_id: entityId }),
    subscribeEvent: (eventType, cb) => conn.subscribeEvents(cb, eventType),
    // Read-only recorder history as { entityId: [{ state, time }] }, time in ms, ascending.
    // The first row of each entity is its state at startTime.
    async history(entityIds, startTime) {
      const res = await conn.sendMessagePromise({
        type: 'history/history_during_period',
        start_time: new Date(startTime).toISOString(),
        entity_ids: entityIds,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      return Object.fromEntries(entityIds.map((id) => [id, (res[id] || []).map((r) => ({ state: r.s, time: (r.lu ?? r.lc) * 1000 }))]));
    },
    close: () => conn.close(),
  };
}
