import { Router } from 'express';
import { MasterOrder, Payment } from '../models/index.js';
import { asyncHandler, audit } from '../utils/helpers.js';
const router = Router();
const companyStatuses = ['Pending','Sent','Confirmed','Rejected','Partially Dispatched','Dispatched','Delivered','Cancelled'];
function deriveMasterStatus(order) {
  const active = order.companyOrders.filter(c => c.status !== 'Cancelled' && c.status !== 'Rejected');
  if (!active.length) return 'Cancelled';
  if (active.every(c => c.status === 'Delivered')) return 'Completed';
  if (active.some(c => ['Confirmed','Partially Dispatched','Dispatched','Delivered'].includes(c.status))) return active.every(c => ['Confirmed','Partially Dispatched','Dispatched','Delivered'].includes(c.status)) ? 'Processing' : 'Partially Completed';
  return 'Booked';
}
router.get('/', asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  res.json(await MasterOrder.find(filter).sort({ createdAt: -1 }).limit(500).lean());
}));
router.get('/:id', asyncHandler(async (req, res) => {
  const doc = await MasterOrder.findById(req.params.id).lean();
  if (!doc) return res.status(404).json({ message: 'Order not found.' });
  const payments = await Payment.find({ masterOrderId: doc._id }).sort({ paymentDate: -1 }).lean();
  const paid = payments.reduce((sum, p) => sum + p.amount, 0);
  res.json({ ...doc, payments, paidTotal: Math.round(paid * 100) / 100, balanceDue: Math.round((doc.grandTotal - paid) * 100) / 100 });
}));
router.patch('/:id/company-orders/:companyOrderId/status', asyncHandler(async (req, res) => {
  if (!companyStatuses.includes(req.body.status)) return res.status(400).json({ message: 'Invalid company order status.' });
  const order = await MasterOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  const companyOrder = order.companyOrders.id(req.params.companyOrderId);
  if (!companyOrder) return res.status(404).json({ message: 'Company order not found.' });
  companyOrder.status = req.body.status;
  if (req.body.status === 'Sent') companyOrder.sentAt = new Date();
  if (req.body.status === 'Confirmed') companyOrder.confirmedAt = new Date();
  if (req.body.notes !== undefined) companyOrder.notes = String(req.body.notes);
  order.status = deriveMasterStatus(order);
  await order.save();
  await audit('company-order-status', 'master-order', order._id, { companyOrderId: String(companyOrder._id), status: companyOrder.status });
  res.json(order);
}));
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const allowed = ['Booked','Processing','Partially Completed','Completed','Cancelled'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ message: 'Invalid order status.' });
  const order = await MasterOrder.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true, runValidators: true });
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  await audit('order-status', 'master-order', order._id, { status: order.status });
  res.json(order);
}));
router.post('/:id/payments', asyncHandler(async (req, res) => {
  const order = await MasterOrder.findById(req.params.id);
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Payment amount must be greater than zero.' });
  const payment = await Payment.create({ masterOrderId: order._id, amount, paymentDate: req.body.paymentDate || new Date(), paymentMode: req.body.paymentMode || 'UPI', reference: String(req.body.reference || ''), notes: String(req.body.notes || '') });
  await audit('payment-recorded', 'payment', payment._id, { orderId: order._id, amount });
  res.status(201).json(payment);
}));
router.delete('/:id/payments/:paymentId', asyncHandler(async (req, res) => {
  const payment = await Payment.findOneAndDelete({ _id: req.params.paymentId, masterOrderId: req.params.id });
  if (!payment) return res.status(404).json({ message: 'Payment record not found.' });
  await audit('payment-deleted', 'payment', payment._id, {});
  res.json({ message: 'Payment record deleted.' });
}));
export default router;
