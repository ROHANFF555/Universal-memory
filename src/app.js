import express from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Problem } from './store.js';

const text = (max) => z.string().trim().min(1).max(max).refine(v => !v.includes('\0'), 'NUL is not allowed');
const data = {content: text(8000), category: text(100)};
const id = {memory_id: z.uuid()};
const rev = {version: z.number().int().min(1).max(2147483646)};
const page = {category: data.category.optional(), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(100000).default(0)};
const search = {...page, q: text(500)};
const update = {...id, ...rev, ...data};
const remove = {...id, ...rev};
const hash = (v) => createHash('sha256').update(v).digest();
const matches = (v, secret) => Boolean(secret && timingSafeEqual(hash(v), hash(secret)));
const parse = (shape, value) => z.strictObject(shape).parse(value);

export function createApp(mem, {arenaToken, mcpTokens = {}, publicUrl, issuer, verifyOAuth}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const json = express.json({limit: '64kb'});
  const bearer = req => req.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? '';
  const arena = (req, res, next) => {
    if (!matches(bearer(req), arenaToken)) return res.set('WWW-Authenticate', 'Bearer').status(401).json({error:'Unauthorized'});
    next();
  };
  const base = '/v1/memories';
  app.use(base, arena);
  app.post(base, json, async (req,res) => res.status(201).json(await mem.save(parse(data,req.body),'Arena')));
  app.get(base, async (req,res) => {
    const numeric = z.string().regex(/^\d+$/).transform(Number).optional();
    const {limit, offset, ...filters} = parse({...page,q:search.q.optional(),limit:numeric,offset:numeric},req.query);
    res.json(await mem.list(parse({...page,q:search.q.optional()}, {...filters,limit,offset})));
  });
  app.get(`${base}/:memory_id`, async (req,res) => res.json(await mem.get(parse(id,req.params))));
  app.put(`${base}/:memory_id`, json, async (req,res) => {
    const body = parse({...rev,...data},req.body);
    res.json(await mem.change({...body,...parse(id,req.params)}));
  });
  app.delete(`${base}/:memory_id`, json, async (req,res) => {
    await mem.change({...parse(rev,req.body),...parse(id,req.params)},true);
    res.sendStatus(204);
  });

  for (const source of ['ChatGPT','Claude']) {
    const path = `/mcp/${source.toLowerCase()}`;
    const metadataPath = `/.well-known/oauth-protected-resource${path}`;
    const resource = publicUrl && `${publicUrl}${path}`;
    if (issuer && resource) app.get(metadataPath, (_req,res) => res.json({resource, authorization_servers:[issuer], scopes_supported:['memory:access'], bearer_methods_supported:['header']}));
    app.all(path, async (req,res,next) => {
      if (req.get('origin') && (!publicUrl || req.get('origin') !== publicUrl)) return res.status(403).json({error:'Origin not allowed'});
      const token = bearer(req);
      if (!matches(token,mcpTokens[source]) && !(token && verifyOAuth && await verifyOAuth(token,resource))) {
        const challenge = issuer && resource ? `Bearer resource_metadata="${publicUrl}${metadataPath}", scope="memory:access"` : 'Bearer';
        return res.set('WWW-Authenticate',challenge).status(401).json({error:'Unauthorized'});
      }
      if (req.method !== 'POST') return res.set('Allow','POST').status(405).end();
      next();
    }, json, async (req,res) => {
      const server = new McpServer({name:'universal-memory',version:'1.0.0'});
      const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      const tools = [
        ['save_memory','Save a new memory',data,v => mem.save(v,source)],
        ['search_memory','Search memory content by literal substring',search,v => mem.list(v)],
        ['get_memory','Read one memory by ID',id,v => mem.get(v)],
        ['update_memory','Replace content and category using the current version',update,v => mem.change(v)],
        ['delete_memory','Soft-delete a memory using the current version',remove,v => mem.change(v,true)],
        ['list_memories','List active memories with pagination',page,v => mem.list(v)]
      ];
      for (const [name,description,shape,fn] of tools) server.registerTool(name,{description,inputSchema:z.strictObject(shape)},async v => {
        try { return {content:[{type:'text',text:JSON.stringify(await fn(v))}]}; }
        catch (e) { return {isError:true,content:[{type:'text',text:e instanceof Problem ? e.message : 'Internal server error'}]}; }
      });
      res.on('close',() => { void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req,res,req.body);
    });
  }
  app.use((err,_req,res,next) => {
    if (res.headersSent) return next(err);
    if (err instanceof z.ZodError) return res.status(400).json({error:'Invalid input',issues:err.issues.map(({path,message}) => ({path,message}))});
    if (err instanceof Problem) return res.status(err.status).json({error:err.message});
    if (err.status === 413) return res.status(413).json({error:'Request body too large'});
    if (err.status === 400) return res.status(400).json({error:'Invalid request'});
    res.status(500).json({error:'Internal server error'});
  });
  return app;
}
