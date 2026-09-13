// Retire the old public test route. Use an approved draft in the Command Center.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({ error: 'Use the signed-in Command Center to publish an approved draft.' });
}
