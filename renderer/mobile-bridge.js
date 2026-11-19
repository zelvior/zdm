/* Mobile adapter: exposes the same window.downloader API as desktop/preload.cjs on top of window.zdmMobile.
   Loaded before app.js; it is a no-op in Electron, where the preload API already exists. */
(function () {
  'use strict';

  // The Promise bridge lives here too so the desktop page needs no extra script; it is inert without a native host.
  if (!window.zdmMobile) {
    const pending = new Map();
    let nextId = 1;
    window.zdmResolve = (id, json) => {
      if (!pending.has(id)) return;
      const resolve = pending.get(id);
      pending.delete(id);
      resolve(typeof json === 'string' ? JSON.parse(json) : json);
    };
    window.zdmMobile = {
      call(method, payload) {
        const id = nextId++;
        if (window.zdmNative) return Promise.resolve(window.zdmNative.call(method, JSON.stringify(payload || {})))
          .then(result => (typeof result === 'string' ? JSON.parse(result) : result));
        if (window.webkit?.messageHandlers?.zdmNative) {
          return new Promise(resolve => {
            pending.set(id, resolve);
            window.webkit.messageHandlers.zdmNative.postMessage({ id, method, payload: payload || {} });
          });
        }
        return Promise.resolve({ ok: false, error: 'Native bridge is unavailable.' });
      }
    };
  }

  if (window.downloader) return;

  const call = async (method, payload = {}) => {
    const result = await window.zdmMobile.call(method, payload);
    if (result && result.ok === false) throw new Error(result.error || 'The request failed.');
    return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
  };

  // The desktop page links icons at ../assets; Android flattens renderer/assets into one assets root.
  const flattenAssets = () => {
    if (/\/renderer\/index\.html$/.test(location.pathname)) return;
    for (const image of document.querySelectorAll('img[src^="../assets/"]'))
      image.src = image.getAttribute('src').slice(3);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', flattenAssets);
  else flattenAssets();

  const listeners = new Set();
  let poll = null;
  const emit = value => { for (const listener of listeners) listener(value); };
  const startPolling = () => {
    if (poll) return;
    poll = setInterval(async () => {
      try { emit(await call('snapshot')); } catch { /* transient bridge errors keep the last snapshot */ }
    }, 700);
  };

  window.downloader = Object.freeze({
    snapshot: () => call('snapshot'),
    add: data => call('add', data),
    review: data => call('review', data),
    action: data => call('action', data),
    settings: data => call('settings', data),
    chooseDirectory: () => call('chooseDirectory'),
    clipboard: () => call('clipboard'),
    integration: () => call('integration'),
    browserSetup: data => call('browserSetup', data),
    registerBrowser: data => call('registerBrowser', data),
    registerCustom: data => call('registerCustom', data),
    removeCustom: data => call('removeCustom', data),
    openProgress: data => call('openProgress', data),
    closeProgress: () => call('closeProgress'),
    resizeProgress: data => call('resizeProgress', data),
    about: () => call('about'),
    subscribe(callback) {
      listeners.add(callback);
      startPolling();
      call('snapshot').then(emit).catch(() => {});
      return () => listeners.delete(callback);
    },
    onCommand(callback) {
      window.zdmCommand = callback;
      return () => { if (window.zdmCommand === callback) delete window.zdmCommand; };
    }
  });
})();
