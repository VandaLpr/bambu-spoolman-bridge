// Home Assistant mobile_app notifications. Pending sources get actionable buttons
// (top 2 candidates + "Open bridge"); the action ids come back as
// mobile_app_notification_action events and are parsed by parseAction().

const ACTION = /^BSB_(\d+)_(\d+)$/;
const MAX_BUTTONS = 2;

const REASONS = {
  ambiguous_opened: 'several opened spools match',
  ambiguous_pairing: 'several opened spools could hold this RFID tag',
  ambiguous_color: 'several filament colors are close',
  no_match: 'no matching spool in Spoolman',
  no_spool_info: 'the printer reports no filament for this source',
  duplicate_rfid_uuid: 'two spools carry the same RFID',
  rfid_spool_archived: 'the spool with this RFID is archived',
};

export const actionId = (pendingId, spoolId) => `BSB_${pendingId}_${spoolId}`;

export function parseAction(action) {
  const m = ACTION.exec(String(action ?? ''));
  return m ? { pendingId: Number(m[1]), spoolId: Number(m[2]) } : null;
}

export function pendingMessage({ pending, printerName, taskName, source }) {
  const what = [source.material, source.name, source.color_hex ? `#${source.color_hex}` : null].filter(Boolean).join(' ');
  const lines = [
    `${printerName}${taskName ? ` · "${taskName}"` : ''}`,
    `${pending.source_key}${what ? ` (${what})` : ''}: ${REASONS[pending.reason] ?? pending.reason}.`,
    pending.candidates.length ? 'Which spool is it?' : 'Pick the spool in the bridge.',
    'The bridge link works only on home Wi-Fi.',
  ];
  return lines.join('\n');
}

export function createNotifier({ ha, service, dryRun, bridgeUrl, log }) {
  const [domain, name] = service.split('.');

  async function send(title, message, data) {
    const payload = { title: dryRun ? `[DRY RUN] ${title}` : title, message, ...(data ? { data } : {}) };
    try {
      await ha.callService(domain, name, payload);
      log.info(`notification sent: ${payload.title}`);
    } catch (e) {
      log.error(`notification failed (${service}): ${e.message ?? e}`, payload);
    }
  }

  const openBridge = (path) => ({ action: 'URI', title: 'Open bridge', uri: `${bridgeUrl}${path}` });

  return {
    async pending({ pending, printerName, taskName, source }) {
      const page = `${bridgeUrl}/pending/${pending.id}`;
      const actions = pending.candidates.slice(0, MAX_BUTTONS).map((c) => ({ action: actionId(pending.id, c.spoolId), title: c.label }));
      if (bridgeUrl) actions.push(openBridge(`/pending/${pending.id}`));
      await send('Which spool?', pendingMessage({ pending, printerName, taskName, source }), {
        actions,
        // A plain tap opens the bridge page too: url for iOS, clickAction for Android.
        ...(bridgeUrl ? { url: page, clickAction: page } : {}),
        tag: `bsb-pending-${pending.id}`,
        group: 'bambu-spoolman-bridge',
      });
    },
    // path: optional bridge page for an "Open bridge" button, e.g. /usage/12
    problem: (title, message, { path = null } = {}) =>
      send(title, path && bridgeUrl ? `${message}\nThe bridge link works only on home Wi-Fi.` : message, {
        group: 'bambu-spoolman-bridge',
        ...(path && bridgeUrl ? { actions: [openBridge(path)] } : {}),
      }),
  };
}
