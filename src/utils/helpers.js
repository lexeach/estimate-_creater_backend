import { Counter, AuditLog } from '../models/index.js';

export async function nextNumber(key, prefix) {
  const doc = await Counter.findOneAndUpdate({ key }, { $inc: { value: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(doc.value).padStart(5, '0')}`;
}

export function money(value) {
  const n = Number(value);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function calculateItem(item) {
  const quantity = Number(item.quantity);
  const unitPrice = Number(item.unitPrice);
  const discountPercent = Number(item.discountPercent || 0);
  const taxRate = Number(item.taxRate || 0);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Quantity must be greater than zero.');
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('Unit price must be zero or greater.');
  if (discountPercent < 0 || discountPercent > 100) throw new Error('Discount must be between 0 and 100%.');
  if (taxRate < 0 || taxRate > 100) throw new Error('Tax rate must be between 0 and 100%.');
  const gross = money(quantity * unitPrice);
  const discount = money(gross * discountPercent / 100);
  const taxableAmount = money(gross - discount);
  const taxAmount = money(taxableAmount * taxRate / 100);
  return { ...item, quantity, unitPrice, discountPercent, taxRate, taxableAmount, taxAmount, lineTotal: money(taxableAmount + taxAmount), _discountAmount: discount };
}

export async function audit(action, recordType, recordId, details = {}) {
  try { await AuditLog.create({ action, recordType, recordId: String(recordId ?? ''), details }); } catch (e) { console.error('Audit log failed:', e.message); }
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
