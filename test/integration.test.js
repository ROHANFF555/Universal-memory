import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { store } from '../src/store.js';

const db = new PGlite();
const arenaToken = 'test-arena', mcpTokens = {Claude:'test-claude',ChatGPT:'test-chatgpt'};
let server, base;
before(async () => {
  await db.exec(await readFile(new URL('../db/001_memory.sql',import.meta.url),'utf8'));
  server = await new Promise(resolve => { const s = createApp(store(db),{arenaToken,mcpTokens}).listen(0,'127.0.0.1',()=>resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise(resolve=>server.close(resolve)); await db.close(); });
const rest = (suffix = '', method = 'GET', body, token = arenaToken) => fetch(`${base}/v1/memories${suffix}`, {method, headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
async function client(source) {
  const c = new Client({name:'integration-test',version:'1.0.0'});
  await c.connect(new StreamableHTTPClientTransport(new URL(`/mcp/${source.toLowerCase()}`,base), {requestInit:{headers:{authorization:`Bearer ${mcpTokens[source]}`}}}));
  return c;
}
async function call(c,name,args) {
  const r = await c.callTool({name,arguments:args});
  assert.notEqual(r.isError,true,r.content[0]?.text);
  return JSON.parse(r.content[0].text);
}

test('REST and both MCP endpoints share one versioned PostgreSQL store', async t => {
  const body = {content:'A shared fact 100%',category:'notes'};
  const saved = await rest('', 'POST', body);
  assert.equal(saved.status,201);
  const memory = await saved.json();
  const {memory_id} = memory;
  assert.equal(memory.source,'Arena');
  assert.equal(memory.version,1);
  assert.equal((await db.query('select content from universal_memory.memories where memory_id=$1',[memory_id])).rows[0].content,body.content);
  const claude = await client('Claude');
  t.after(()=>claude.close());
  const chatgpt = await client('ChatGPT');
  t.after(()=>chatgpt.close());
  assert.equal((await claude.listTools()).tools.length,6);
  for (const c of [claude,chatgpt]) assert.deepEqual(await call(c,'get_memory',{memory_id}),memory);
  assert.deepEqual(await call(chatgpt,'search_memory',{q:'100%'}),[memory]);
  assert.deepEqual(await call(claude,'list_memories',{}),[memory]);
  assert.deepEqual(await (await rest('?q=100%25&limit=1')).json(),[memory]);
  const attempts = await Promise.all([rest('','POST',body),rest('','POST',body)]);
  assert.deepEqual(attempts.map(r=>r.status),[409,409]);
  const updated = await call(claude,'update_memory',{memory_id,version:1,...body,content:'Revised fact'});
  assert.equal(updated.version,2);
  assert.deepEqual(await (await rest(`/${memory_id}`)).json(),updated);
  assert.equal((await rest(`/${memory_id}`,'PUT',{version:1,...body})).status,409);
  await call(chatgpt,'delete_memory',{memory_id,version:2});
  assert.equal((await rest(`/${memory_id}`)).status,404);
  assert.deepEqual((await db.query('select version from universal_memory.history where memory_id=$1 order by version',[memory_id])).rows.map(r=>r.version),[1,2,3]);
  const persisted = await call(claude,'save_memory',body);
  assert.equal(persisted.source,'Claude');
  assert.equal((await rest(`/${persisted.memory_id}`,'DELETE',{version:1})).status,204);
});

test('requests fail closed without credentials or with invalid inputs',async () => {
  assert.equal((await rest('','GET',undefined,mcpTokens.Claude)).status,401);
  assert.equal((await fetch(`${base}/mcp/claude`,{headers:{authorization:`Bearer ${arenaToken}`}})).status,401);
  assert.equal((await fetch(`${base}/mcp/claude`,{headers:{origin:'https://untrusted.example',authorization:`Bearer ${mcpTokens.Claude}`}})).status,403);
  assert.equal((await rest('','POST',{content:'test',category:'x',source:'Claude'})).status,400);
  assert.equal((await rest('?limit=101')).status,400);
  assert.equal((await rest('/not-a-uuid')).status,400);
});
