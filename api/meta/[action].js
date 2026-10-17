import { sessionEndpoint, passwordEndpoint } from '../../lib/core.js';
import { rotationEndpoint } from '../../lib/records.js';
import { localStatusEndpoint, localGoogleConnectEndpoint, localGoogleCallbackEndpoint, localGoogleSelectEndpoint, localGoogleReplyEndpoint } from '../../lib/local.js';
import { wixBlogCommentsEndpoint, wixWebsiteRangeEndpoint } from '../../lib/wix-blog.js';

export default async function handler(req, res) {
  const action = req.query?.action;
  if (action === 'session') return sessionEndpoint(req, res);
  if (action === 'password') return passwordEndpoint(req, res);
  if (action === 'analytics') {
    const { verifiedAnalyticsEndpoint } = await import('../../lib/verified-analytics.js');
    return verifiedAnalyticsEndpoint(req, res);
  }
  if (action === 'report') {
    const { ownerReportEndpoint } = await import('../../lib/owner-report.js');
    return ownerReportEndpoint(req, res);
  }
  if (action === 'youtube-report-connect') {
    const { youtubeReportingConnectEndpoint } = await import('../../lib/owner-report.js');
    return youtubeReportingConnectEndpoint(req, res);
  }
  if (action === 'rotation') return rotationEndpoint(req, res);
  if (action === 'local-status') return localStatusEndpoint(req, res);
  if (action === 'website-range') return wixWebsiteRangeEndpoint(req,res);
  if (action === 'seo-connect') {
    const { seoConnectEndpoint }=await import('../../lib/search-console.js');
    return seoConnectEndpoint(req,res);
  }
  if (action === 'seo-callback') {
    const { seoCallbackEndpoint }=await import('../../lib/search-console.js');
    return seoCallbackEndpoint(req,res);
  }
  if (action === 'seo-status') {
    const { seoStatusEndpoint }=await import('../../lib/search-console.js');
    return seoStatusEndpoint(req,res);
  }
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
  if (action === 'trading-post-sales') {
    const { tradingPostSalesEndpoint } = await import('../../lib/trading-post-sales.js');
    return tradingPostSalesEndpoint(req, res);
  }
  return res.status(404).json({ error: 'Not found.' });
}
