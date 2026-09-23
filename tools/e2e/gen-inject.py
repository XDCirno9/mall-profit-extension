"""Build tools/e2e/inject.js from the real extension sources.

The generated script is registered with `agent-browser open --init-script`.
It must run before the mall's own bundle, so it only defines helpers on
`window` and does not touch the DOM at load time.

Usage:
    python tools/e2e/gen-inject.py
"""

import io
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
EXT = os.path.join(REPO, 'mall-profit-extension')


def read(name):
    with io.open(os.path.join(EXT, name), encoding='utf-8') as handle:
        return handle.read()


CSS = read('content.css')
CORE = read('profit-core.js')
CONTENT = read('content.js')
SITES = read('site-adapters.js')

TEMPLATE = r"""(function () {
  var CSS = __CSS__;
  var CORE = __CORE__;
  var CONTENT = __CONTENT__;
  var SITES = __SITES__;

  // In-memory stand-in for chrome.storage.local so nothing is persisted.
  var store = {};
  var storageLocal = {
    get: function (keys) {
      var list = keys == null ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
      var out = {};
      for (var i = 0; i < list.length; i += 1) {
        if (Object.prototype.hasOwnProperty.call(store, list[i])) out[list[i]] = store[list[i]];
      }
      return Promise.resolve(out);
    },
    set: function (values) {
      Object.keys(values || {}).forEach(function (key) { store[key] = values[key]; });
      return Promise.resolve();
    },
    remove: function (keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach(function (key) { delete store[key]; });
      return Promise.resolve();
    }
  };

  if (!window.chrome) window.chrome = {};
  try {
    window.chrome.storage = { local: storageLocal };
  } catch (error) {
    Object.defineProperty(window.chrome, 'storage', { value: { local: storageLocal }, configurable: true });
  }

  // Record every request so a driver can prove what the extension did or did not do.
  // The untouched fetch stays reachable so a driver can opt out of the /items
  // rewrite below and measure against the real catalogue size.
  var originalFetch = window.fetch.bind(window);
  window.__mpeOriginalFetch = originalFetch;
  window.__mpeFetchLog = [];
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    window.__mpeFetchLog.push(url);
    if (url.indexOf('/api/mall/items?') !== -1 && url.indexOf('limit=100') !== -1) {
      // The mall pages 100 items at a time; keep the shape but never let the
      // harness wait on a second page it cannot observe.
      return originalFetch(input, init).then(function (response) {
        return response.json().then(function (data) {
          var body = data;
          if (data && Array.isArray(data.items)) {
            body = { total: data.items.length, items: data.items };
          }
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        });
      });
    }
    return originalFetch(input, init);
  };

  window.__mpeBoot = function () {
    if (document.getElementById('mpe-root')) return 'already';
    var style = document.createElement('style');
    style.id = 'mpe-test-style';
    style.textContent = CSS;
    document.head.appendChild(style);
    (0, eval)(CORE);
    (0, eval)(SITES);
    (0, eval)(CONTENT);
    return document.getElementById('mpe-root') ? 'booted' : 'failed';
  };
})();
"""

output = (TEMPLATE
          .replace('__CSS__', json.dumps(CSS))
          .replace('__CORE__', json.dumps(CORE))
          .replace('__CONTENT__', json.dumps(CONTENT))
          .replace('__SITES__', json.dumps(SITES)))

target = os.path.join(HERE, 'inject.js')
with io.open(target, 'w', encoding='utf-8', newline='\n') as handle:
    handle.write(output)

print('written', target, len(output), 'bytes')
