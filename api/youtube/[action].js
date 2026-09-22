import {
  youtubeConnectEndpoint,
  youtubeCallbackEndpoint,
  youtubeStatusEndpoint
} from '../../lib/youtube.js';

const routes = {
  connect: youtubeConnectEndpoint,
  callback: youtubeCallbackEndpoint,
  status: youtubeStatusEndpoint
};

export default async function handler(req, res) {
  const action = String(req.query?.action || '');
  const route = routes[action];
  if (!route) return res.status(404).json({ success:false, error:'YouTube route not found.' });
  return route(req, res);
}
