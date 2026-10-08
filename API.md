# External API and MCP

Developer documentation/token management: https://datamarket.nahi.online/developers
OpenAPI: https://datamarket.nahi.online/api/v1/openapi.json
MCP Streamable HTTP: https://datamarket.nahi.online/mcp

Public REST and MCP tools require no authentication. Cookies are deliberately
ignored for personal API access. Sign in with Telegram on the website and create
a 7/30/90-day token with account:read and/or wallet:read. Send it in an
Authorization: Bearer header. Clients must support manually configured headers;
automatic MCP OAuth discovery/consent is not implemented.

Tokens are 256-bit random secrets, hashed with SHA-256 in SQLite. The secret is
shown once and never recorded in the audit log. Only its owner can list/revoke it.
Revocation takes effect on the next request. Maximum ten active tokens per user.
No external trading, payment, event-grant or moderator write capabilities exist.

Public endpoints under /api/v1:
- GET /markets: q, status=all|active|resolved, sort=newest|trending, limit, offset.
- GET /markets/{slug}: market and latest 30 trades.
- GET /markets/{slug}/history: limit and offset; ordered oldest first.
- GET /stats, /leaderboard (top 50), /profiles/{username}.
- GET /me: account:read, own account and positions.
- GET /me/wallet: wallet:read, own balance and payment/event activity; limit, offset.

Pagination defaults to 50, maximum 100; offset maximum 100000. List markets/history
wrap pagination metadata and items under markets/history. Wallet returns activity,
limit and offset. Prices/probabilities are fractional 0–1; currency is DGC.
Existing website calculation helpers provide the same public statistics.

MCP supports protocol 2025-06-18 and 2025-03-26; initialize, ping, tools/list,
tools/call, and notifications. Tools are read-only. Stateless JSON transport,
no session IDs, no standalone SSE (GET returns 405). POST requires
Accept: application/json, text/event-stream and Content-Type: application/json.
Clients send MCP-Protocol-Version after initialization.

REST allows cross-origin reads without cookies. Browser MCP origins are restricted
to the production website; nonbrowser clients can omit Origin. There is no
outbound client-controlled fetch or generic proxy. Limits are 120 calls/minute per
token plus 1000/minute per connection address (shared behind nginx), with bounded
in-memory counters. This conservative aggregate limit avoids trusting spoofable
forwarded-IP headers. HTTP 429 includes Retry-After: 60. Token management is
limited to 30/minute per signed-in user.

Run npm run check and npm test before deploying. Tests cover public parity,
pagination, private scope enforcement, cookie separation, token hashing,
cross-user revocation, expiration, revoked REST/MCP access, read-only restrictions,
MCP initialization/tool discovery/calls, version and Origin checks.

Protocol reference: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
