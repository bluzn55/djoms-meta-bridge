import { wixBlogCommentsEndpoint } from '../../lib/wix-blog.js';

export default async function handler(req,res) {
  const action = String(req.query?.action || '');
  if (action === 'blog-comments') return wixBlogCommentsEndpoint(req,res);
  return res.status(404).json({ success:false, error:'Wix route not found.' });
}
