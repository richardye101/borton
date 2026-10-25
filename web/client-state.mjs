export function createSummaryCache() {
  const summaries = new Map();
  return { get: (period) => summaries.get(period), set: (period, summary) => summaries.set(period, summary), clear: () => summaries.clear() };
}
