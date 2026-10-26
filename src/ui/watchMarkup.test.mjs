import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandApplicationHtml } from '../../build/application-html.js';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const html = expandApplicationHtml(read('index.html'));
const css = readStylesheet(path.join(ROOT, 'style.css'));
const watchCss = read('src/ui/styles/watch.css');
const panelChrome = read('src/ui/panelChrome.js');
const layoutController = read('src/ui/panelLayoutController.js');

function watchPanelMarkup() {
  const start = html.indexOf('<section id="watch-panel"');
  assert.ok(start > 0, 'the Watch panel is in the page');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end + '</section>'.length);
}

test('Watch is a hidden, collapsed right-rail panel on the shared surface', () => {
  assert.match(
    html,
    /<section id="watch-panel" data-panel-id="watch-panel" class="panel-collapsible collapsed" hidden>/,
  );
  const markup = watchPanelMarkup();
  // The surface is the first child (no glow), header outside the body.
  assert.match(
    markup,
    /^<section[^>]*>\s*<div data-panel-surface>\s*<header data-panel-header>/,
  );
  assert.doesNotMatch(markup, /panel-glow/);
  assert.match(
    markup,
    /<span class="panel-title panel-surface-title" data-i18n>WATCH<\/span>/,
  );
  assert.match(
    markup,
    /<span id="watch-panel-count" aria-label="Unread watch events" data-i18n-aria-label><\/span>/,
  );
  assert.match(
    markup,
    /<button class="panel-collapse-btn panel-surface-control" data-collapse-target="watch-panel" type="button"/,
  );
  assert.ok(
    markup.indexOf('</header>') <
      markup.indexOf('<div id="watch-panel-body" data-panel-body'),
  );
  assert.match(
    markup,
    /<div id="watch-panel-body" data-panel-body data-rail-scroller><\/div>/,
  );
  // It sits in the right rail, directly before Context.
  const rail = html.slice(
    html.indexOf('<aside id="right-context-rail">'),
    html.indexOf('<div id="global-context-panel"'),
  );
  assert.ok(rail.includes('<section id="watch-panel"'));
});

test('the panel is registered with panel chrome and the right rail only', () => {
  assert.match(
    panelChrome,
    /COCKPIT_ENTRY_COLLAPSE_PANEL_IDS = Object\.freeze\(\[[^\]]*'watch-panel'/,
  );
  assert.match(panelChrome, /const isRightRail = \[[^\]]*'watch-panel'/);
  const share = panelChrome.match(
    /const SHARE_PANEL_STATE_SPECS = Object\.freeze\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(share, 'share specs are readable');
  assert.doesNotMatch(share[1], /watch-panel/, 'watch state is never shared');
  assert.doesNotMatch(read('src/sharelink.js'), /watch-panel/);
  assert.doesNotMatch(read('src/ui/mobileShell.js'), /watch-panel/);
  assert.doesNotMatch(read('src/voice/actionSchemas.js'), /watch-panel/);
  assert.doesNotMatch(read('src/voice/gevActions.js'), /watch-panel/);
  assert.match(
    layoutController,
    /this\._watchPanel = document\.getElementById\('watch-panel'\);/,
  );
  assert.match(
    layoutController,
    /for \(const panel of \[[\s\S]*?this\._watchPanel,[\s\S]*?\]\) \{[\s\S]*?stack\.insertBefore\(panel, globalContextPanel\)/,
  );
  assert.match(
    layoutController,
    /this\._watchPanel,\s*globalContextPanel,[\s\S]*?\]\) \{\s*if \(panel\) this\._rightStackResizeObserver\.observe\(panel\);/,
  );
});

test('DISPLAY ▸ Watch sits between Import and Celestial with the visibility glyph', () => {
  const display = html.match(/id="pp-toggles"[\s\S]*?id="clean-view-exit"/)[0];
  assert.match(
    display,
    /id="geo-import-group"[\s\S]*?id="watch-group"[\s\S]*?id="celestial-toggle"/,
  );
  const group = display.match(
    /<div class="pp-toggle-group" id="watch-group">[\s\S]*?<\/div>/,
  );
  assert.ok(group, 'the Watch toggle has its own group');
  assert.match(
    group[0],
    /<button class="pp-toggle-btn" id="watch-toggle" type="button"[^>]*aria-pressed="false"[^>]*aria-controls="watch-panel"[^>]*data-i18n-title>/,
  );
  assert.match(
    group[0],
    /<span class="pp-icon material-symbols-outlined" aria-hidden="true">visibility<\/span>/,
  );
  assert.match(group[0], /<span class="pp-label" data-i18n>Watch<\/span>/);
});

test('watch.css loads after the shared surface rules and shows no CSS text', () => {
  const entry = read('style.css');
  assert.ok(
    entry.indexOf("@import './src/ui/styles/panel-surfaces.css';") <
      entry.indexOf("@import './src/ui/styles/watch.css';"),
  );
  assert.ok(
    entry.indexOf("@import './src/ui/styles/watch.css';") <
      entry.indexOf("@import './src/ui/styles/cyber.css';"),
    'Cyber still has the last word',
  );
  assert.ok(css.includes('#watch-panel-count'));
  for (const [, value] of watchCss.matchAll(/content:\s*([^;]+);/g)) {
    assert.equal(value.trim(), 'none');
  }
  // The rail and the shared contract own placement and height.
  assert.doesNotMatch(
    watchCss,
    /#right-context-rail|#watch-panel\s*\{[^}]*\b(?:position|height|max-height|width):/,
  );
});
