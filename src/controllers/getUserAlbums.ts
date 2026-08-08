import type { Context } from 'koa';
import services from '../services';
import { getTypedQuery } from '../types/core/request';
import { getAuthToken } from './login';

// src/controllers/getUserAlbums.ts

interface UserAlbumsQuery {
  offset?: string;
  limit?: string;
}

export default async (ctx: Context): Promise<void> => {
  const query = getTypedQuery<UserAlbumsQuery>(ctx);
  const offset = Math.max(0, Number.parseInt(query.offset ?? '0', 10) || 0);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '20', 10) || 20));
  const data = await services.getUserAlbums({ token: getAuthToken(ctx), offset, limit });
  if (!data) {
    ctx.status = 401;
    ctx.body = { code: 401, message: 'Login required' };
    return;
  }
  // The upstream field names stay behind this boundary: callers get the same
  // `{ code, <collection>, total, more }` envelope the sibling user routes answer with.
  const albums = Array.isArray(data.albumlist) ? data.albumlist : [];
  const total = typeof data.totalalbum === 'number' ? data.totalalbum : albums.length;
  ctx.status = 200;
  ctx.body = {
    code: 200,
    albums,
    total,
    more: Number(data.has_more) === 1 || offset + albums.length < total,
  };
};
