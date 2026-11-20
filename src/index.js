import { Pool } from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createApp } from './app.js';
import { store } from './store.js';

const env = process.env;
function token(name, required = false) {
  const value = env[name];
  if (!value && !required) return undefined;
  if (!value || value.length < 32 || /\s/.test(value)) throw new Error(`${name} must be a random token of at least 32 characters`);
  return value;
}
function https(name, originOnly = false) {
  const value = env[name];
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (originOnly && url.origin !== value)) throw new Error(`Invalid HTTPS URL for ${name}`);
  return url;
}
const arenaToken = token('ARENA_TOKEN', true);
const mcpTokens = {ChatGPT:token('CHATGPT_MCP_TOKEN'), Claude:token('CLAUDE_MCP_TOKEN')};
const tokens = [arenaToken,...Object.values(mcpTokens).filter(Boolean)];
if (new Set(tokens).size !== tokens.length) throw new Error('Platform tokens must be distinct');
const publicUrl = env.PUBLIC_URL && https('PUBLIC_URL',true).origin;
const issuer = env.OAUTH_ISSUER;
let verifyOAuth;
if (issuer || env.OAUTH_JWKS_URL || env.OAUTH_SUBJECT) {
  if (!publicUrl || !env.OAUTH_SUBJECT) throw new Error('OAuth requires PUBLIC_URL and OAUTH_SUBJECT');
  https('OAUTH_ISSUER');
  const keys = createRemoteJWKSet(https('OAUTH_JWKS_URL'));
  verifyOAuth = async (token, resource) => {
    try {
      const {payload} = await jwtVerify(token, keys, {issuer, audience:resource, subject:env.OAUTH_SUBJECT,
        algorithms:['RS256','ES256'], requiredClaims:['exp','scope']});
      return typeof payload.scope === 'string' && payload.scope.split(' ').includes('memory:access');
    } catch { return false; }
  };
}
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const dbUrl = new URL(env.DATABASE_URL);
if ([...dbUrl.searchParams.keys()].some(k => /^(ssl|uselibpqcompat)/i.test(k))) throw new Error('Remove SSL parameters from DATABASE_URL; TLS is configured by the server');
const db = new Pool({connectionString:env.DATABASE_URL, ssl:{rejectUnauthorized:true, ...(env.DATABASE_CA_PEM && {ca:env.DATABASE_CA_PEM})}, connectionTimeoutMillis:5000, statement_timeout:10000});
db.on('error', () => console.error('Idle database connection failed'));
const port = Number(env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
createApp(store(db),{arenaToken,mcpTokens,publicUrl,issuer,verifyOAuth}).listen(port,'0.0.0.0',() => console.log(`Memory server listening on port ${port}`));
