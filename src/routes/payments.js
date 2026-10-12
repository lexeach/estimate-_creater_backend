import { Router } from 'express';
import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import { Estimate, MasterOrder, Payment, Company, Counter } from '../models/index.js';
import { asyncHandler, audit, money, nextNumber } from '../utils/helpers.js';
import { notifySuccessfulPayment } from '../utils/paymentNotifications.js';

const router = Router();
const razorpay = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    const e = new Error('Online payments are not configured yet. Please contact the business owner.'); e.status = 503; throw e;
  }
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
};
const secureEqual = (a, b) => {
  const aa = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
function paymentState(total, paid) { return paid >= total - 0.01 ? 'Paid' : paid > 0 ? 'Partially Paid' : 'Pending'; }

async function ensureOrderForEstimate(estimate) {
  if (estimate.convertedOrderId) return await MasterOrder.findById(estimate.convertedOrderId);
  const groups = new Map();
  for (const item of estimate.items) {
    const key = String(item.companyId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ productId: item.productId, productName: item.productName, sku: item.sku, unit: item.unit, quantity: item.quantity, unitPrice: item.unitPrice, discountPercent: item.discountPercent, taxRate: item.taxRate, taxableAmount: item.taxableAmount, taxAmount: item.taxAmount, lineTotal: item.lineTotal });
  }
  const companyOrders = [];
  for (const [companyId, items] of groups) {
    const company = await Company.findById(companyId).lean();
    if (!company) throw new Error(`Company for one or more items is missing (${companyId}).`);
    const subtotal = money(items.reduce((sum, item) => sum + item.taxableAmount, 0));
    const taxTotal = money(items.reduce((sum, item) => sum + item.taxAmount, 0));
    companyOrders.push({ companyId, companyName: company.name, companyOrderNumber: await nextNumber(`company-order-${companyId}`, 'CO'), companySnapshot: { name: company.name, contactPerson: company.contactPerson, phone: company.phone, email: company.email, address: company.address, gstin: company.gstin }, items, subtotal, taxTotal, total: money(items.reduce((sum, item) => sum + item.lineTotal, 0)), status: 'Pending' });
  }
  const order = await MasterOrder.create({ orderNumber: await nextNumber('master-order', 'ORD'), estimateId: estimate._id, clientId: estimate.clientId, clientSnapshot: estimate.clientSnapshot, companyOrders, subtotal: estimate.subtotal, discountTotal: estimate.discountTotal, taxTotal: estimate.taxTotal, additionalCharges: estimate.additionalCharges, grandTotal: estimate.grandTotal, notes: estimate.notes, status: 'Booked', paymentStatus: 'Pending' });
  estimate.status = 'Converted'; estimate.convertedOrderId = order._id; await estimate.save();
  await audit('payment-auto-convert', 'estimate', estimate._id, { orderId: order._id, orderNumber: order.orderNumber });
  return order;
}

