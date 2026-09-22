import {
  youtubeConnectEndpoint,
  youtubeCallbackEndpoint,
  youtubeStatusEndpoint,
  youtubeVideoListEndpoint,
  youtubeVideoInitEndpoint,
  youtubeVideoRegisterEndpoint,
  youtubeVideoSaveEndpoint,
  youtubeVideoDeleteEndpoint
} from '../../lib/youtube.js';

const routes = {
  connect: youtubeConnectEndpoint,
  callback: youtubeCallbackEndpoint,
  status: youtubeStatusEndpoint,
  'video-list': youtubeVideoListEndpoint,
  'video-init': youtubeVideoInitEndpoint,
  'video-register': youtubeVideoRegisterEndpoint,
  'video-save': youtubeVideoSaveEndpoint,
  'video-delete': youtubeVideoDeleteEndpoint
};

export default async function handler(req, res) {
  const action = String(req.query?.action || '');
  const route = routes[action];
  if (!route) return res.status(404).json({ success:false, error:'YouTube route not found.' });
  return route(req, res);
}
