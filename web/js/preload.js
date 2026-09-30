// Starts fetching the view module for this address while app.js loads, so the
// view does not wait for app.js to ask for it (paths as in app.js's routes).
(() => {
  const p = location.pathname;
  const view = p === '/' || p === '' ? 'overview' : /^\/markets\/\d+\/?$/.test(p) ? 'market' : /^\/wallet\//.test(p) ? 'wallet' : /^\/watchlist/.test(p) ? 'alerts' : (p.match(/^\/(markets|traders|liquidations|risk|compare|alerts|status)\/?$/) || [])[1];
  if (!view) return;
  const add = href => { const l = document.createElement('link'); l.rel = 'modulepreload'; l.href = href; document.head.appendChild(l); };
  add(`/js/views/${view}.js`);
  if (view === 'traders') add('/js/cohort-icons.js');
})();
