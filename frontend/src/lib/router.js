const views = new Set(['home', 'summary', 'shared', 'add', 'check']);

export function routeFromPath(pathname = '/') {
  const transaction = pathname.match(/^\/home\/transactions\/([^/]+)$/);
  if (transaction) return { view: 'home', transactionId: decodeURIComponent(transaction[1]) };
  const view = pathname.slice(1);
  return { view: views.has(view) ? view : 'home', transactionId: '' };
}

export function pathForRoute(view = 'home', transactionId = '') {
  if (view === 'home' && transactionId) return `/home/transactions/${encodeURIComponent(transactionId)}`;
  return `/${views.has(view) ? view : 'home'}`;
}
