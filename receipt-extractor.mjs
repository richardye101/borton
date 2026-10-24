export const RECEIPT_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const RECEIPT_ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    merchant: { type: 'STRING', description: 'Store / merchant name' },
    date: { type: 'STRING', description: 'Purchase date as YYYY-MM-DD if visible, else empty string' },
    total: { type: 'NUMBER', description: 'Grand total paid' },
    currency: { type: 'STRING' },
    tax: { type: 'NUMBER' },
    card_last4: { type: 'STRING', description: 'Last 4 digits of the card if printed (e.g. from "VISA ****1234"), else empty string' },
    line_items: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Short list of items purchased' },
  },
  required: ['merchant', 'total'],
};

export const RECEIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    receipts: {
      type: 'ARRAY',
      items: RECEIPT_ITEM_SCHEMA,
      description: 'Every separate purchase receipt visible in the image, up to eight.',
    },
  },
  required: ['receipts'],
};

export function createReceiptExtractor({ generate, maxBytes = 10 * 1024 * 1024 } = {}) {
  if (typeof generate !== 'function') throw new TypeError('generate must be a function');
  return {
    async extractImage(buffer, mime) {
      if (!RECEIPT_IMAGE_TYPES.has(mime)) throw new Error('Unsupported image type. Use JPEG, PNG, WebP, HEIC, or HEIF.');
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Receipt image is empty.');
      if (buffer.length > maxBytes) throw new Error('Receipt image exceeds the 10 MB limit.');
      return generate([
        { text: 'Extract every separate purchase receipt visible in this image into the receipts array. A receipt is a distinct proof of purchase, not a duplicate copy, coupon, subtotal, or line item. Use the printed grand total for total. List each purchased item in line_items using short names (condense long descriptions, drop prices/quantities). If a card last-4 is not printed, return an empty string for card_last4. Return one array entry for an ordinary single receipt.' },
        { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
      ], RECEIPT_SCHEMA);
    },
  };
}
