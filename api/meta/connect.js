export default async function handler(req, res) {
  const appId = process.env.META_APP_ID;
  const base = process.env.PUBLIC_BASE_URL;

  if (!appId) {
    return res.status(500).send("META_APP_ID is not configured.");
  }

  if (!base) {
    return res.status(500).send("PUBLIC_BASE_URL is not configured.");
  }

  const redirect = encodeURIComponent(
    base.replace(/\/$/, "") + "/api/meta/callback"
  );

  const scope = encodeURIComponent(
    process.env.META_SCOPES ||
      "pages_show_list,pages_read_engagement,pages_manage_posts"
  );

  const url =
    "https://www.facebook.com/dialog/oauth" +
    "?client_id=" + encodeURIComponent(appId) +
    "&redirect_uri=" + redirect +
    "&scope=" + scope +
    "&response_type=code";

  return res.redirect(302, url);
}