async function recordCapturedPayment({ estimate, orderId, razorpayOrderId, razorpayPaymentId, amountPaise, method = 'Other' }) {
  if (!razorpayPaymentId) throw new Error('Missing Razorpay payment ID.');
  const existing = await Payment.findOne({ razorpayPaymentId }).lean();
  if (existing) return { payment: existing, duplicate: true };
  const order = orderId ? await MasterOrder.findById(orderId) : await ensureOrderForEstimate(estimate);
  if (!order) throw new Error('Order could not be found for this payment.');
  const amount = money(Number(amountPaise) / 100);
  if (!(amount > 0)) throw new Error('Payment amount is invalid.');
  const paidBefore = await Payment.aggregate([{ $match: { masterOrderId: order._id } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
  const alreadyPaid = Number(paidBefore[0]?.total || 0);
  if (alreadyPaid + amount > order.grandTotal + 0.01) {
    // Do not silently accept a duplicate/overpayment against the order balance.
    const e = new Error('Payment amount exceeds the remaining order balance.'); e.status = 409; throw e;
  }
  let payment;
  try {
    payment = await Payment.create({ masterOrderId: order._id, amount, paymentDate: new Date(), paymentMode: ['upi','card','netbanking','wallet','emi','paylater'].includes(String(method).toLowerCase()) ? (String(method).toLowerCase() === 'upi' ? 'UPI' : 'Card') : 'Other', reference: razorpayPaymentId, gateway: 'razorpay', razorpayOrderId, razorpayPaymentId, notes: 'Verified online payment via Razorpay' });
  } catch (error) {
    if (error.code === 11000) return { payment: await Payment.findOne({ razorpayPaymentId }).lean(), duplicate: true };
    throw error;
  }
  const paidTotal = money(alreadyPaid + amount);
  order.paymentStatus = paymentState(order.grandTotal, paidTotal); await order.save();
  if (estimate) { estimate.paymentStatus = order.paymentStatus; await estimate.save(); }
  await audit('razorpay-payment-captured', 'payment', payment._id, { orderId: order._id, amount, razorpayPaymentId });
  // Notify client, owner, and each supplier company only for the first successful insert.
  // Email failures are logged and do not invalidate the already-verified payment.
  try {
    const paidAfter = money(paidTotal);
    await notifySuccessfulPayment({ estimate: estimate || await Estimate.findById(order.estimateId), order, payment, paidTotal: paidAfter, balanceDue: money(Math.max(0, order.grandTotal - paidAfter)) });
  } catch (emailError) {
    console.error('Payment saved but notification processing failed:', emailError.message);
  }
  return { payment, order, duplicate: false };
}

// Public estimate summary for the client payment page. Never returns private bank/settings data.
router.get('/public/:token', asyncHandler(async (req, res) => {
  const estimate = await Estimate.findOne({ paymentToken: req.params.token }).lean();
  if (!estimate) return res.status(404).json({ message: 'Payment link is invalid or expired.' });
  if (estimate.status === 'Rejected' || estimate.status === 'Expired' || (estimate.validUntil && new Date(estimate.validUntil) < new Date())) return res.status(410).json({ message: 'This estimate is no longer payable.' });
  const paid = estimate.convertedOrderId ? await Payment.aggregate([{ $match: { masterOrderId: estimate.convertedOrderId } }, { $group: { _id: null, total: { $sum: '$amount' } } }]) : [];
  const paidTotal = money(paid[0]?.total || 0);
  res.json({ estimateNumber: estimate.estimateNumber, clientName: estimate.clientSnapshot?.name || '', businessName: estimate.bankDetails?.businessName || '', items: estimate.items.map(i => ({ productName: i.productName, quantity: i.quantity, lineTotal: i.lineTotal })), grandTotal: estimate.grandTotal, paidTotal, balanceDue: money(Math.max(0, estimate.grandTotal - paidTotal)), paymentStatus: paymentState(estimate.grandTotal, paidTotal), currency: 'INR' });
}));

router.post('/public/:token/create-order', asyncHandler(async (req, res) => {
  const estimate = await Estimate.findOne({ paymentToken: req.params.token });
  if (!estimate) return res.status(404).json({ message: 'Payment link is invalid or expired.' });
  if (['Rejected','Expired'].includes(estimate.status) || (estimate.validUntil && new Date(estimate.validUntil) < new Date())) return res.status(410).json({ message: 'This estimate is no longer payable.' });
  const orderId = estimate.convertedOrderId;
  const paid = orderId ? await Payment.aggregate([{ $match: { masterOrderId: orderId } }, { $group: { _id: null, total: { $sum: '$amount' } } }]) : [];
  const paidTotal = money(paid[0]?.total || 0); const balance = money(estimate.grandTotal - paidTotal);
  if (balance <= 0) return res.status(409).json({ message: 'This estimate has already been paid in full.' });
  const gatewayOrder = await razorpay().orders.create({ amount: Math.round(balance * 100), currency: 'INR', receipt: String(estimate.estimateNumber).slice(0, 40), notes: { estimateId: String(estimate._id), estimateNumber: estimate.estimateNumber, paymentToken: estimate.paymentToken } });
  res.json({ keyId: process.env.RAZORPAY_KEY_ID, orderId: gatewayOrder.id, amount: gatewayOrder.amount, currency: gatewayOrder.currency, estimateNumber: estimate.estimateNumber, businessName: estimate.bankDetails?.businessName || 'SalesDesk', clientName: estimate.clientSnapshot?.name || '' });
}));

router.post('/public/:token/verify', asyncHandler(async (req, res) => {
  const estimate = await Estimate.findOne({ paymentToken: req.params.token });
  if (!estimate) return res.status(404).json({ message: 'Payment link is invalid or expired.' });
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (!orderId || !paymentId || !signature) return res.status(400).json({ message: 'Payment verification fields are missing.' });
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(`${orderId}|${paymentId}`).digest('hex');
  if (!secureEqual(expected, signature)) return res.status(400).json({ message: 'Payment signature verification failed.' });
  const rp = razorpay();
  let gatewayPayment = await rp.payments.fetch(paymentId);
  if (gatewayPayment.order_id !== orderId) return res.status(400).json({ message: 'Payment does not belong to this Razorpay order.' });
  if (gatewayPayment.status === 'authorized') gatewayPayment = await rp.payments.capture(paymentId, gatewayPayment.amount, gatewayPayment.currency);
  if (gatewayPayment.status !== 'captured') return res.status(409).json({ message: 'Payment has not been captured yet. Please wait and refresh payment status.' });
  const gatewayOrder = await razorpay().orders.fetch(orderId);
  if (String(gatewayOrder.notes?.estimateId) !== String(estimate._id)) return res.status(400).json({ message: 'Payment does not match this estimate.' });
  const result = await recordCapturedPayment({ estimate, orderId: estimate.convertedOrderId, razorpayOrderId: orderId, razorpayPaymentId: paymentId, amountPaise: gatewayPayment.amount, method: gatewayPayment.method });
  res.json({ success: true, duplicate: result.duplicate, estimateNumber: estimate.estimateNumber, orderNumber: result.order?.orderNumber || (await MasterOrder.findById(estimate.convertedOrderId))?.orderNumber, amount: Number(gatewayPayment.amount) / 100 });
}));

export async function razorpayWebhook(req, res) {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ message: 'Webhook secret is not configured.' });
    const received = req.get('x-razorpay-signature') || '';
    const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    if (!secureEqual(expected, received)) return res.status(400).json({ message: 'Invalid webhook signature.' });
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'payment.captured') {
      const paymentEntity = event.payload?.payment?.entity;
      if (paymentEntity?.id && paymentEntity?.order_id) {
        const gatewayOrder = await razorpay().orders.fetch(paymentEntity.order_id);
        const estimateId = gatewayOrder.notes?.estimateId;
        const estimate = estimateId ? await Estimate.findById(estimateId) : null;
        if (estimate) await recordCapturedPayment({ estimate, orderId: estimate.convertedOrderId, razorpayOrderId: paymentEntity.order_id, razorpayPaymentId: paymentEntity.id, amountPaise: paymentEntity.amount, method: paymentEntity.method });
      }
    }
    return res.json({ received: true });
  } catch (error) {
    console.error('Razorpay webhook failed:', error.message);
    return res.status(error.status || 500).json({ message: 'Webhook processing failed.' });
  }
}
export default router;
