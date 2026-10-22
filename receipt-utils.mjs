const DAY_MS = 86400000;

function asDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function isValidExpenseDate(value, today = new Date().toISOString().slice(0, 10)) {
  const date = asDate(value);
  const now = asDate(today);
  return !!date && !!now && date <= new Date(now.getTime() + 2 * DAY_MS) && date >= new Date(now.getTime() - 5 * 365 * DAY_MS);
}

const merchantKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const merchantMatches = (left, right) => {
  const a = merchantKey(left), b = merchantKey(right);
  return a === b || (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a)));
};

export function findLikelyDuplicates(transactions, { total, merchant, date }) {
  const targetDate = asDate(date);
  const cents = Math.round(Math.abs(Number(total)) * 100);
  if (!targetDate || !cents || !merchantKey(merchant)) return [];
  return (transactions || []).filter((txn) => {
    const txnDate = asDate(txn.date);
    const days = txnDate ? Math.abs(txnDate - targetDate) / DAY_MS : Infinity;
    const txnMerchant = txn.payee_name || txn.payee || txn.payeeName || '';
    return !txn.deleted && Math.abs(Number(txn.amount)) === cents && days <= 4 && merchantMatches(txnMerchant, merchant);
  });
}
