export default async function handler(req, res) {
  const appId = !!process.env.META_APP_ID;
  const secret = !!process.env.META_APP_SECRET;
  const pageId = process.env.META_PAGE_ID || "";
  const pageToken = process.env.META_PAGE_ACCESS_TOKEN || "";

  return res.status(200).json({
    appId,
    secret,
    connected: !!(pageId && pageToken),
    pageName: process.env.META_PAGE_NAME || null
  });
}
