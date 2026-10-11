import { Router } from 'express';
import { Company, Product, Client } from '../models/index.js';
import { asyncHandler, audit } from '../utils/helpers.js';
const router = Router();
const configs = {
  companies: { model: Company, required: ['name'], fields: ['name','contactPerson','phone','email','address','gstin','notes','active'] },
  products: { model: Product, required: ['company','name','sellingPrice'], fields: ['company','sku','name','description','category','unit','basePrice','sellingPrice','taxRate','active'] },
  clients: { model: Client, required: ['name'], fields: ['name','businessName','phone','email','gstin','billingAddress','shippingAddress','notes','active'] }
};
for (const [resource, config] of Object.entries(configs)) {
  router.get(`/${resource}`, asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';
    if (resource === 'products' && req.query.company) filter.company = req.query.company;
    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = resource === 'companies' ? [{ name: rx }, { phone: rx }] : resource === 'products' ? [{ name: rx }, { sku: rx }, { category: rx }] : [{ name: rx }, { businessName: rx }, { phone: rx }];
    }
    const docs = await config.model.find(filter).sort({ updatedAt: -1 }).limit(1000).lean();
    res.json(docs);
  }));
  router.post(`/${resource}`, asyncHandler(async (req, res) => {
    const data = Object.fromEntries(config.fields.filter(k => req.body[k] !== undefined).map(k => [k, req.body[k]]));
    for (const key of config.required) if (data[key] === undefined || data[key] === '') return res.status(400).json({ message: `${key} is required.` });
    if (resource === 'products') {
      if (!Number.isFinite(Number(data.sellingPrice)) || Number(data.sellingPrice) < 0) return res.status(400).json({ message: 'Selling price must be a valid non-negative number.' });
      data.sellingPrice = Number(data.sellingPrice); data.basePrice = Number(data.basePrice || 0); data.taxRate = Number(data.taxRate || 0);
    }
    const doc = await config.model.create(data);
    await audit('create', resource, doc._id, { name: doc.name });
    res.status(201).json(doc);
  }));
  router.put(`/${resource}/:id`, asyncHandler(async (req, res) => {
    const data = Object.fromEntries(config.fields.filter(k => req.body[k] !== undefined).map(k => [k, req.body[k]]));
    if (resource === 'products') for (const k of ['sellingPrice','basePrice','taxRate']) if (data[k] !== undefined) data[k] = Number(data[k]);
    const doc = await config.model.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
    if (!doc) return res.status(404).json({ message: 'Record not found.' });
    await audit('update', resource, doc._id, data);
    res.json(doc);
  }));
  router.delete(`/${resource}/:id`, asyncHandler(async (req, res) => {
    // Soft-deactivate catalogue records to preserve historical references.
    const doc = await config.model.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
    if (!doc) return res.status(404).json({ message: 'Record not found.' });
    await audit('deactivate', resource, doc._id);
    res.json({ message: 'Record deactivated.', id: String(doc._id) });
  }));
}
export default router;
