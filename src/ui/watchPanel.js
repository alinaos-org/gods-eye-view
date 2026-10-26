/**
 * The Watch rail panel: inbox, active emergencies, watched assets, one card
 * per zone (with its place brief), zone creation and settings, plus the
 * saved-data read-error banner.
 *
 * The panel renders a {@link WatchPanelModel} and reports every user choice
 * as one {@link WatchPanelAction} through `onAction`; it never changes the
 * Watch document, the engine or a layer itself. It keeps only presentation
 * state: which cards are open, the inbox filter, the selected watched asset,
 * the radius chosen for a new zone, the two inline text forms (identifier and
 * rename) and the armed delete confirmation (a second click within 3 s).
 *
 * The controller (src/app/watch.js) passes, on every change and on its 30 s
 * timer:
 *
 * @typedef {object} WatchPanelModel
 * @property {boolean} visible Whether the panel shows at all: the Watch
 *   document is non-empty or the person opened Watch. Written to
 *   `panel.hidden`; the panel never expands itself.
 * @property {number} nowMs Wall-clock time, for relative times and dwell.
 * @property {import('../watch/engine.js').WatchView|null} view
 *   `engine.view(nowMs)`.
 * @property {object|null} doc The current Watch document (document.js
 *   shape): zone filters, radius, notify and names, the watchlist (for
 *   duplicate checks) and `prefs`.
 * @property {{rows: object[], alertRows: object[], unread: number}} inbox
 *   `rows` is `log.list({limit: 50})`, `alertRows` is
 *   `log.list({minSeverity: 'alert', limit: 50})` (both newest first, event
 *   log LogRows) and `unread` is `log.unreadCount()`.
 * @property {WatchPanelSelection|null} selection The current map selection,
 *   or null when nothing watchable is selected.
 * @property {Array<{id: string, type: 'area'|'pin', label: string|null}>}
 *   annotations Drawn shapes that can become zones: `annotations.list()`
 *   filtered to areas with a ring and pins.
 * @property {Object<string, object>} briefs zoneId → the PlaceBrief
 *   (`engine.brief(zoneId, {nowMs, recentEvents})`) the person last asked
 *   for; omit a zone to show no brief.
 * @property {{code: string, dropped?: {zones: number, watchlist: number}}|null}
 *   readError The `readStoredWatchDocument` read error still awaiting the
 *   person's choice, with `dropped` for 'partial'; null once resolved.
 * @property {string|null} writeError The `writeStoredWatchDocument` reason
 *   of the latest failed save, null after a good save.
 * @property {{watch: string|null, zones: string|null}} notices The code of
 *   the latest failed watched-asset or zone action (document.js codes, or
 *   'no-selection' / 'no-position'), shown until the next action of that
 *   kind; null when the last one succeeded.
 *
 * @typedef {object} WatchPanelSelection
 * @property {'aircraft'|'vessel'|'satellite'} kind
 * @property {'icao24'|'callsign'|'mmsi'|'norad'} match
 * @property {string} value
 * @property {string|null} label Feed display label (never translated).
 * @property {boolean} watched Already on the watchlist.
 * @property {boolean} zoneable The controller knows a current position, so
 *   "Around selection" can make a zone (aircraft and vessels only).
 *
 * Actions, exactly as passed to `onAction(action)`:
 *
 * @typedef {{type: 'inbox-mark-all-read'}
 *   | {type: 'inbox-clear'}
 *   | {type: 'focus-event', eventId: string}
 *   | {type: 'focus-emergency', key: string}
 *   | {type: 'watch-add-selection'}
 *   | {type: 'watch-add-id', match: string, value: string}
 *   | {type: 'watch-focus', entryId: string}
 *   | {type: 'watch-remove', entryId: string}
 *   | {type: 'zone-add-view', radiusKm: number}
 *   | {type: 'zone-add-selection', radiusKm: number}
 *   | {type: 'zone-add-annotation', annotationId: string}
 *   | {type: 'zone-update', zoneId: string, patch: object}
 *   | {type: 'zone-rename', zoneId: string, name: string}
 *   | {type: 'zone-fly', zoneId: string}
 *   | {type: 'zone-brief', zoneId: string}
 *   | {type: 'zone-brief-clear', zoneId: string}
 *   | {type: 'zone-brief-copy', zoneId: string, text: string}
 *   | {type: 'zone-delete', zoneId: string}
 *   | {type: 'layer-enable', layerId: string}
 *   | {type: 'prefs', patch: {zonesVisible?: boolean, toasts?: boolean,
 *       allEmergencies?: boolean}}
 *   | {type: 'storage-keep'}
 *   | {type: 'storage-reset'}} WatchPanelAction
 *
 * - 'watch-add-id' carries the `parseWatchInput`-normalised value; the panel
 *   has already rejected bad identifiers and duplicates. It closes its form
 *   when the entry appears in `view.watchlist`, and shows `notices.watch`
 *   otherwise.
 * - 'zone-update' carries an `updateZone` patch: `{kinds}`, `{notify}`,
 *   `{radiusM}` (circles), `{aircraft: {militaryOnly}}`, `{fire:
 *   {minFrpMw}}`, `{quake: {minMagnitude}}` or `{quake: {bufferKm}}`.
 * - 'zone-rename' carries a name that `cleanName` accepts.
 * - 'zone-delete', 'watch-remove', 'inbox-clear', 'storage-keep' and
 *   'storage-reset' are sent only after a confirming second click within
 *   {@link WATCH_CONFIRM_MS}; the first click relabels the button.
 * - 'zone-brief-copy' carries the brief exactly as shown, one line each.
 * - 'layer-enable' names the layer whose off answer the card shows.
 * - 'storage-keep' (keep the loaded entries and save) and 'storage-reset'
 *   (reset the saved data) resolve `readError`. Keep is offered only for a
 *   'partial' read: for any other read error nothing was loaded, so saving
 *   would only overwrite the stored data.
 * @module ui/watchPanel
 */
