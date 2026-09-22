import {
  xConnectEndpoint,
  xCallbackEndpoint,
  xStatusEndpoint,
  xPostEndpoint,
  xMentionsEndpoint,
  xMentionReplyEndpoint,
  xMentionHandledEndpoint
} from '../../lib/x.js';

const routes = {
  connect: xConnectEndpoint,
  callback: xCallbackEndpoint,
  status: xStatusEndpoint,
  post: xPostEndpoint,
  mentions: xMentionsEndpoint,
  'mention-reply': xMentionReplyEndpoint,
  'mention-handled': xMentionHandledEndpoint
};

export default async function handler(req, res) {
  const action = String(req.query?.action || '');
  const endpoint = routes[action];
  if (!endpoint) return res.status(404).json({ success: false, error: 'X route not found.' });
  return endpoint(req, res);
}
