import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the version shown in the app is the service worker cache version', () => {
  const sw = /const CACHE = 'homehub-(v\d+)'/.exec(readFileSync(new URL('../../web/sw.js', import.meta.url), 'utf8'));
  const app = /const APP_VERSION = '(v\d+)'/.exec(readFileSync(new URL('../../web/js/app.js', import.meta.url), 'utf8'));
  assert.ok(sw && app);
  assert.equal(app[1], sw[1], 'bump APP_VERSION in web/js/app.js together with CACHE in web/sw.js');
});
