export default function handler(req, res) {
  res.setHeader("Content-Type", "text/html");

  res.status(200).send(`
    <!doctype html>
    <html>
      <head>
        <title>DJOMS Facebook Test</title>
      </head>
      <body style="font-family:Arial;padding:40px;">
        <h1>DJOMS Facebook Test</h1>

        <button
          style="font-size:22px;padding:15px 25px;"
          onclick="publishTest()">
          Publish Test Post
        </button>

        <pre id="result" style="margin-top:25px;"></pre>

        <script>
          async function publishTest() {
            const result = document.getElementById("result");
            result.textContent = "Publishing...";

            const response = await fetch("/api/meta/publish", {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                message: "DJOMS Social Command Facebook connection test."
              })
            });

            const data = await response.json();
            result.textContent = JSON.stringify(data, null, 2);
          }
        </script>
      </body>
    </html>
  `);
}
