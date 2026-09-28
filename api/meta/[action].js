import { sessionEndpoint, passwordEndpoint } from '../../lib/core.js';
import { analyticsEndpoint } from '../../lib/records.js';

export default async function handler(req, res) {
  const action = req.query?.action;
  if (action === 'session') return sessionEndpoint(req, res);
  if (action === 'password') return passwordEndpoint(req, res);
  if (action === 'analytics') return analyticsEndpoint(req, res);
  return res.status(404).json({ error: 'Not found.' });
}
