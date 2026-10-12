import nodemailer from 'nodemailer';
import { AppSettings } from '../models/index.js';

let cachedTransporter = null;
function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) return null;
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
  }
  return cachedTransporter;
}
const inr = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
function emailHtml({ heading, intro, rows = [], footer = '' }) {
  return `<div style="font-family:Arial,sans-serif;color:#183c34;max-width:640px;margin:auto;border:1px solid #dbe5e0;border-radius:12px;overflow:hidden"><div style="background:#173f36;color:#fff;padding:22px 26px;font-size:20px;font-weight:bold">SalesDesk · ${esc(heading)}</div><div style="padding:24px"><p>${esc(intro)}</p><table style="width:100%;border-collapse:collapse">${rows.map(([k,v])=>`<tr><td style="padding:10px;border-bottom:1px solid #dbe5e0;color:#5b6f68">${esc(k)}</td><td style="padding:10px;border-bottom:1px solid #dbe5e0;text-align:right;font-weight:bold">${esc(v)}</td></tr>`).join('')}</table>${footer ? `<p style="margin-top:22px;color:#64756e;font-size:12px">${esc(footer)}</p>` : ''}</div></div>`;
}

// Called only after a new captured payment has been saved. Email failures never roll back a verified payment.
export async function notifySuccessfulPayment({ estimate, order, payment, paidTotal, balanceDue }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn('Payment saved, but email notifications are not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM.');
    return { sent: 0, skipped: true };
  }
  const settings = await AppSettings.findOne({ key: 'owner' }).lean().catch(() => null);
  const from = process.env.SMTP_FROM || settings?.businessEmail || process.env.OWNER_EMAIL || process.env.SMTP_USER;
  const estimateNumber = estimate?.estimateNumber || String(order?.estimateId || '');
  const orderNumber = order?.orderNumber || 'Pending';
  const paymentDate = new Date(payment.paymentDate || Date.now()).toLocaleString('en-IN', { timeZone: process.env.EMAIL_TIMEZONE || 'Asia/Kolkata' });
  const commonRows = [
    ['Estimate', estimateNumber], ['Order', orderNumber], ['Payment received', inr(payment.amount)],
    ['Payment reference', payment.razorpayPaymentId || payment.reference || ''], ['Payment date', paymentDate],
    ['Total order value', inr(order?.grandTotal)], ['Total paid to date', inr(paidTotal)], ['Balance due', inr(balanceDue)],
    ['Payment status', order?.paymentStatus || 'Paid']
  ];
  const tasks = [];
  const clientEmail = estimate?.clientSnapshot?.email || order?.clientSnapshot?.email;
  const clientName = estimate?.clientSnapshot?.name || order?.clientSnapshot?.name || 'Customer';
  if (clientEmail) tasks.push(transporter.sendMail({ from, to: clientEmail, subject: `Payment received — ${estimateNumber}`, html: emailHtml({ heading: 'Payment receipt', intro: `Hello ${clientName}, your online payment has been verified successfully. Thank you.`, rows: commonRows, footer: 'This is an automated payment confirmation. Please retain it for your records.' }) }));

  const ownerEmail = settings?.businessEmail || process.env.OWNER_EMAIL;
  if (ownerEmail) tasks.push(transporter.sendMail({ from, to: ownerEmail, subject: `Payment received: ${inr(payment.amount)} — ${orderNumber}`, html: emailHtml({ heading: 'Payment notification', intro: `A client payment has been verified and recorded in SalesDesk. Client: ${clientName}.`, rows: [...commonRows, ['Client email', clientEmail || 'Not provided']] }) }));

  for (const companyOrder of (order?.companyOrders || [])) {
    const to = companyOrder.companySnapshot?.email;
    if (!to) continue;
    const companyRows = [
      ['Client', clientName], ['Estimate', estimateNumber], ['Master order', orderNumber],
      ['Your company order', companyOrder.companyOrderNumber], ['Your order value', inr(companyOrder.total)],
      ['Client payment status', order?.paymentStatus || 'Paid'], ['Supplier order status', companyOrder.status || 'Pending']
    ];
    tasks.push(transporter.sendMail({ from, to, subject: `Client payment confirmed — ${companyOrder.companyOrderNumber}`, html: emailHtml({ heading: 'Client payment confirmed', intro: `A client payment has been verified for an order containing products supplied by ${companyOrder.companyName}. Please review your company order in the usual workflow.`, rows: companyRows, footer: 'This notification confirms payment receipt for the overall client order; it is not a remittance advice to the supplier.' }) }));
  }
  const results = await Promise.allSettled(tasks);
  const sent = results.filter(r => r.status === 'fulfilled').length;
  results.forEach((result, i) => { if (result.status === 'rejected') console.error('Payment notification email failed:', result.reason?.message || result.reason); });
  console.log(`Payment email notifications: ${sent}/${tasks.length} sent for ${payment.razorpayPaymentId || payment._id}.`);
  return { sent, failed: tasks.length - sent };
}
