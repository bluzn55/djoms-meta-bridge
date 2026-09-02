export default async function handler(req, res) {
  // Allow DJOMS Social Command to call this API from the browser.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Browser CORS preflight request.
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST."
    });
  }

  const pageId = process.env.META_PAGE_ID;
  const pageToken = process.env.META_PAGE_ACCESS_TOKEN;

  if (!pageId || !pageToken) {
    return res.status(500).json({
      error: "Meta Page ID or Page Access Token is not configured."
    });
  }

  const { message, link } = req.body || {};

  if (!message && !link) {
    return res.status(400).json({
      error: "A message or link is required."
    });
  }

  try {
    const body = new URLSearchParams();

    if (message) body.append("message", message);
    if (link) body.append("link", link);

    body.append("access_token", pageToken);

    const response = await fetch(
      "https://graph.facebook.com/" +
        encodeURIComponent(pageId) +
        "/feed",
      {
        method: "POST",
        body
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json({
      success: true,
      postId: data.id
    });
  } catch (e) {
    return res.status(500).json({
      error: "Meta publish error: " + e.message
    });
  }
}
