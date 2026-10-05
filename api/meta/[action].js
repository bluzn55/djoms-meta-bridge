import { sessionEndpoint, passwordEndpoint } from '../../lib/core.js';
import { analyticsEndpoint } from '../../lib/records.js';
import { localStatusEndpoint, localGoogleConnectEndpoint, localGoogleCallbackEndpoint, localGoogleSelectEndpoint, localGoogleReplyEndpoint } from '../../lib/local.js';
import { wixBlogCommentsEndpoint } from '../../lib/wix-blog.js';

export default async function handler(req, res) {
  const action = req.query?.action;
  if (action === 'session') return sessionEndpoint(req, res);
  if (action === 'password') return passwordEndpoint(req, res);
  if (action === 'analytics') return analyticsEndpoint(req, res);
  if (action === 'local-status') return localStatusEndpoint(req, res);
  if (action === 'local-google-connect') return localGoogleConnectEndpoint(req, res);
  if (action === 'local-google-callback') return localGoogleCallbackEndpoint(req, res);
  if (action === 'local-google-select') return localGoogleSelectEndpoint(req, res);
  if (action === 'local-google-reply') return localGoogleReplyEndpoint(req, res);
  if (action === 'wix-blog-comments') return wixBlogCommentsEndpoint(req, res);
  if (action === 'website-interests') {
    const { websiteInterestsEndpoint } = await import('../../lib/website-interests.js');
    return websiteInterestsEndpoint(req, res);
  }
  if (action === 'radio-report') {
    const { radioReportEndpoint } = await import('../../lib/radio-report.js');
    return radioReportEndpoint(req, res);
  }
  if (action === 'chapter-clicks') {
    const { chapterClicksEndpoint } = await import('../../lib/chapter-clicks.js');
    return chapterClicksEndpoint(req, res);
  }
  return res.status(404).json({ error: 'Not found.' });
}
