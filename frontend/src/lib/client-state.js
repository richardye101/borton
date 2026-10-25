export function createSummaryCache() {
  const summaries = new Map();
  return { get: (period) => summaries.get(period), set: (period, value) => summaries.set(period, value), clear: () => summaries.clear() };
}
