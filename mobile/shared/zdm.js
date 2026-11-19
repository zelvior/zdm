/* Shared mobile bridge adapter. Android exposes window.zdmNative.call synchronously; iOS posts a WKScriptMessage
   and the native side calls window.zdmResolve(id, json). Both become the same Promise-based API. */
(function () {
  let nextId = 1;
  const pending = new Map();
  window.zdmResolve = function (id, json) {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve(typeof json === 'string' ? JSON.parse(json) : json);
  };
  window.zdmMobile = {
    call(method, payload) {
      const id = nextId++;
      let request;
      if (window.zdmNative) {
        request = Promise.resolve(window.zdmNative.call(method, JSON.stringify(payload || {})));
      } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.zdmNative) {
        request = new Promise(resolve => {
          pending.set(id, resolve);
          window.webkit.messageHandlers.zdmNative.postMessage({ id, method, payload: payload || {} });
        });
      } else {
        request = Promise.resolve({ ok: false, error: 'Native bridge is unavailable.' });
      }
      return request
        .then(result => (typeof result === 'string' ? JSON.parse(result) : result))
        .catch(error => ({ ok: false, error: String(error && error.message || error) }));
    }
  };
})();
