export function matchItem(items, value) {
  const normalized = String(value || '').trim().toLocaleLowerCase();
  return items.find((item) => item.id === value || item.name.toLocaleLowerCase() === normalized) || null;
}

export function itemName(items, id) {
  return items.find((item) => item.id === id)?.name || '';
}
