import { Router } from 'express';
import { Estimate, Client, Company, Product, MasterOrder, AppSettings } from '../models/index.js';
import { asyncHandler, audit, calculateItem, money, nextNumber } from '../utils/helpers.js';
const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.search) filter.estimateNumber = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  res.json(await Estimate.find(filter).sort({ createdAt: -1 }).limit(500).lean());
}));
router.get('/:id', asyncHandler(async (req, res) => {
  const doc = await Estimate.findById(req.params.id).lean();
  if (!doc) return res.status(404).json({ message: 'Estimate not found.' });
  res.json(doc);
}));

router.post('/', asyncHandler(async (req, res) => {
  const client = await Client.findById(req.body.clientId).lean();
  if (!client) return res.status(400).json({ message: 'Please select a valid client.' });
  if (!Array.isArray(req.body.items) || !req.body.items.length) return res.status(400).json({ message: 'Add at least one product.' });
  const items = [];
  for (const raw of req.body.items) {
    const product = raw.productId ? await Product.findById(raw.productId).lean() : null;
    const companyId = raw.companyId || product?.company;
    const company = await Company.findById(companyId).lean();
    if (!company) return res.status(400).json({ message: 'Every estimate item must belong to a valid company.' });
    const productName = String(raw.productName || product?.name || '').trim();
    if (!productName) return res.status(400).json({ message: 'Product name is required.' });
    const calculated = calculateItem({
      productId: product?._id || raw.productId || null,
      companyId: company._id,
      companyName: company.name,
      productName,
      sku: String(raw.sku || product?.sku || ''),
      unit: String(raw.unit || product?.unit || 'pcs'),
      quantity: raw.quantity,
      unitPrice: raw.unitPrice ?? product?.sellingPrice,
      discountPercent: raw.discountPercent ?? 0,
      taxRate: raw.taxRate ?? product?.taxRate ?? 0
    });
    delete calculated._discountAmount;
    items.push(calculated);
  }
  const subtotal = money(items.reduce((s, i) => s + i.quantity * i.unitPrice, 0));
  const discountTotal = money(items.reduce((s, i) => s + i.quantity * i.unitPrice * i.discountPercent / 100, 0));
  const taxTotal = money(items.reduce((s, i) => s + i.taxAmount, 0));
  const additionalCharges = Math.max(0, Number(req.body.additionalCharges || 0));
  const grandTotal = money(items.reduce((s, i) => s + i.lineTotal, 0) + additionalCharges);
  const savedSettings = await AppSettings.findOne({ key: 'owner' }).lean();
  const bankDetails = savedSettings ? { businessName: savedSettings.businessName || '', businessAddress: savedSettings.businessAddress || '', businessPhone: savedSettings.businessPhone || '', businessEmail: savedSettings.businessEmail || '', businessWebsite: savedSettings.businessWebsite || '', logoDataUrl: savedSettings.logoDataUrl || '', bankAccountHolder: savedSettings.bankAccountHolder || '', bankName: savedSettings.bankName || '', accountNumber: savedSettings.accountNumber || '', ifscCode: savedSettings.ifscCode || '', branch: savedSettings.branch || '', upiId: savedSettings.upiId || '', paymentInstructions: savedSettings.paymentInstructions || '' } : {};
  const estimate = await Estimate.create({
    estimateNumber: await nextNumber('estimate', 'EST'), clientId: client._id,
    clientSnapshot: { name: client.name, businessName: client.businessName, phone: client.phone, email: client.email, gstin: client.gstin, billingAddress: client.billingAddress, shippingAddress: client.shippingAddress },
    items, subtotal, discountTotal, taxTotal, additionalCharges, grandTotal,
    notes: String(req.body.notes || ''), terms: String(req.body.terms || ''), bankDetails, validUntil: req.body.validUntil || null,
    status: req.body.status === 'Draft' ? 'Draft' : 'Draft'
  });
  await audit('create', 'estimate', estimate._id, { estimateNumber: estimate.estimateNumber, grandTotal });
  res.status(201).json(estimate);
}));

router.patch('/:id/status', asyncHandler(async (req, res) => {
  const allowed = ['Draft','Sent','Accepted','Rejected','Expired'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ message: 'Invalid estimate status.' });
  const doc = await Estimate.findById(req.params.id);
  if (!doc) return res.status(404).json({ message: 'Estimate not found.' });
  if (doc.status === 'Converted') return res.status(409).json({ message: 'A converted estimate cannot be changed.' });
  doc.status = req.body.status; await doc.save();
  await audit('status-change', 'estimate', doc._id, { status: doc.status });
  res.json(doc);
}));

router.post('/:id/convert', asyncHandler(async (req, res) => {
  const estimate = await Estimate.findById(req.params.id);
  if (!estimate) return res.status(404).json({ message: 'Estimate not found.' });
  if (estimate.convertedOrderId) return res.status(409).json({ message: 'This estimate has already been converted to an order.', orderId: estimate.convertedOrderId });
  if (!['Accepted','Sent','Draft'].includes(estimate.status)) return res.status(409).json({ message: 'Only a draft, sent or accepted estimate can be converted.' });
  const groups = new Map();
  for (const item of estimate.items) {
    const key = String(item.companyId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ productId: item.productId, productName: item.productName, sku: item.sku, unit: item.unit, quantity: item.quantity, unitPrice: item.unitPrice, discountPercent: item.discountPercent, taxRate: item.taxRate, taxableAmount: item.taxableAmount, taxAmount: item.taxAmount, lineTotal: item.lineTotal });
  }
  const companyOrders = [];
  for (const [companyId, items] of groups) {
    const company = await Company.findById(companyId).lean();
    if (!company) return res.status(400).json({ message: `Company for one or more items is missing (${companyId}).` });
    const subtotal = money(items.reduce((s, i) => s + i.taxableAmount, 0));
    const taxTotal = money(items.reduce((s, i) => s + i.taxAmount, 0));
    companyOrders.push({ companyId, companyName: company.name, companyOrderNumber: await nextNumber(`company-order-${companyId}`, 'CO'), companySnapshot: { name: company.name, contactPerson: company.contactPerson, phone: company.phone, email: company.email, address: company.address, gstin: company.gstin }, items, subtotal, taxTotal, total: money(items.reduce((s, i) => s + i.lineTotal, 0)), status: 'Pending' });
  }
  const order = await MasterOrder.create({ orderNumber: await nextNumber('master-order', 'ORD'), estimateId: estimate._id, clientId: estimate.clientId, clientSnapshot: estimate.clientSnapshot, companyOrders, subtotal: estimate.subtotal, discountTotal: estimate.discountTotal, taxTotal: estimate.taxTotal, additionalCharges: estimate.additionalCharges, grandTotal: estimate.grandTotal, notes: estimate.notes, status: 'Booked' });
  estimate.status = 'Converted'; estimate.convertedOrderId = order._id; await estimate.save();
  await audit('convert', 'estimate', estimate._id, { orderId: order._id, orderNumber: order.orderNumber });
  res.status(201).json(order);
}));
export default router;