import { formatNumber, t } from '../i18n/index.js';
import {
  FIRE_FRP_STEPS,
  QUAKE_BUFFER_STEPS_KM,
  QUAKE_MAG_STEPS,
  RADIUS_STEPS_KM,
  WATCH_LIMITS,
  ZONE_KINDS,
  ZONE_NOTIFY,
  cleanName,
  parseWatchInput,
} from '../watch/document.js';
import { SEVERITY_RANK } from '../watch/eventLog.js';
import { createActionButton } from './actionButton.js';
import { syncChipGroup } from './chipGroup.js';
import { layerNameForId } from './layerNames.js';
import { createRailCards } from './railCards.js';
import { UiLifetime } from './uiLifetime.js';
import {
  describeAnswer,
  describeEmergency,
  describeOccupant,
  describePresence,
  describeReadError,
  describeWatchError,
  describeWatchEvent,
  describeWriteError,
  formatWatchTime,
  frpText,
  kindName,
  kmText,
  lowerBoundText,
  magnitudeText,
  matchName,
  notifyName,
  placeBriefText,
  zoneLabelDetails,
} from './watchWording.js';

/** How long an armed delete (or history clear) waits for its second click. */
export const WATCH_CONFIRM_MS = 3000;
/**
 * A confirming click this soon after arming is ignored: a double-click
 * lands twice on the relabelled button, and that is not a decision.
 */
export const WATCH_CONFIRM_MIN_MS = 500;
/** Zone radius preselected for "Around the view" and aircraft selections. */
export const WATCH_DEFAULT_RADIUS_KM = 25;
/** Zone radius around a selected vessel, unless the person chose one. */
export const WATCH_VESSEL_RADIUS_KM = 5;
const MAX_ZONES = WATCH_LIMITS.maxZones;
const MATCHES = Object.freeze(['icao24', 'callsign', 'mmsi', 'norad']);
const MATCH_EXAMPLES = Object.freeze({
  icao24: '4ca7b3',
  callsign: 'RYR12AB',
  mmsi: '235012345',
  norad: '25544',
});

const set = (node, key, value) => {
  if (node[key] !== value) node[key] = value;
};
const attribute = (node, key, value) => {
  if (node.getAttribute(key) !== value) node.setAttribute(key, value);
};
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const badgeCount = (n) => (n > 99 ? '99+' : formatNumber(n));

/** The layer whose being off leaves a zone kind unanswered, if any. */
function offLayer(kind, zone, perKind, feeds) {
  const answer = perKind?.[kind];
  if (!answer) return null;
  let layerId = null;
  if (kind === 'aircraft') {
    layerId = zone?.aircraft?.militaryOnly === true ? 'military' : 'flights';
  } else if (kind === 'vessel') layerId = 'ais-live-vessels';
  else if (kind === 'fire') layerId = 'local-firms';
  else if (kind === 'quake') layerId = 'earthquakes';
  if (!layerId) return null;
  const primaryOff =
    answer.answer === 'off' ||
    answer.reason === 'secondary-feed-only' ||
    feeds?.[layerId]?.answer === 'off';
  return primaryOff ? layerId : null;
}

/**
 * Creates the Watch panel inside `container` (#watch-panel-body).
 *
 * @param {object} options
 * @param {HTMLElement} options.container The panel body.
 * @param {HTMLElement} [options.panel] The outer #watch-panel, shown and
 *   hidden from `model.visible`.
 * @param {HTMLElement} [options.countBadge] #watch-panel-count: unread
 *   notice and alert events, "99+" past 99, empty at 0.
 * @param {(action: WatchPanelAction) => void} [options.onAction]
 * @param {() => number} [options.now] Clock for the delete confirmation.
 * @param {(callback: () => void, ms: number) => unknown} [options.schedule]
 *   Timer that ends an armed confirmation (defaults to a UiLifetime timeout).
 * @returns {{update: (model: WatchPanelModel) => void, destroy: () => void}|null}
 *   null without a container document.
 */
