import { communityPublicEndpoint, communityModerationEndpoint } from '../../lib/community.js';
const routes={public:communityPublicEndpoint,moderation:communityModerationEndpoint};
export default async function handler(req,res){
  const action=String(req.query?.action||'');
  const route=routes[action];
  if(!route) return res.status(404).json({success:false,error:'Community route not found.'});
  return route(req,res);
}
