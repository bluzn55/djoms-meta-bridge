import { AppError, PREFIX, authorize, endpoint, only, input, connection, checkConnection, graph, read, write, redis, now } from './core.js';

function clean(value, max, label) {
  if (typeof value !== 'string' || value.length > max) throw new AppError(label + ' is too long.');
  return value.trim();
}
async function handled(platform,id) {
  return await read('comment-handled:' + platform + ':' + id);
}
async function markHandled(platform,id,user,reason) {
  await write('comment-handled:' + platform + ':' + id, { handledAt:now(), handledBy:user, reason });
}
async function clearHandled(platform,id) {
  await redis('DEL', PREFIX + 'comment-handled:' + platform + ':' + id);
}
async function pagePosts(c) {
  const data = await graph(encodeURIComponent(c.pageId) + '/feed', c.pageToken, {
    fields:'id,message,permalink_url,created_time',
    limit:20
  });
  return data.data || [];
}
async function facebookComments(c) {
  const posts = await pagePosts(c);
  const out = [];
  for (const post of posts) {
    const data = await graph(encodeURIComponent(post.id) + '/comments', c.pageToken, {
      fields:'id,message,from,created_time,permalink_url,parent',
      order:'reverse_chronological',
      filter:'stream',
      limit:50
    });
    for (const x of data.data || []) {
      const h = await handled('facebook',x.id);
      out.push({
        platform:'facebook',
        id:x.id,
        parentId:x.id,
        postId:post.id,
        postTitle:(post.message || 'Facebook post').slice(0,120),
        author:x.from?.name || 'Facebook user',
        text:x.message || '',
        publishedAt:x.created_time || null,
        handled:!!h,
        handledAt:h?.handledAt || null,
        openUrl:x.permalink_url || post.permalink_url || 'https://www.facebook.com/'
      });
    }
  }
  return out;
}
async function instagramComments(c,status) {
  const igId=status.instagram?.id;
  if (!igId) return [];
  const media = await graph(encodeURIComponent(igId) + '/media', c.pageToken, {
    fields:'id,caption,permalink,timestamp',
    limit:20
  });
  const out=[];
  for (const post of media.data || []) {
    const data=await graph(encodeURIComponent(post.id) + '/comments', c.pageToken, {
      fields:'id,text,username,timestamp',
      limit:50
    });
    for (const x of data.data || []) {
      const h=await handled('instagram',x.id);
      out.push({
        platform:'instagram',
        id:x.id,
        parentId:x.id,
        postId:post.id,
        postTitle:(post.caption || 'Instagram post').slice(0,120),
        author:x.username ? '@'+x.username : 'Instagram user',
        text:x.text || '',
        publishedAt:x.timestamp || null,
        handled:!!h,
        handledAt:h?.handledAt || null,
        openUrl:post.permalink || 'https://www.instagram.com/'
      });
    }
  }
  return out;
}
export const commentsEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);
  const session=await authorize(req);
  const c=await connection();
  if(!c) throw new AppError('Connect Facebook first.');
  const status=await checkConnection(true);

  if(req.method==='GET'){
    const platforms=String(req.query?.platforms || 'facebook,instagram').split(',').filter(Boolean);
    const result={items:[],warnings:[],checkedAt:now()};
    if(platforms.includes('facebook')){
      try{
        if(!status.facebook?.connected) throw new AppError(status.facebook?.message || 'Facebook is not connected.');
        result.items.push(...await facebookComments(c));
      }catch(e){ result.warnings.push('Facebook: '+e.message); }
    }
    if(platforms.includes('instagram')){
      try{
        if(!status.instagram?.connected) throw new AppError(status.instagram?.message || 'Instagram is not connected.');
        result.items.push(...await instagramComments(c,status));
      }catch(e){ result.warnings.push('Instagram: '+e.message); }
    }
    result.items.sort((a,b)=>Date.parse(b.publishedAt||0)-Date.parse(a.publishedAt||0));
    return res.json(result);
  }

  const b=input(req);
  const platform=clean(b.platform||'',20,'Platform');
  const commentId=clean(b.commentId||'',200,'Comment ID');
  if(!['facebook','instagram'].includes(platform) || !commentId) throw new AppError('Choose a Facebook or Instagram comment.');

  if(b.action==='handled'){
    if(b.handled===false) await clearHandled(platform,commentId);
    else await markHandled(platform,commentId,session.name,'manual');
    return res.json({success:true});
  }

  if(b.action==='reply'){
    const message=clean(b.message||'',8000,'Reply');
    if(!message) throw new AppError('Write a reply first.');
    if(platform==='facebook'){
      await graph(encodeURIComponent(commentId) + '/comments', c.pageToken, {message}, 'POST', true);
    }else{
      await graph(encodeURIComponent(commentId) + '/replies', c.pageToken, {message}, 'POST', true);
    }
    await markHandled(platform,commentId,session.name,'replied');
    return res.json({success:true});
  }
  throw new AppError('That comment action is not supported.');
});
