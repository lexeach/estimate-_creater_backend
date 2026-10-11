import { Router } from 'express';
import { Company, Product, Client, Estimate, MasterOrder, Payment } from '../models/index.js';
import { asyncHandler } from '../utils/helpers.js';
const router = Router();
router.get('/', asyncHandler(async (_req, res) => {
  const [companies, products, clients, estimates, orders, pendingCompanyOrders, recentEstimates, recentOrders, payments] = await Promise.all([
    Company.countDocuments({ active: true }), Product.countDocuments({ active: true }), Client.countDocuments({ active: true }),
    Estimate.countDocuments(), MasterOrder.countDocuments(), MasterOrder.countDocuments({ 'companyOrders.status': { $in: ['Pending','Sent'] } }),
    Estimate.find().sort({ createdAt: -1 }).limit(5).lean(), MasterOrder.find().sort({ createdAt: -1 }).limit(5).lean(), Payment.find().lean()
  ]);
  const paidTotal = payments.reduce((sum, p) => sum + p.amount, 0);
  const orderDocs = await MasterOrder.find({}, { grandTotal: 1 }).lean();
  res.json({ counts: { companies, products, clients, estimates, orders, pendingCompanyOrders }, totals: { confirmedOrderValue: orderDocs.reduce((s, o) => s + o.grandTotal, 0), paymentsReceived: Math.round(paidTotal * 100) / 100 }, recentEstimates, recentOrders });
}));
export default router;
