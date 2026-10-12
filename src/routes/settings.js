import { Router } from 'express';
import { AppSettings as Settings } from '../models/index.js';
import { asyncHandler, audit } from '../utils/helpers.js';
const router = Router();
const fields = ['businessName','businessAddress','businessPhone','businessEmail','businessWebsite','ownerWhatsAppNumber','logoDataUrl','bankAccountHolder','bankName','accountNumber','ifscCode','branch','upiId','paymentInstructions'];
router.get('/', asyncHandler(async (_req, res) => {
  const doc = await Settings.findOne({ key: 'owner' }).lean();
  const result = Object.fromEntries(fields.map(field => [field, doc?.[field] || '']));
  res.json(result);
}));
router.put('/', asyncHandler(async (req, res) => {
  const data = Object.fromEntries(fields.map(field => [field, String(req.body[field] ?? '').trim()]));
  if (data.logoDataUrl && (!/^data:image\/(png|jpeg|webp);base64,/.test(data.logoDataUrl) || data.logoDataUrl.length > 1000000)) return res.status(400).json({ message: 'Logo must be a PNG, JPG or WebP image under 700 KB.' });
  if (data.ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(data.ifscCode)) {
    return res.status(400).json({ message: 'Please enter a valid IFSC code (11 characters).' });
  }
  const doc = await Settings.findOneAndUpdate({ key: 'owner' }, { $set: data, $setOnInsert: { key: 'owner' } }, { new: true, upsert: true, runValidators: true }).lean();
  await audit('update', 'settings', String(doc._id), { section: 'payment-bank-details' });
  res.json(Object.fromEntries(fields.map(field => [field, doc[field] || ''])));
}));
export default router;
