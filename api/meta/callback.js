export default async function handler(req, res) {
  const { code, error } = req.query || {};

  if (error) {
    return res.status(400).send("Meta authorization failed: " + error);
  }

  if (!code) {
    return res.status(400).send("Missing Meta authorization code.");
  }

  const appId = process.env.META_APP_ID;
  const secret = process.env.META_APP_SECRET;
  const base = process.env.PUBLIC_BASE_URL;

  if (!appId || !secret || !base) {
    return res.status(500).send("Meta backend environment variables are incomplete.");
  }

  const redirect = base.replace(/\/$/, "") + "/api/meta/callback";

  try {
    const tokenUrl =
      "https://graph.facebook.com/oauth/access_token" +
      "?client_id=" + encodeURIComponent(appId) +
      "&client_secret=" + encodeURIComponent(secret) +
      "&redirect_uri=" + encodeURIComponent(redirect) +
      "&code=" + encodeURIComponent(code);

    const tokenResponse = await fetch(tokenUrl);
    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(400).json(tokenData);
    }

    const pagesUrl =
      "https://graph.facebook.com/me/accounts" +
      "?fields=id,name,access_token" +
      "&access_token=" + encodeURIComponent(tokenData.access_token);

    const pagesResponse = await fetch(pagesUrl);
    const pagesData = await pagesResponse.json();

    if (!pagesResponse.ok) {
      return res.status(400).json(pagesData);
    }

    const wantedPageId = process.env.META_PAGE_ID;

    const page = (pagesData.data || []).find(
      (item) => String(item.id) === String(wantedPageId)
    );

    if (!page) {
      return res.status(404).send("Doc Jaks Facebook Page was not found.");
    }

    return res.status(200).json({
      success: true,
      pageId: page.id,
      pageName: page.name,
      message: "Doc Jaks Facebook authorization completed successfully."
    });
  } catch (e) {
    return res.status(500).send("Meta callback error: " + e.message);
  }
}
