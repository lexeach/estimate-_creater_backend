import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { asyncHandler } from '../utils/helpers.js';
const router = Router();

router.post('/login', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const ownerEmail = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const ownerPassword = String(process.env.OWNER_PASSWORD || '');
  if (!ownerEmail || !ownerPassword || !process.env.JWT_SECRET) return res.status(500).json({ message: 'Owner login is not configured on the server.' });
  const emailMatches = email === ownerEmail;
  // OWNER_PASSWORD is stored as a Render secret; bcrypt hashes may be used by setting OWNER_PASSWORD_HASH instead.
  const passwordMatches = process.env.OWNER_PASSWORD_HASH
    ? await bcrypt.compare(password, process.env.OWNER_PASSWORD_HASH)
    : password === ownerPassword;
  if (!emailMatches || !passwordMatches) return res.status(401).json({ message: 'Invalid email or password.' });
  const token = jwt.sign({ sub: ownerEmail, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { email: ownerEmail, role: 'owner' }, expiresIn: 43200 });
}));
router.get('/me', (req, res) => res.json({ user: { email: process.env.OWNER_EMAIL || '', role: 'owner' } }));
export default router;
