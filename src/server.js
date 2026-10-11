import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import estimateRoutes from './routes/estimates.js';
import orderRoutes from './routes/orders.js';
import dashboardRoutes from './routes/dashboard.js';
import settingsRoutes from './routes/settings.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
const allowedOrigins = [process.env.FRONTEND_URL, ...(process.env.CORS_ORIGINS || '').split(',')].filter(Boolean).map(x => x.trim().replace(/\/$/, ''));
app.use(cors({ origin(origin, callback) {
  if (!origin || allowedOrigins.includes(origin.replace(/\/$/, '')) || (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost(:\d+)?$/.test(origin))) return callback(null, true);
  return callback(new Error('Origin not allowed by CORS.'));
}, credentials: false }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'multi-company-sales-api', timestamp: new Date().toISOString() }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }), authRoutes);
app.use('/api', requireAuth);
app.use('/api', catalogRoutes);
app.use('/api/estimates', estimateRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use((req, res) => res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` }));
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.name === 'ValidationError') return res.status(400).json({ message: err.message });
  if (err.name === 'CastError') return res.status(400).json({ message: 'Invalid record ID.' });
  if (err.code === 11000) return res.status(409).json({ message: 'A record with this unique value already exists.' });
  res.status(err.status || 500).json({ message: err.message || 'Internal server error.' });
});
const port = Number(process.env.PORT || 10000);
try {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected.');
  app.listen(port, () => console.log(`API listening on port ${port}`));
} catch (error) {
  console.error('Startup failed:', error.message);
  process.exit(1);
}
