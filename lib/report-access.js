import { connection, env, now } from './core.js';
import { metaRead } from './verified-analytics.js';

// This reports permission names only. Access tokens and app secrets never leave the server.
export async function reportAccess() {
  try {
    const saved = await connection();
    if (!saved?.pageToken) return { checkedAt: now(), status: 'not_connected' };
    if (!env().META_APP_ID || !env().META_APP_SECRET) {
      return { checkedAt: now(), status: 'cannot_check', message: 'Meta app settings are not available for permission inspection.' };
    }
    const response = await metaRead('debug_token', env().META_APP_ID + '|' + env().META_APP_SECRET,
      { input_token: saved.pageToken });
    const data = response.data;
    if (!data || !Array.isArray(data.scopes)) {
      return { checkedAt: now(), status: 'cannot_check', message: 'Meta did not return the granted permission list.' };
    }
    const granted = data.scopes.filter(scope => typeof scope === 'string');
    const required = {
      facebook: ['pages_read_engagement', 'read_insights'],
      instagram: ['pages_read_engagement', 'instagram_basic', 'instagram_manage_insights']
    };
    return {
      checkedAt: now(), status: data.is_valid ? 'checked' : 'token_invalid',
      granted, missing: Object.fromEntries(Object.entries(required).map(([platform, scopes]) =>
        [platform, scopes.filter(scope => !granted.includes(scope))])),
      note: 'Permission names are necessary but not sufficient. App access level and per-account grants can still block individual metrics. Posting authorization is separate.'
    };
  } catch (error) {
    return { checkedAt: now(), status: 'cannot_check', message: error.message || 'Meta permission inspection was unavailable.' };
  }
}