export function createWatchPanel({
  container,
  panel = null,
  countBadge = null,
  onAction = () => {},
  now = () => Date.now(),
  schedule = null,
} = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElement) return null;
  const lifetime = new UiLifetime();
  const timer = schedule ?? ((callback, ms) => lifetime.timeout(callback, ms));
  const make = (tag, className, parent) => {
    const node = document.createElement(tag);
    node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  };
  const emit = (action) => {
    if (!destroyed) onAction(action);
  };

  // Saved-data banner and save failures sit above the cards.
  const banner = make('div', 'watch-banner panel-surface-error', container);
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  const bannerText = make('p', 'watch-banner-text', banner);
  const bannerActions = make('div', 'watch-banner-actions', banner);
  const keepButton = createActionButton({
    documentRef: document,
    label: t('Keep loaded entries and save'),
    className: 'panel-surface-control',
    size: 'compact',
  });
  const resetButton = createActionButton({
    documentRef: document,
    label: t('Reset saved watch data'),
    className: 'panel-surface-control',
    variant: 'danger',
    size: 'compact',
  });
  bannerActions.append(keepButton, resetButton);
  const writeError = make(
    'p',
    'watch-write-error panel-surface-error',
    container,
  );
  writeError.setAttribute('role', 'status');
  writeError.hidden = true;
  const cardsHost = make('div', 'watch-cards', container);

  let model = null;
  let destroyed = false;
  const openCards = new Set(['inbox']);
  const knownZones = new Set();
  let zonesSeen = false;
  let inboxFilter = 'all';
  let selectedEntryId = null;
  let radiusKm = null;
  /** {key, atMs, untilMs} of the armed destructive action, or null. */
  let armed = null;
  /**
   * A node to focus after the next render, or a function finding it once
   * that render has mounted the cards.
   */
  let focusAfterRender = null;

  const cards = createRailCards({
    container: cardsHost,
    document,
    cardClassName: 'watch-card',
    badgeClassName: 'watch-card-badge',
    onOpen: (id) => {
      if (openCards.has(id)) openCards.delete(id);
      else openCards.add(id);
      render();
    },
  });

  /** Whether the latest key press is an auto-repeat of a held key. */
  let keyRepeating = false;
  lifetime.listen(container, 'keydown', (event) => {
    keyRepeating = event.repeat === true;
  });
  // A key released outside the panel, or a pointer press, ends it too.
  for (const type of ['keyup', 'pointerdown']) {
    lifetime.listen(container, type, () => {
      keyRepeating = false;
    });
  }

  /**
   * Second-click confirmation: true when this click confirms `key`. A
   * click from a held key's auto-repeat, or one within
   * {@link WATCH_CONFIRM_MIN_MS} of arming (a double-click), neither arms
   * nor confirms.
   */
  const confirmed = (key) => {
    const at = now();
    const sameArm = Boolean(armed && armed.key === key && at <= armed.untilMs);
    if (keyRepeating) return false;
    if (sameArm) {
      if (at - armed.atMs < WATCH_CONFIRM_MIN_MS) return false;
      armed = null;
      return true;
    }
    armed = { key, atMs: at, untilMs: at + WATCH_CONFIRM_MS };
    timer(() => {
      if (armed?.key === key && now() >= armed.untilMs) {
        armed = null;
        render();
      }
    }, WATCH_CONFIRM_MS);
    return false;
  };
  const isArmed = (key) =>
    Boolean(armed && armed.key === key && now() <= armed.untilMs);

  // -------------------------------------------------------------------------
  // Inline forms (the shared rail blocks have no text input)
  // -------------------------------------------------------------------------

  /** The first node under `root`, depth first, that `predicate` accepts. */
  function findNode(root, predicate) {
    const stack = root ? [root] : [];
    while (stack.length) {
      const node = stack.pop();
      if (predicate(node)) return node;
      stack.push(...Array.from(node.children ?? []).reverse());
    }
    return null;
  }
  const cardNode = (cardId) =>
    [...cardsHost.children].find((node) => node.dataset?.cardId === cardId) ??
    null;
  const actionNode = (cardId, actionId) =>
    findNode(cardNode(cardId), (node) => node.dataset?.actionId === actionId);
  /** Whether keyboard focus is on `root` or inside it. */
  const holdsFocus = (root) => {
    for (
      let node = document.activeElement;
      node;
      node = node.parentNode ?? node.parent
    ) {
      if (node === root) return true;
    }
    return false;
  };

  /**
   * An inline form. `opener` finds the action that opened it once rendered:
   * closing a form that holds focus gives focus back to it, so it never
   * falls to the page. `chipsLabel` names its chip group for assistive
   * technology.
   */
  function createInlineForm({
    labelText,
    inputLabel,
    submitLabel,
    maxLength,
    onSubmit,
    opener = null,
    chipsLabel = null,
  }) {
    const root = make('div', 'watch-inline-form');
    root.hidden = true;
    const label = make('span', 'watch-inline-label panel-title', root);
    set(label, 'textContent', labelText);
    const chips = make('div', 'rail-card-chips watch-inline-chips', root);
    chips.setAttribute('role', 'group');
    if (chipsLabel) chips.setAttribute('aria-label', chipsLabel);
    chips.hidden = true;
    const input = make(
      'input',
      'watch-inline-input panel-surface-control',
      root,
    );
    input.type = 'text';
    input.maxLength = maxLength;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', inputLabel);
    const buttons = make('div', 'watch-inline-buttons', root);
    const submit = createActionButton({
      documentRef: document,
      label: submitLabel,
      className: 'panel-surface-control',
      size: 'compact',
    });
    const cancel = createActionButton({
      documentRef: document,
      label: t('Cancel'),
      className: 'panel-surface-control',
      size: 'compact',
    });
    buttons.append(submit, cancel);
    const error = make('p', 'watch-inline-error panel-surface-error', root);
    error.setAttribute('role', 'status');
    error.hidden = true;
    const form = {
      root,
      chips,
      input,
      submit,
      error,
      open: false,
      setError(message) {
        set(error, 'textContent', message || '');
        set(error, 'hidden', !message);
        attribute(input, 'aria-invalid', message ? 'true' : 'false');
      },
      show(value = '') {
        form.open = true;
        input.value = value;
        form.setError('');
        set(root, 'hidden', false);
        // Focus once the next render has mounted the form in its card.
        focusAfterRender = input;
      },
      close() {
        if (form.open && opener && holdsFocus(root)) focusAfterRender = opener;
        form.open = false;
        input.value = '';
        form.setError('');
        set(root, 'hidden', true);
      },
    };
    lifetime.listen(submit, 'click', () => onSubmit(input.value));
    lifetime.listen(cancel, 'click', () => {
      form.close();
      render();
    });
    lifetime.listen(input, 'input', () => form.setError(''));
    lifetime.listen(input, 'keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault?.();
        onSubmit(input.value);
      } else if (event.key === 'Escape') {
        event.stopPropagation?.();
        form.close();
        render();
      }
    });
    return form;
  }

  /** Keeps a form as the last child of its card's body. */
  function mountForm(cardId, form) {
    const card = [...cardsHost.children].find(
      (node) => node.dataset?.cardId === cardId,
    );
    const body = card?.querySelector('.rail-card-body');
    // Blocks reorder only their own roots, so the form stays last.
    if (body && [...body.children].at(-1) !== form.root) {
      body.appendChild(form.root);
    }
  }

  let idMatch = 'icao24';
  /** {match, value} submitted and not yet in the watchlist, or null. */
  let pendingId = null;
  const idForm = createInlineForm({
    labelText: t('Watch by identifier'),
    inputLabel: t('Identifier to watch'),
    submitLabel: t('Add'),
    maxLength: 16,
    opener: () => actionNode('watched', 'add-id'),
    chipsLabel: t('Identifier type'),
    onSubmit: (value) => {
      const parsed = parseWatchInput({ match: idMatch, value });
      if (!parsed.ok) {
        idForm.setError(describeWatchError(parsed.code));
        return;
      }
      const { match, value: normalized } = parsed.entry;
      const watched = list(model?.doc?.watchlist).some(
        (entry) => entry.match === match && entry.value === normalized,
      );
      if (watched) {
        idForm.setError(describeWatchError('duplicate'));
        return;
      }
      pendingId = { match, value: normalized };
      emit({ type: 'watch-add-id', match, value: normalized });
    },
  });
  const syncIdForm = () => {
    idForm.chips.hidden = false;
    syncChipGroup(
      idForm.chips,
      MATCHES.map((match) => ({
        id: match,
        label: matchName(match),
        active: match === idMatch,
      })),
    );
    attribute(
      idForm.input,
      'placeholder',
      t('For example {example}', { example: MATCH_EXAMPLES[idMatch] }),
    );
  };
  lifetime.listen(idForm.chips, 'click', (event) => {
    const chip = event.target?.closest?.('[data-chip-id]');
    if (!chip || !MATCHES.includes(chip.dataset.chipId)) return;
    idMatch = chip.dataset.chipId;
    idForm.setError('');
    syncIdForm();
  });

  /** zoneId → rename form. */
  const renameForms = new Map();
  const renameForm = (zoneId) => {
    let form = renameForms.get(zoneId);
    if (!form) {
      form = createInlineForm({
        labelText: t('Rename zone'),
        inputLabel: t('Zone name'),
        submitLabel: t('Save'),
        maxLength: WATCH_LIMITS.nameMaxChars,
        opener: () => actionNode(`zone:${zoneId}`, 'rename'),
        onSubmit: (value) => {
          const name = cleanName(value, WATCH_LIMITS.nameMaxChars);
          if (!name) {
            form.setError(describeWatchError('bad-name'));
            return;
          }
          form.close();
          emit({ type: 'zone-rename', zoneId, name });
          render();
        },
      });
      renameForms.set(zoneId, form);
    }
    return form;
  };

  lifetime.listen(keepButton, 'click', () => {
    if (confirmed('storage-keep')) emit({ type: 'storage-keep' });
    render();
  });
  lifetime.listen(resetButton, 'click', () => {
    if (confirmed('storage-reset')) emit({ type: 'storage-reset' });
    render();
  });

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  function zoneNames() {
    const names = new Map();
    for (const zone of list(model?.view?.zones)) names.set(zone.id, zone.name);
    for (const zone of list(model?.doc?.zones)) {
      if (!names.get(zone.id)) names.set(zone.id, zone.name);
    }
    return names;
  }

  function inboxCard(names) {
    const inbox = isRecord(model.inbox) ? model.inbox : {};
    const rows =
      inboxFilter === 'alerts' ? list(inbox.alertRows) : list(inbox.rows);
    const unread = Number(inbox.unread) || 0;
    const nowMs = model.nowMs;
    const items = rows.map((row) => {
      const time = formatWatchTime(row.atMs, { nowMs });
      return {
        id: row.id,
        // Unread as the log counts it: info rows never count, so they
        // never show the marker that Mark all read clears.
        lead:
          !row.read && SEVERITY_RANK[row.severity] >= SEVERITY_RANK.notice
            ? `● ${time}`
            : time,
        text: describeWatchEvent(row, {
          zoneName: names.get(row.zoneId) ?? null,
          nowMs,
        }).text,
        onClick: () => emit({ type: 'focus-event', eventId: row.id }),
      };
    });
    const total = list(inbox.rows).length;
    const clearing = isArmed('inbox-clear');
    return {
      id: 'inbox',
      title: t('INBOX'),
      badge: unread ? t('{count} new', { count: badgeCount(unread) }) : '',
      open: openCards.has('inbox'),
      compact: items[0]?.text ?? t('No watch events yet'),
      blocks: [
        {
          id: 'filter',
          type: 'setting',
          label: t('Show'),
          chips: [
            {
              id: 'all',
              label: t('All'),
              active: inboxFilter === 'all',
              onClick: () => {
                inboxFilter = 'all';
                render();
              },
            },
            {
              id: 'alerts',
              label: t('Alerts'),
              active: inboxFilter === 'alerts',
              onClick: () => {
                inboxFilter = 'alerts';
                render();
              },
            },
          ],
        },
        items.length
          ? {
              id: 'events',
              type: 'list',
              list: { ariaLabel: t('Watch events'), items },
            }
          : {
              id: 'empty',
              type: 'lines',
              lines: [
                {
                  id: 'empty',
                  text:
                    inboxFilter === 'alerts' && total
                      ? t('No alerts in this session.')
                      : t(
                          'No watch events yet. Zone and watched-asset changes appear here.',
                        ),
                  muted: true,
                },
              ],
            },
        {
          id: 'session',
          type: 'lines',
          lines: [
            {
              id: 'session',
              text: t('History stays in this tab and ends when it closes.'),
              muted: true,
            },
          ],
        },
        {
          id: 'actions',
          type: 'actions',
          actions: [
            {
              id: 'read',
              label: t('Mark all read'),
              disabled: unread === 0,
              onClick: () => emit({ type: 'inbox-mark-all-read' }),
            },
            {
              id: 'clear',
              label: clearing ? t('Confirm clear') : t('Clear history'),
              hint: clearing ? t('Click again within 3 s') : '',
              disabled: total === 0,
              onClick: () => {
                if (confirmed('inbox-clear')) emit({ type: 'inbox-clear' });
                render();
              },
            },
          ],
        },
      ],
    };
  }

  function emergenciesCard() {
    const emergencies = list(model.view?.emergencies);
    if (!emergencies.length) return null;
    return {
      id: 'emergencies',
      title: t('ACTIVE EMERGENCIES'),
      badge: formatNumber(emergencies.length),
      open: openCards.has('emergencies'),
      compact: describeEmergency(emergencies[0], { nowMs: model.nowMs }),
      compactStatus: true,
      blocks: [
        {
          id: 'list',
          type: 'list',
          list: {
            ariaLabel: t('Active emergencies'),
            items: emergencies.map((item) => ({
              id: item.key,
              lead: item.squawk ?? '',
              text: describeEmergency(item, { nowMs: model.nowMs }),
              onClick: () => emit({ type: 'focus-emergency', key: item.key }),
            })),
          },
        },
        {
          id: 'note',
          type: 'lines',
          lines: [
            {
              id: 'note',
              text: t(
                'Transponder broadcasts as received; a code can be set in error.',
              ),
              muted: true,
            },
          ],
        },
      ],
    };
  }

  function watchedCard(names) {
    const rows = list(model.view?.watchlist);
    if (!rows.some((row) => row.entryId === selectedEntryId)) {
      selectedEntryId = null;
    }
    const selection = isRecord(model.selection) ? model.selection : null;
    const full =
      list(model.doc?.watchlist).length >= WATCH_LIMITS.maxWatchEntries;
    const items = rows.map((row) => {
      const name = row.label ?? row.value;
      return {
        id: row.entryId,
        lead: matchName(row.match),
        text: [
          name,
          row.label && row.label !== row.value ? row.value : '',
          describePresence(row.presence?.state, row.presence?.reason, {
            fixAtMs: row.fix?.atMs ?? null,
            nowMs: model.nowMs,
            layerId: row.layerId,
            matches: row.matches,
          }),
          row.zoneIds?.length
            ? t('inside {zones}', {
                zones: row.zoneIds.map((id) => names.get(id) ?? id).join(', '),
              })
            : '',
        ]
          .filter(Boolean)
          .join(' · '),
        active: row.entryId === selectedEntryId,
        onClick: () => {
          selectedEntryId =
            selectedEntryId === row.entryId ? null : row.entryId;
          render();
        },
      };
    });
    const notice = model.notices?.watch ?? null;
    const selectedPresence = rows.find(
      (row) => row.entryId === selectedEntryId,
    )?.presence;
    // Declined, or an aircraft the guard cannot judge yet: never located.
    const unfollowed =
      selectedPresence?.state === 'declined'
        ? 'declined'
        : selectedPresence?.reason === 'class-unknown'
          ? 'class-unknown'
          : null;
    const removing =
      selectedEntryId && isArmed(`watch-remove:${selectedEntryId}`);
    const blocks = [
      items.length
        ? {
            id: 'entries',
            type: 'list',
            list: { ariaLabel: t('Watched assets'), items },
          }
        : {
            id: 'empty',
            type: 'lines',
            lines: [
              {
                id: 'empty',
                text: t(
                  'No watched assets. Select an aircraft, vessel or satellite and choose Watch selected, or add one by identifier.',
                ),
                muted: true,
              },
            ],
          },
      {
        id: 'notes',
        type: 'lines',
        lines: [
          ...(notice
            ? [{ id: 'notice', text: describeWatchError(notice) }]
            : []),
          {
            id: 'privacy',
            text: t(
              'Identifiers only. Private light aircraft, gliders, business jets, pleasure and sailing craft are not watched, civil aircraft and vessels are followed only once their type is known, and watched assets are never shared.',
            ),
            muted: true,
          },
        ],
      },
      {
        id: 'actions',
        type: 'actions',
        actions: [
          {
            id: 'watch-selection',
            label: t('Watch selected'),
            hint: selection
              ? selection.watched
                ? t('{name} is already watched', {
                    name: selection.label ?? selection.value,
                  })
                : (selection.label ?? selection.value)
              : t('Select an aircraft, vessel or satellite'),
            disabled: !selection || selection.watched === true || full,
            onClick: () => emit({ type: 'watch-add-selection' }),
          },
          {
            id: 'add-id',
            label: t('Add by identifier'),
            disabled: full && !idForm.open,
            onClick: () => {
              if (idForm.open) idForm.close();
              else {
                idForm.show();
                syncIdForm();
              }
              render();
            },
          },
          {
            id: 'focus',
            label: t('Focus'),
            // A declined or unjudged entry is not followed, so never located.
            hint: unfollowed ? describeWatchError(unfollowed) : '',
            disabled: !selectedEntryId || unfollowed !== null,
            onClick: () =>
              emit({ type: 'watch-focus', entryId: selectedEntryId }),
          },
          {
            id: 'remove',
            label: removing ? t('Confirm remove') : t('Remove'),
            hint: removing ? t('Click again within 3 s') : '',
            disabled: !selectedEntryId,
            onClick: () => {
              const entryId = selectedEntryId;
              if (confirmed(`watch-remove:${entryId}`)) {
                selectedEntryId = null;
                emit({ type: 'watch-remove', entryId });
              }
              render();
            },
          },
        ],
      },
    ];
    return {
      id: 'watched',
      title: t('WATCHED ASSETS'),
      badge: t('{count} of {max}', {
        count: formatNumber(rows.length),
        max: formatNumber(WATCH_LIMITS.maxWatchEntries),
      }),
      open: openCards.has('watched'),
      compact: items[0]?.text ?? t('None watched'),
      blocks,
    };
  }

  function chipSetting(id, label, chips) {
    return { id, type: 'setting', label, chips };
  }

  function zoneSettings(zone) {
    const zoneId = zone.id;
    const update = (patch) => emit({ type: 'zone-update', zoneId, patch });
    const kinds = list(zone.kinds);
    const settings = [
      chipSetting(
        'kinds',
        t('Watch'),
        ZONE_KINDS.map((kind) => {
          const active = kinds.includes(kind);
          return {
            id: kind,
            label: kindName(kind),
            active,
            disabled: active && kinds.length === 1,
            onClick: () =>
              update({
                kinds: ZONE_KINDS.filter((k) =>
                  k === kind ? !active : kinds.includes(k),
                ),
              }),
          };
        }),
      ),
      chipSetting(
        'notify',
        t('Report'),
        ZONE_NOTIFY.map((notify) => ({
          id: notify,
          label: notifyName(notify),
          title:
            notify === 'all'
              ? ''
              : t('Zone events stay quiet; watched assets still report'),
          active: zone.notify === notify,
          onClick: () => update({ notify }),
        })),
      ),
    ];
    if (zone.shape === 'circle') {
      const km = Number(zone.radiusM) / 1000;
      settings.push(
        chipSetting(
          'radius',
          RADIUS_STEPS_KM.includes(km)
            ? t('Radius')
            : t('Radius (now {radius})', { radius: kmText(km) }),
          RADIUS_STEPS_KM.map((step) => ({
            id: String(step),
            label: kmText(step),
            active: step === km,
            onClick: () => update({ radiusM: step * 1000 }),
          })),
        ),
      );
    }
    if (kinds.includes('aircraft')) {
      const militaryOnly = zone.aircraft?.militaryOnly === true;
      settings.push(
        chipSetting('military', t('Aircraft'), [
          {
            id: 'all',
            label: t('All aircraft'),
            active: !militaryOnly,
            onClick: () => update({ aircraft: { militaryOnly: false } }),
          },
          {
            id: 'military',
            label: t('Military only'),
            active: militaryOnly,
            onClick: () => update({ aircraft: { militaryOnly: true } }),
          },
        ]),
      );
    }
    if (kinds.includes('fire')) {
      const frp = Number(zone.fire?.minFrpMw ?? 0);
      settings.push(
        chipSetting(
          'frp',
          t('Fire strength'),
          FIRE_FRP_STEPS.map((step) => ({
            id: String(step),
            label: step === 0 ? t('Any') : lowerBoundText(frpText(step)),
            active: step === frp,
            onClick: () => update({ fire: { minFrpMw: step } }),
          })),
        ),
      );
    }
    if (kinds.includes('quake')) {
      const magnitude = Number(zone.quake?.minMagnitude ?? 2.5);
      const buffer = Number(zone.quake?.bufferKm ?? 0);
      settings.push(
        chipSetting(
          'magnitude',
          t('Earthquake magnitude'),
          QUAKE_MAG_STEPS.map((step) => ({
            id: String(step),
            label: lowerBoundText(magnitudeText(step)),
            active: step === magnitude,
            onClick: () => update({ quake: { minMagnitude: step } }),
          })),
        ),
        chipSetting(
          'buffer',
          t('Earthquakes nearby'),
          QUAKE_BUFFER_STEPS_KM.map((step) => ({
            id: String(step),
            label:
              step === 0
                ? t('Inside only')
                : t('Within {distance}', { distance: kmText(step) }),
            active: step === buffer,
            onClick: () => update({ quake: { bufferKm: step } }),
          })),
        ),
      );
    }
    return settings;
  }

  function zoneCard(zoneView, docZone) {
    const zoneId = zoneView.id;
    const cardId = `zone:${zoneId}`;
    const zone = { ...(docZone ?? {}), ...zoneView, kinds: zoneView.kinds };
    const perKind = isRecord(zoneView.perKind) ? zoneView.perKind : {};
    const nowMs = model.nowMs;
    const kinds = list(zoneView.kinds);
    const lines = kinds.map((kind) => {
      const answer = perKind[kind] ?? {};
      return {
        id: `kind-${kind}`,
        text: describeAnswer(answer.answer, answer.reason, {
          count: answer.count,
          asOfMs: answer.asOfMs,
          kind,
          nowMs,
        }),
      };
    });
    for (const kind of kinds) {
      if (perKind[kind]?.busy) {
        lines.push({
          id: `busy-${kind}`,
          text: t(
            '{kind}: busy, so entries and exits are summed every 10 min',
            {
              kind: kindName(kind),
            },
          ),
          muted: true,
        });
      }
    }
    if (zoneView.capped) {
      lines.push({
        id: 'capped',
        text: t('Too many assets to time them all; counts stay complete.'),
        muted: true,
      });
    }
    list(zoneView.occupants).forEach((occupant, index) => {
      lines.push({
        id: `occupant-${index}`,
        text: describeOccupant(occupant, { nowMs }),
        muted: true,
      });
    });
    if (
      !zoneView.timed &&
      kinds.some((kind) => kind === 'aircraft' || kind === 'vessel')
    ) {
      lines.push({
        id: 'untimed',
        text: t(
          'Entries and dwell times start after the first complete answer.',
        ),
        muted: true,
      });
    }
    const enable = [];
    for (const kind of kinds) {
      const layerId = offLayer(kind, docZone, perKind, model.view?.feeds);
      if (layerId && !enable.some((action) => action.layerId === layerId)) {
        enable.push({
          id: `enable-${layerId}`,
          layerId,
          label: t('Turn on {layer}', {
            layer: layerNameForId(layerId) ?? layerId,
          }),
          onClick: () => emit({ type: 'layer-enable', layerId }),
        });
      }
    }
    const loadsArea = kinds.some((kind) =>
      ['outside-loaded-area', 'partial-coverage', 'coverage-unknown'].includes(
        perKind[kind]?.reason,
      ),
    );
    const brief = model.briefs?.[zoneId] ?? null;
    const briefLines = brief ? placeBriefText(brief, { nowMs }) : [];
    const deleting = isArmed(`zone-delete:${zoneId}`);
    const form = renameForms.get(zoneId);
    const [label] = zoneLabelDetails(zoneView);
    return {
      id: cardId,
      title: zoneView.name ?? docZone?.name ?? zoneId,
      badge: zoneView.alert ? t('ALERT') : '',
      open: openCards.has(cardId),
      compact: label ?? '',
      compactStatus: zoneView.alert === true,
      blocks: [
        { id: 'status', type: 'lines', lines },
        { id: 'settings', type: 'settings', settings: zoneSettings(zone) },
        ...(briefLines.length
          ? [
              {
                id: 'brief',
                type: 'result',
                label: t('PLACE BRIEF'),
                lines: briefLines.map((text, index) => ({
                  id: `brief-${index}`,
                  text,
                  muted: index === 0,
                })),
                clear: {
                  label: t('Clear brief'),
                  onClick: () => emit({ type: 'zone-brief-clear', zoneId }),
                },
              },
            ]
          : []),
        {
          id: 'actions',
          type: 'actions',
          actions: [
            ...enable,
            {
              id: 'fly',
              label: t('Fly to'),
              hint: loadsArea ? t('Flying there loads its area') : '',
              onClick: () => emit({ type: 'zone-fly', zoneId }),
            },
            {
              id: 'brief',
              label: brief ? t('Refresh brief') : t('Brief'),
              onClick: () => emit({ type: 'zone-brief', zoneId }),
            },
            {
              id: 'copy',
              label: t('Copy brief'),
              disabled: briefLines.length === 0,
              onClick: () =>
                emit({
                  type: 'zone-brief-copy',
                  zoneId,
                  text: briefLines.join('\n'),
                }),
            },
            {
              id: 'rename',
              label: t('Rename'),
              onClick: () => {
                const rename = renameForm(zoneId);
                if (rename.open) rename.close();
                else rename.show(zoneView.name ?? docZone?.name ?? '');
                render();
              },
            },
            {
              id: 'delete',
              label: deleting ? t('Confirm delete') : t('Delete'),
              hint: deleting ? t('Click again within 3 s') : '',
              onClick: () => {
                if (confirmed(`zone-delete:${zoneId}`)) {
                  // The focused card goes away: focus the card after it.
                  const ids = [...cardsHost.children].map(
                    (node) => node.dataset?.cardId,
                  );
                  const index = ids.indexOf(`zone:${zoneId}`);
                  const nextId =
                    (index >= 0 ? ids[index + 1] : null) ?? 'add-zone';
                  focusAfterRender = () => cardNode(nextId)?.children?.[0];
                  emit({ type: 'zone-delete', zoneId });
                }
                render();
              },
            },
          ],
        },
      ],
      form,
    };
  }

  function addZoneCard() {
    const zoneCount =
      list(model.doc?.zones).length || list(model.view?.zones).length;
    const full = zoneCount >= MAX_ZONES;
    const selection = isRecord(model.selection) ? model.selection : null;
    const viewRadius = radiusKm ?? WATCH_DEFAULT_RADIUS_KM;
    const selectionRadius =
      radiusKm ??
      (selection?.kind === 'vessel'
        ? WATCH_VESSEL_RADIUS_KM
        : WATCH_DEFAULT_RADIUS_KM);
    const annotations = list(model.annotations);
    const notice = model.notices?.zones ?? null;
    const lines = [];
    if (notice) lines.push({ id: 'notice', text: describeWatchError(notice) });
    if (full) {
      lines.push({
        id: 'full',
        text: t('The limit of {max} zones is reached.', {
          max: formatNumber(MAX_ZONES),
        }),
      });
    }
    lines.push({
      id: 'hint',
      text: t(
        'Zones watch aircraft and vessels by default; change what each one watches in its card.',
      ),
      muted: true,
    });
    return {
      id: 'add-zone',
      title: t('ADD ZONE'),
      badge: t('{count} of {max}', {
        count: formatNumber(zoneCount),
        max: formatNumber(MAX_ZONES),
      }),
      open: openCards.has('add-zone'),
      compact: t('Around the view, the selection or a drawn shape'),
      blocks: [
        chipSetting(
          'radius',
          t('Radius'),
          RADIUS_STEPS_KM.map((step) => ({
            id: String(step),
            label: kmText(step),
            active: step === viewRadius,
            onClick: () => {
              radiusKm = step;
              render();
            },
          })),
        ),
        { id: 'notes', type: 'lines', lines },
        {
          id: 'actions',
          type: 'actions',
          actions: [
            {
              id: 'view',
              label: t('Around the view'),
              hint: kmText(viewRadius),
              disabled: full,
              onClick: () =>
                emit({ type: 'zone-add-view', radiusKm: viewRadius }),
            },
            {
              id: 'selection',
              label: t('Around selection'),
              hint: selection?.zoneable
                ? t('{name} · {radius}', {
                    name: selection.label ?? selection.value,
                    radius: kmText(selectionRadius),
                  })
                : selection?.kind === 'aircraft' || selection?.kind === 'vessel'
                  ? describeWatchError('no-position')
                  : t('Select an aircraft or vessel'),
              disabled: full || !selection?.zoneable,
              onClick: () =>
                emit({
                  type: 'zone-add-selection',
                  radiusKm: selectionRadius,
                }),
            },
          ],
        },
        annotations.length
          ? {
              id: 'annotations',
              type: 'list',
              list: {
                ariaLabel: t('Drawn shapes'),
                items: annotations.map((annotation) => ({
                  id: annotation.id,
                  lead: annotation.type === 'pin' ? '⌖' : '▱',
                  text:
                    annotation.label ??
                    (annotation.type === 'pin'
                      ? t('Drawn pin')
                      : t('Drawn area')),
                  disabled: full,
                  onClick: () =>
                    emit({
                      type: 'zone-add-annotation',
                      annotationId: annotation.id,
                    }),
                })),
              },
            }
          : {
              id: 'draw-hint',
              type: 'lines',
              lines: [
                {
                  id: 'draw-hint',
                  text: t(
                    'Draw an area or a pin with DISPLAY ▸ Draw to turn it into a zone.',
                  ),
                  muted: true,
                },
              ],
            },
      ],
    };
  }

  function settingsCard() {
    const prefs = isRecord(model.doc?.prefs) ? model.doc.prefs : {};
    const toggle = (id, label, key, value) =>
      chipSetting(id, label, [
        {
          id: 'on',
          label: t('On'),
          active: value,
          onClick: () => emit({ type: 'prefs', patch: { [key]: true } }),
        },
        {
          id: 'off',
          label: t('Off'),
          active: !value,
          onClick: () => emit({ type: 'prefs', patch: { [key]: false } }),
        },
      ]);
    return {
      id: 'settings',
      title: t('SETTINGS'),
      open: openCards.has('settings'),
      compact: '',
      blocks: [
        {
          id: 'prefs',
          type: 'settings',
          settings: [
            toggle(
              'zones-visible',
              t('Show zones on the globe'),
              'zonesVisible',
              prefs.zonesVisible !== false,
            ),
            toggle(
              'toasts',
              t('Alert pop-ups'),
              'toasts',
              prefs.toasts !== false,
            ),
            toggle(
              'all-emergencies',
              t('Report every emergency'),
              'allEmergencies',
              prefs.allEmergencies === true,
            ),
          ],
        },
        {
          id: 'notes',
          type: 'lines',
          lines: [
            {
              id: 'emergencies',
              text: t(
                'Off: emergencies are reported for aircraft in zones and watched aircraft; all of them stay listed.',
              ),
              muted: true,
            },
            {
              id: 'storage',
              text: t(
                'Zones and watched assets are saved in this browser only.',
              ),
              muted: true,
            },
          ],
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function render() {
    if (destroyed || !model) return;
    if (panel) set(panel, 'hidden', model.visible !== true);
    const inbox = isRecord(model.inbox) ? model.inbox : {};
    const unread = Number(inbox.unread) || 0;
    if (countBadge)
      set(countBadge, 'textContent', unread ? badgeCount(unread) : '');

    const readError = isRecord(model.readError) ? model.readError : null;
    set(banner, 'hidden', !readError);
    if (readError) {
      set(
        bannerText,
        'textContent',
        describeReadError(readError.code, readError.dropped),
      );
      // Only a partial read loaded entries that Keep could save.
      set(keepButton, 'hidden', readError.code !== 'partial');
      set(
        keepButton,
        'textContent',
        isArmed('storage-keep')
          ? t('Confirm save')
          : t('Keep loaded entries and save'),
      );
      const resetting = isArmed('storage-reset');
      set(
        resetButton,
        'textContent',
        resetting ? t('Confirm reset') : t('Reset saved watch data'),
      );
    }
    set(writeError, 'hidden', !model.writeError);
    if (model.writeError) {
      set(writeError, 'textContent', describeWriteError(model.writeError));
    }

    // Close the identifier form once its entry is on the list.
    if (pendingId) {
      const added = list(model.view?.watchlist).some(
        (row) => row.match === pendingId.match && row.value === pendingId.value,
      );
      if (added) {
        pendingId = null;
        idForm.close();
      } else if (model.notices?.watch) {
        idForm.setError(describeWatchError(model.notices.watch));
        pendingId = null;
      }
    }

    const names = zoneNames();
    const docZones = new Map(list(model.doc?.zones).map((z) => [z.id, z]));
    const zoneViews = list(model.view?.zones);
    // A zone added after the panel first rendered opens; restored ones stay shut.
    for (const zone of zoneViews) {
      if (!knownZones.has(zone.id)) {
        knownZones.add(zone.id);
        if (zonesSeen) openCards.add(`zone:${zone.id}`);
      }
    }
    if (isRecord(model.view)) zonesSeen = true;
    for (const id of [...knownZones]) {
      if (!zoneViews.some((zone) => zone.id === id)) {
        knownZones.delete(id);
        openCards.delete(`zone:${id}`);
        renameForms.get(id)?.root.remove();
        renameForms.delete(id);
      }
    }
    const zoneCards = zoneViews.map((zone) =>
      zoneCard(zone, docZones.get(zone.id)),
    );
    const models = [
      inboxCard(names),
      emergenciesCard(),
      watchedCard(names),
      ...zoneCards,
      addZoneCard(),
      settingsCard(),
    ].filter(Boolean);
    cards.update(models.map(({ form, ...card }) => card));
    mountForm('watched', idForm);
    for (const card of zoneCards) if (card.form) mountForm(card.id, card.form);
    if (focusAfterRender) {
      const target =
        typeof focusAfterRender === 'function'
          ? focusAfterRender()
          : focusAfterRender;
      focusAfterRender = null;
      target?.focus?.();
    }
  }

  return {
    /** @param {WatchPanelModel} next */
    update(next) {
      if (destroyed || !isRecord(next)) return;
      model = next;
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      lifetime.destroy();
      cards?.destroy();
      idForm.root.remove();
      for (const form of renameForms.values()) form.root.remove();
      renameForms.clear();
      banner.remove();
      writeError.remove();
      cardsHost.remove();
      if (panel) set(panel, 'hidden', true);
      if (countBadge) set(countBadge, 'textContent', '');
    },
  };
}
