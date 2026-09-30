import { wixBlogCommentsEndpoint } from '../../lib/wix-blog.js';

export default async function handler(req, res) {
  return wixBlogCommentsEndpoint(req, res);
}
