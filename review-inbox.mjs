import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86_400_000;
const cleanMerchant = (value = '') => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dateDistance = (left, right) => Math.abs(Date.parse(`${left}T12:00:00Z`) - Date.parse(`${right}T12:00:00Z`)) / DAY;
const confidence = (score) => score >= 8 ? 'strong' : score >= 5 ? 'review' : 'weak';
const clone = (value) => structuredClone(value);

export function rankReviewCandidates(row, existing = []) {
  return existing
    .filter((candidate) => candidate?.id && candidate.accountId === row.accountId && candidate.amountCents === row.amountCents && candidate.importedId !== row.importedId)
    .map((candidate) => {
      const daysApart = dateDistance(row.date, candidate.date);
      if (!Number.isFinite(daysApart) || daysApart > 21) return null;
      const merchant = cleanMerchant(row.merchant), current = cleanMerchant(candidate.merchant);
      const merchantScore = merchant === current ? 7 : merchant && current && (merchant.includes(current) || current.includes(merchant)) ? 5 : 0;
      const score = merchantScore + (daysApart <= 1 ? 5 : daysApart <= 3 ? 3 : daysApart <= 7 ? 2 : daysApart <= 14 ? 1 : 0);
      return { id: candidate.id, confidence: confidence(score), daysApart, evidence: { sameAmount: true, merchant: merchantScore === 7 ? 'exact' : merchantScore ? 'contains' : 'none' }, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.daysApart - right.daysApart)
    .map(({ score, ...candidate }) => candidate);
}

export function createReviewInbox({ filePath, receiptDir, now = Date.now } = {}) {
  if (!filePath || !receiptDir) throw new Error('filePath and receiptDir are required.');
  const read = () => {
    if (!fs.existsSync(filePath)) return { version: 1, reviews: [] };
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.reviews)) throw new Error('Unreadable reviews inbox; preserve the file before recovery.');
    return state;
  };
  let state = read();
  const save = () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.tmp`; const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filePath); fs.chmodSync(filePath, 0o600);
  };
  const status = (row) => row.candidates?.length ? 'match' : 'new';
  const publicRow = (row) => clone(row);
  save();
  return {
    stagePlaid(rows = []) {
      let staged = 0; let existing = 0;
      for (const input of rows) {
        if (!input?.importedId || !input.accountId || !input.date || !Number.isSafeInteger(input.amountCents) || !String(input.merchant || '').trim()) continue;
        const id = `plaid:${input.importedId}`;
        const found = state.reviews.find((row) => row.id === id);
        if (found) { existing += 1; continue; }
        state.reviews.push({ id, source: 'plaid', status: status(input), importedId: input.importedId, accountId: input.accountId, account: String(input.account || ''), institution: String(input.institution || ''), date: input.date, amountCents: input.amountCents, merchant: String(input.merchant).trim(), candidates: clone(input.candidates || []), createdAt: now(), updatedAt: now(), audit: [] }); staged += 1;
      }
      if (staged) save();
      return { staged, existing };
    },
    stageReceipt(file = {}) {
      const bytes = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || '');
      if (!bytes.length || !file.mime) throw new Error('Receipt image is required.');
      const hash = crypto.createHash('sha256').update(bytes).digest('hex'); const id = `receipt:${hash}`;
      const found = state.reviews.find((row) => row.id === id); if (found) return publicRow(found);
      fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 }); const imagePath = path.join(receiptDir, hash);
      fs.writeFileSync(imagePath, bytes, { mode: 0o600 }); fs.chmodSync(imagePath, 0o600);
      const row = { id, source: 'receipt', status: 'queued', imagePath, mime: file.mime, hash, createdAt: now(), updatedAt: now(), expiresAt: now() + 30 * DAY, candidates: [], audit: [] };
      state.reviews.push(row); save(); return publicRow(row);
    },
    completeReceipt(id, extraction = {}) {
      const row = state.reviews.find((entry) => entry.id === id); if (!row || row.source !== 'receipt') throw new Error('Receipt review not found.');
      Object.assign(row, clone(extraction), { status: status(extraction), updatedAt: now() }); save(); return publicRow(row);
    },
    retryReceipt(id, error, nextAt) {
      const row = state.reviews.find((entry) => entry.id === id); if (!row || row.source !== 'receipt') throw new Error('Receipt review not found.');
      Object.assign(row, { status: 'retrying', lastError: String(error || ''), nextAt, updatedAt: now() }); save(); return publicRow(row);
    },
    resolve(id, decision) {
      const row = state.reviews.find((entry) => entry.id === id); if (!row) throw new Error('Review not found.');
      if (row.status === 'completed') return publicRow(row);
      row.status = 'completed'; row.resolution = clone(decision || {}); row.updatedAt = now(); row.audit.push({ at: now(), decision: clone(decision || {}) }); save(); return publicRow(row);
    },
    list({ status: wanted = 'open', query = '', sort = 'date', direction = 'desc' } = {}) {
      const lower = String(query).toLowerCase(); const rows = state.reviews.filter((row) => wanted === 'all' || wanted === 'completed' ? (wanted === 'all' || row.status === 'completed') : row.status !== 'completed').filter((row) => !lower || `${row.merchant || ''} ${row.account || ''} ${row.institution || ''}`.toLowerCase().includes(lower));
      return rows.sort((left, right) => String(left[sort] ?? '').localeCompare(String(right[sort] ?? '')) * (direction === 'asc' ? 1 : -1)).map(publicRow);
    },
    cleanup() {
      let removed = 0;
      for (const row of state.reviews) if (row.imagePath && row.expiresAt <= now() && fs.existsSync(row.imagePath)) { fs.unlinkSync(row.imagePath); delete row.imagePath; row.imageExpiredAt = now(); removed += 1; }
      if (removed) save(); return { removed };
    },
  };
}
