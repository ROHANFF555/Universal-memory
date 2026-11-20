# Universal AI Shared Memory

One Node.js server, one Supabase PostgreSQL database, and one private shared memory collection. Arena uses REST; Claude and ChatGPT use separate Streamable HTTP MCP URLs on the same server. There is no Google Sheets integration.

## Setup

1. Create a Supabase project. Run [`db/001_memory.sql`](db/001_memory.sql) **once** in its SQL Editor. Keep `universal_memory` out of the Supabase Data API's exposed schemas.
2. Create a dedicated login role (for example, `memory_app`) with a strong password through PostgreSQL administration. Grant only the following privileges (adjust the role name if needed):

   ```sql
   grant usage on schema universal_memory to memory_app;
   grant select, insert, update on universal_memory.memories to memory_app;
   grant insert on universal_memory.history to memory_app;
   ```

   Use a direct or session pooler URI from Supabase's Connect panel, with the dedicated role's username/password (follow the panel's username format for pooler connections). URL-encode the password and omit SSL query options: the server requires TLS with certificate verification. Set `DATABASE_CA_PEM` if the endpoint needs an additional trusted CA. Do not use a Supabase anon/service key in place of this URI.
3. Install Node.js 22+, run `npm ci`, copy `.env.example` to `.env`, and set `DATABASE_URL` and `ARENA_TOKEN`. Generate a separate random token for each enabled static credential (e.g. `openssl rand -hex 32`). Put production secrets in the host's secret manager, not in Git or prompts. Start with `npm start`.
4. Deploy behind HTTPS. Set `PUBLIC_URL` to the public HTTPS origin, without a trailing slash. Enforce rate and connection limits at the reverse proxy and avoid logging authorization headers or request/response bodies. Only give access to clients trusted to read **and change the entire collection**; this is not a multi-tenant service. Avoid storing sensitive information you would not share with all connected clients.

## Arena REST

Every request takes `Authorization: Bearer <ARENA_TOKEN>`. Set `Content-Type: application/json` for requests with bodies. Example (set `BASE_URL` to the deployed origin and supply `ARENA_TOKEN` from your environment):

```sh
curl -fsS "$BASE_URL/v1/memories" \
  -H "Authorization: Bearer $ARENA_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"content":"Prefer a short weekly summary","category":"preferences"}'
```

| Method and path | Input |
| --- | --- |
| `POST /v1/memories` | `{content, category}`; returns `201` with the new record |
| `GET /v1/memories` | Optional `q` (case-insensitive literal content substring), `category`, `limit` (1–100, default 20), `offset` (default 0); returns an array |
| `GET /v1/memories/{memory_id}` | Returns the active record |
| `PUT /v1/memories/{memory_id}` | `{content, category, version}`; returns the replacement record |
| `DELETE /v1/memories/{memory_id}` | JSON `{version}`; returns `204` |

Read the current `version` before updating or deleting. A stale version or duplicate returns `409`; a missing or deleted memory returns `404`. Arena needs outbound access to the deployment; the current Arena sandbox may restrict arbitrary external hosts. If blocked, run the example from an allowed environment or arrange supported network access. Never paste the bearer token into chat.

## ChatGPT and Claude MCP

In a client/account that supports custom remote MCP and write tools, add the appropriate HTTPS URL: `$BASE_URL/mcp/chatgpt` or `$BASE_URL/mcp/claude`. Use **Streamable HTTP** (JSON responses, stateless; no standalone SSE stream). The endpoints offer `save_memory`, `search_memory`, `get_memory`, `update_memory`, `delete_memory`, and `list_memories`. Search takes `q` with the same pagination as REST; list takes only the pagination and category filters. Update and delete take `memory_id` and `version`, plus `content` and `category` for update. For SDK clients supporting custom headers, set `CHATGPT_MCP_TOKEN` or `CLAUDE_MCP_TOKEN` and send the matching bearer token; do not put tokens in URLs.

For hosted clients without custom header support, configure **external OAuth**. This server is a resource server, not an OAuth issuer. Set `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, and `OAUTH_SUBJECT` (the sole permitted account's `sub`). Use a provider compatible with both clients' OAuth discovery, authorization-code/PKCE and client registration requirements. Register their actual redirect URLs as directed by the clients/provider. Configure issuance of signed RS256 or ES256 JWT access tokens with `exp`, the permitted subject, the `memory:access` scope in the space-delimited `scope` claim, and the **full platform-specific MCP URL** as `aud`. The MCP endpoints advertise protected-resource discovery metadata. Do not configure the provider to grant this scope to unintended clients or accounts. Hosted client availability, write permissions, and provider compatibility must be checked on your accounts; static SDK tests do not establish that compatibility.

## Records and testing

`source` is set by the authenticated creation endpoint, not supplied by callers, and records where a memory originated. PostgreSQL enforces uniqueness for active memories with the same trimmed category and content (case-sensitive), even for simultaneous writes. Updates and deletes use an atomic version check. Deletes are soft; the original and all revisions remain in the private history table. If you need permanent erasure, have your database administrator remove the history and record in a controlled transaction and account for backups.

Run `npm ci && npm test`. The tests apply the migration to isolated embedded PostgreSQL (PGlite) and use real HTTP and MCP SDK clients. They cover Arena-style POST, direct database verification, reads on both MCP endpoints, Claude-endpoint updates visible over REST, duplicate rejection, version conflicts, history, deletion, input validation and authorization. No hosted services or secrets are required. To verify live deployment, repeat POST and check the saved ID in Supabase, call `get_memory` in both hosted clients, update from Claude using that ID/version, confirm via REST GET, and repeat a POST with identical active content/category to check for `409`. Live Supabase, hosted MCP client OAuth and Arena outbound access require provisioning and were not verified by the local suite.
