import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const options = { timestamps: true };

const companySchema = new Schema({
  name: { type: String, required: true, trim: true },
  contactPerson: { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  address: { type: String, trim: true, default: '' },
  gstin: { type: String, trim: true, uppercase: true, default: '' },
  notes: { type: String, default: '' },
  active: { type: Boolean, default: true }
}, options);

const productSchema = new Schema({
  company: { type: Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  sku: { type: String, trim: true, default: '' },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: '' },
  category: { type: String, trim: true, default: '' },
  unit: { type: String, trim: true, default: 'pcs' },
  basePrice: { type: Number, min: 0, default: 0 },
  sellingPrice: { type: Number, min: 0, required: true },
  taxRate: { type: Number, min: 0, max: 100, default: 0 },
  active: { type: Boolean, default: true }
}, options);
productSchema.index({ company: 1, name: 1 });

const clientSchema = new Schema({
  name: { type: String, required: true, trim: true },
  businessName: { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  gstin: { type: String, trim: true, uppercase: true, default: '' },
  billingAddress: { type: String, trim: true, default: '' },
  shippingAddress: { type: String, trim: true, default: '' },
  notes: { type: String, default: '' },
  active: { type: Boolean, default: true }
}, options);
clientSchema.index({ name: 1, phone: 1 });

const estimateItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', default: null },
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  companyName: { type: String, required: true },
  productName: { type: String, required: true },
  sku: { type: String, default: '' },
  unit: { type: String, default: 'pcs' },
  quantity: { type: Number, required: true, min: 0.001 },
  unitPrice: { type: Number, required: true, min: 0 },
  discountPercent: { type: Number, min: 0, max: 100, default: 0 },
  taxRate: { type: Number, min: 0, max: 100, default: 0 },
  taxableAmount: { type: Number, required: true },
  taxAmount: { type: Number, required: true },
  lineTotal: { type: Number, required: true }
}, { _id: true });

const estimateSchema = new Schema({
  estimateNumber: { type: String, unique: true, index: true },
  clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
  clientSnapshot: { type: Schema.Types.Mixed, required: true },
  items: { type: [estimateItemSchema], validate: v => v.length > 0 },
  subtotal: { type: Number, required: true },
  discountTotal: { type: Number, default: 0 },
  taxTotal: { type: Number, default: 0 },
  additionalCharges: { type: Number, min: 0, default: 0 },
  grandTotal: { type: Number, required: true },
  notes: { type: String, default: '' },
  terms: { type: String, default: '' },
  bankDetails: { type: Schema.Types.Mixed, default: {} },
  validUntil: { type: Date, default: null },
  status: { type: String, enum: ['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired', 'Converted'], default: 'Draft', index: true },
  revision: { type: Number, default: 1 },
  convertedOrderId: { type: Schema.Types.ObjectId, ref: 'MasterOrder', default: null }
}, options);

const companyOrderItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', default: null },
  productName: { type: String, required: true },
  sku: { type: String, default: '' },
  unit: { type: String, default: 'pcs' },
  quantity: { type: Number, required: true },
  unitPrice: { type: Number, required: true },
  discountPercent: { type: Number, default: 0 },
  taxRate: { type: Number, default: 0 },
  taxableAmount: { type: Number, required: true },
  taxAmount: { type: Number, required: true },
  lineTotal: { type: Number, required: true }
}, { _id: true });

const companyOrderSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: 'Company', required: true },
  companyName: { type: String, required: true },
  companyOrderNumber: { type: String, required: true },
  companySnapshot: { type: Schema.Types.Mixed, default: {} },
  items: { type: [companyOrderItemSchema], required: true },
  subtotal: { type: Number, default: 0 },
  taxTotal: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  status: { type: String, enum: ['Pending', 'Sent', 'Confirmed', 'Rejected', 'Partially Dispatched', 'Dispatched', 'Delivered', 'Cancelled'], default: 'Pending' },
  sentAt: { type: Date, default: null },
  confirmedAt: { type: Date, default: null },
  notes: { type: String, default: '' }
}, { _id: true });

const masterOrderSchema = new Schema({
  orderNumber: { type: String, unique: true, index: true },
  estimateId: { type: Schema.Types.ObjectId, ref: 'Estimate', required: true, unique: true },
  clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
  clientSnapshot: { type: Schema.Types.Mixed, required: true },
  companyOrders: { type: [companyOrderSchema], required: true },
  subtotal: { type: Number, default: 0 },
  discountTotal: { type: Number, default: 0 },
  taxTotal: { type: Number, default: 0 },
  additionalCharges: { type: Number, default: 0 },
  grandTotal: { type: Number, required: true },
  status: { type: String, enum: ['Booked', 'Processing', 'Partially Completed', 'Completed', 'Cancelled'], default: 'Booked', index: true },
  notes: { type: String, default: '' }
}, options);

const paymentSchema = new Schema({
  masterOrderId: { type: Schema.Types.ObjectId, ref: 'MasterOrder', required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  paymentDate: { type: Date, default: Date.now },
  paymentMode: { type: String, enum: ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Card', 'Other'], default: 'UPI' },
  reference: { type: String, trim: true, default: '' },
  notes: { type: String, default: '' }
}, options);


const appSettingsSchema = new Schema({
  key: { type: String, unique: true, default: 'owner' },
  bankAccountHolder: { type: String, trim: true, default: '' },
  bankName: { type: String, trim: true, default: '' },
  accountNumber: { type: String, trim: true, default: '' },
  ifscCode: { type: String, trim: true, uppercase: true, default: '' },
  branch: { type: String, trim: true, default: '' },
  upiId: { type: String, trim: true, default: '' },
  paymentInstructions: { type: String, trim: true, default: '' }
}, options);

const counterSchema = new Schema({ key: { type: String, unique: true }, value: { type: Number, default: 0 } });
const auditSchema = new Schema({ action: String, recordType: String, recordId: String, details: Schema.Types.Mixed }, options);

export const Company = model('Company', companySchema);
export const Product = model('Product', productSchema);
export const Client = model('Client', clientSchema);
export const Estimate = model('Estimate', estimateSchema);
export const MasterOrder = model('MasterOrder', masterOrderSchema);
export const Payment = model('Payment', paymentSchema);
export const AppSettings = model('AppSettings', appSettingsSchema);
export const Counter = model('Counter', counterSchema);
export const AuditLog = model('AuditLog', auditSchema);
