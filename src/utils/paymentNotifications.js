import { AppSettings } from '../models/index.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendEmail({ from, to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
        signal: AbortSignal.timeout(20000)
      });
      const responseText = await response.text();
      let data = {};
      try { data = responseText ? JSON.parse(responseText) : {}; } catch {}
      if (!response.ok) {
        const detail = data.message || data.name || responseText || `HTTP ${response.status}`;
        const error = new Error(`Resend API ${response.status}: ${detail}`);
        // Retry transient server/rate-limit errors; don't retry invalid requests or credentials.
        if (response.status < 500 && response.status !== 429) throw error;
        lastError = error;
      } else {
        return data;
      }
    } catch (error) {
      lastError = error;
      if (/Resend API 4\d\d:/.test(error.message) && !/Resend API 429:/.test(error.message)) throw error;
    }
    if (attempt < 3) await wait(500 * (2 ** (attempt - 1)));
  }
  throw lastError || new Error('Resend email request failed after retries');
}
const inr = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
function emailHtml({ heading, intro, rows = [], footer = '' }) {
  return `<div style="font-family:Arial,sans-serif;color:#183c34;max-width:640px;margin:auto;border:1px solid #dbe5e0;border-radius:12px;overflow:hidden"><div style="background:#173f36;color:#fff;padding:22px 26px;font-size:20px;font-weight:bold">SalesDesk · ${esc(heading)}</div><div style="padding:24px"><p>${esc(intro)}</p><table style="width:100%;border-collapse:collapse">${rows.map(([k,v])=>`<tr><td style="padding:10px;border-bottom:1px solid #dbe5e0;color:#5b6f68">${esc(k)}</td><td style="padding:10px;border-bottom:1px solid #dbe5e0;text-align:right;font-weight:bold">${esc(v)}</td></tr>`).join('')}</table>${footer ? `<p style="margin-top:22px;color:#64756e;font-size:12px">${esc(footer)}</p>` : ''}</div></div>`;
}

// Called only after a new captured payment has been saved. Email failures never roll back a verified payment.
export async function notifySuccessfulPayment({ estimate, order, payment, paidTotal, balanceDue }) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    console.warn('Payment saved, but email notifications are not configured. Set RESEND_API_KEY and EMAIL_FROM on Render.');
    return { sent: 0, skipped: true };
  }
  const settings = await AppSettings.findOne({ key: 'owner' }).lean().catch(() => null);
  const from = process.env.EMAIL_FROM;
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
  if (clientEmail) tasks.push(sendEmail({ from, to: clientEmail, subject: `Payment received — ${estimateNumber}`, html: emailHtml({ heading: 'Payment receipt', intro: `Hello ${clientName}, your online payment has been verified successfully. Thank you.`, rows: commonRows, footer: 'This is an automated payment confirmation. Please retain it for your records.' }) }));

  const ownerEmail = settings?.businessEmail || process.env.OWNER_EMAIL;
  if (ownerEmail) tasks.push(sendEmail({ from, to: ownerEmail, subject: `Payment received: ${inr(payment.amount)} — ${orderNumber}`, html: emailHtml({ heading: 'Payment notification', intro: `A client payment has been verified and recorded in SalesDesk. Client: ${clientName}.`, rows: [...commonRows, ['Client email', clientEmail || 'Not provided']] }) }));

  for (const companyOrder of (order?.companyOrders || [])) {
    const to = companyOrder.companySnapshot?.email;
    if (!to) continue;
    const companyRows = [
      ['Client', clientName], ['Estimate', estimateNumber], ['Master order', orderNumber],
      ['Your company order', companyOrder.companyOrderNumber], ['Your order value', inr(companyOrder.total)],
      ['Client payment status', order?.paymentStatus || 'Paid'], ['Supplier order status', companyOrder.status || 'Pending']
    ];
    tasks.push(sendEmail({ from, to, subject: `Client payment confirmed — ${companyOrder.companyOrderNumber}`, html: emailHtml({ heading: 'Client payment confirmed', intro: `A client payment has been verified for an order containing products supplied by ${companyOrder.companyName}. Please review your company order in the usual workflow.`, rows: companyRows, footer: 'This notification confirms payment receipt for the overall client order; it is not a remittance advice to the supplier.' }) }));
  }
  const results = await Promise.allSettled(tasks);
  const sent = results.filter(r => r.status === 'fulfilled').length;
  results.forEach((result, i) => { if (result.status === 'rejected') console.error('Payment notification email failed:', result.reason?.message || result.reason); });
  console.log(`Payment email notifications: ${sent}/${tasks.length} sent for ${payment.razorpayPaymentId || payment._id}.`);
  return { sent, failed: tasks.length - sent };
}
