/**
 * Watch: watch zones, watched assets, honest events and place briefs.
 *
 * This entry point re-exports every portable Watch module so the controller,
 * the panel and the wording module import from one place. Every module is
 * pure (no platform globals, timers, storage or clocks); see each module for
 * its contract.
 */

/** Zone geometry: rings, circles, compiled zones, margins and coverage. */
export * from './geometry.js';
/** The saved Watch document: zones, watched assets and preferences. */
export * from './document.js';
/** Feed-honest observation frames and zone answers. */
export * from './frames.js';
/** Zone presence state machine for one asset in one zone. */
export * from './presence.js';
/** Watched assets: matching, the privacy guard, presence and debounce. */
export * from './watchlist.js';
/** Emergency onset tracker. */
export * from './emergency.js';
/** New fires and quakes in zones. */
export * from './hazards.js';
/** Session-only watch inbox. */
export * from './eventLog.js';
/** Occupancy series per zone and kind. */
export * from './occupancy.js';
/** Place briefs. */
export * from './brief.js';
/** The Watch engine that ties the modules together. */
export * from './engine.js';
