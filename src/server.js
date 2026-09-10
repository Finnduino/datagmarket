import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const dbPath = process.env.DATABASE_PATH || join(root, "data", "markets.db");
const port = Number(process.env.PORT || 8791);
const startingBalance = Number(process.env.STARTING_BALANCE || 1000);
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const trueResolvers = ["mysterious spirit", "goondalfus", "tweakus", "ben", "paladingaming66969"];
const marketSubscribers = new Map();
mkdirSync(join(root, "data"), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    balance REAL NOT NULL, created_at TEXT NOT NULL,
    telegram_id TEXT, avatar_url TEXT, role TEXT NOT NULL DEFAULT 'USER'
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS markets (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, question TEXT NOT NULL,
    description TEXT NOT NULL, category TEXT NOT NULL, closes_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN', resolution TEXT,
    resolved_by TEXT, oracle_label TEXT,
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    liquidity REAL NOT NULL DEFAULT 120, q_yes REAL NOT NULL DEFAULT 0,
    q_no REAL NOT NULL DEFAULT 0, volume REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS positions (
    user_id TEXT NOT NULL REFERENCES users(id), market_id TEXT NOT NULL REFERENCES markets(id),
    outcome TEXT NOT NULL, shares REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, market_id, outcome)
  );
  CREATE TABLE IF NOT EXISTS market_options (
    market_id TEXT NOT NULL REFERENCES markets(id), id TEXT NOT NULL,
    label TEXT NOT NULL COLLATE NOCASE, q REAL NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (market_id, id), UNIQUE (market_id, label)
  );
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    market_id TEXT NOT NULL REFERENCES markets(id), outcome TEXT NOT NULL,
    action TEXT NOT NULL, amount REAL NOT NULL, shares REAL NOT NULL,
    price_after REAL NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, market_id TEXT NOT NULL REFERENCES markets(id),
    probability REAL NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
    amount REAL NOT NULL, market_id TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, event_type TEXT NOT NULL,
    actor_user_id TEXT, target_user_id TEXT, market_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS system_accounts (
    name TEXT PRIMARY KEY, balance REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS house_ledger (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount REAL NOT NULL,
    market_id TEXT, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_history_market ON price_history(market_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
`);

function ensureColumn(table, name, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
ensureColumn("users", "telegram_id", "TEXT");
ensureColumn("users", "avatar_url", "TEXT");
ensureColumn("users", "avatar_data", "TEXT");
ensureColumn("users", "role", "TEXT NOT NULL DEFAULT 'USER'");
ensureColumn("markets", "resolved_by", "TEXT");
ensureColumn("markets", "oracle_label", "TEXT");
ensureColumn("markets", "market_type", "TEXT NOT NULL DEFAULT 'BINARY'");
ensureColumn("markets", "resolver_true_name", "TEXT");
ensureColumn("markets", "pricing_model", "TEXT NOT NULL DEFAULT 'LMSR'");
ensureColumn("markets", "collateral", "REAL NOT NULL DEFAULT 0");
ensureColumn("markets", "house_seed", "REAL NOT NULL DEFAULT 0");
ensureColumn("price_history", "outcome", "TEXT");
ensureColumn("positions", "cost_basis", "REAL NOT NULL DEFAULT 0");
ensureColumn("market_options", "reserve", "REAL NOT NULL DEFAULT 0");
db.prepare("INSERT OR IGNORE INTO system_accounts(name,balance) VALUES('HOUSE',1000000)").run();
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL");
for (const market of db.prepare("SELECT * FROM markets WHERE NOT EXISTS (SELECT 1 FROM market_options o WHERE o.market_id=markets.id)").all()) {
  db.prepare("INSERT INTO market_options(market_id,id,label,q,created_by,created_at,sort_order) VALUES(?,?,?,?,?,?,?)").run(market.id, "YES", "Yes", market.q_yes, market.created_by, market.created_at, 0);
  db.prepare("INSERT INTO market_options(market_id,id,label,q,created_by,created_at,sort_order) VALUES(?,?,?,?,?,?,?)").run(market.id, "NO", "No", market.q_no, market.created_by, market.created_at, 1);
}
db.prepare("UPDATE price_history SET outcome='YES' WHERE outcome IS NULL").run();
db.exec(`INSERT INTO price_history(market_id,outcome,probability,created_at)
  SELECT h.market_id,'NO',1-h.probability,h.created_at
  FROM price_history h JOIN markets m ON m.id=h.market_id
  WHERE h.outcome='YES' AND m.market_type='BINARY'
    AND NOT EXISTS (SELECT 1 FROM price_history n WHERE n.market_id=h.market_id AND n.outcome='NO' AND n.created_at=h.created_at)`);
for (const position of db.prepare(`SELECT p.* FROM positions p JOIN markets m ON m.id=p.market_id
  WHERE p.cost_basis=0 AND p.shares>0.0000001 AND m.status<>'RESOLVED'`).all()) {
  let replayShares = 0; let replayBasis = 0;
  const trades = db.prepare("SELECT action,amount,shares FROM trades WHERE user_id=? AND market_id=? AND outcome=? ORDER BY created_at,id").all(position.user_id, position.market_id, position.outcome);
  for (const trade of trades) {
    if (trade.action === "BUY") { replayShares += trade.shares; replayBasis += trade.amount; }
    else if (replayShares > 0) { replayBasis -= replayBasis * Math.min(1, trade.shares / replayShares); replayShares -= trade.shares; }
  }
  db.prepare("UPDATE positions SET cost_basis=? WHERE user_id=? AND market_id=? AND outcome=?").run(Math.max(0, replayBasis), position.user_id, position.market_id, position.outcome);
}

const now = () => new Date().toISOString();
const round = (n, digits = 4) => Number(n.toFixed(digits));
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const slugify = (text) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "market";

function audit(eventType, { actorUserId = null, targetUserId = null, marketId = null, details = {}, createdAt = now() } = {}) {
  db.prepare(`INSERT INTO audit_log(id,event_type,actor_user_id,target_user_id,market_id,details_json,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), eventType, actorUserId, targetUserId, marketId, JSON.stringify(details), createdAt);
}

function getOptions(marketId) {
  return db.prepare("SELECT id,label,q,reserve,created_by createdBy,created_at createdAt,sort_order sortOrder FROM market_options WHERE market_id=? ORDER BY sort_order,created_at").all(marketId);
}

function optionProbabilities(options, liquidity) {
  const scaled = options.map((option) => option.q / liquidity);
  const pivot = Math.max(...scaled);
  const weights = scaled.map((value) => Math.exp(value - pivot));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(options.map((option, index) => [option.id, weights[index] / total]));
}

function marketCost(options, liquidity) {
  const scaled = options.map((option) => option.q / liquidity);
  const pivot = Math.max(...scaled);
  return liquidity * (pivot + Math.log(scaled.reduce((sum, value) => sum + Math.exp(value - pivot), 0)));
}

function fpmmInvariantLog(options) {
  if (!options.length || options.some((option) => !(option.reserve > 0))) throw new Error("Market pool has invalid reserves.");
  return options.reduce((sum, option) => sum + Math.log(option.reserve), 0);
}

function fpmmProbabilities(options) {
  const inverse = options.map((option) => 1 / option.reserve);
  const total = inverse.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(options.map((option, index) => [option.id, inverse[index] / total]));
}

function probabilitiesFor(market, options) {
  return market.pricing_model === "FPMM" ? fpmmProbabilities(options) : optionProbabilities(options, market.liquidity);
}

function fpmmBuy(options, outcome, investment) {
  const selected = options.find((option) => option.id === outcome);
  if (!selected) throw new Error("That option does not exist.");
  const invariantLog = fpmmInvariantLog(options);
  const nonSelectedLog = options.filter((option) => option.id !== outcome).reduce((sum, option) => sum + Math.log(option.reserve + investment), 0);
  const selectedAfter = Math.exp(invariantLog - nonSelectedLog);
  const shares = selected.reserve + investment - selectedAfter;
  for (const option of options) option.reserve = option.id === outcome ? selectedAfter : option.reserve + investment;
  return shares;
}

function fpmmSellPortfolio(options, holdings) {
  const totalShares = Object.values(holdings).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  if (!(totalShares > 0)) return 0;
  const invariantLog = fpmmInvariantLog(options);
  const augmented = options.map((option) => option.reserve + Math.max(0, Number(holdings[option.id]) || 0));
  let low = 0;
  let high = Math.min(...augmented) * (1 - 1e-12);
  for (let i = 0; i < 90; i += 1) {
    const mid = (low + high) / 2;
    const productLog = augmented.reduce((sum, reserve) => sum + Math.log(reserve - mid), 0);
    if (productLog > invariantLog) low = mid; else high = mid;
  }
  return low;
}

function fpmmApplySale(options, outcome, shares) {
  const cash = fpmmSellPortfolio(options, { [outcome]: shares });
  for (const option of options) option.reserve += (option.id === outcome ? shares : 0) - cash;
  return cash;
}

function saveFpmmReserves(marketId, options) {
  const update = db.prepare("UPDATE market_options SET reserve=? WHERE market_id=? AND id=?");
  for (const option of options) update.run(option.reserve, marketId, option.id);
}

function houseEntry(kind, amount, marketId, details = {}, createdAt = now()) {
  db.prepare("UPDATE system_accounts SET balance=balance+? WHERE name='HOUSE'").run(amount);
  db.prepare("INSERT INTO house_ledger(id,kind,amount,market_id,details_json,created_at) VALUES(?,?,?,?,?,?)")
    .run(randomUUID(), kind, amount, marketId, JSON.stringify(details), createdAt);
}

function liquidationValue(marketId, outcome, shares, liquidity) {
  if (!(shares > 0)) return 0;
  const market = db.prepare("SELECT * FROM markets WHERE id=?").get(marketId);
  const options = getOptions(marketId);
  if (!options.some((option) => option.id === outcome)) return 0;
  if (market?.pricing_model === "FPMM") return fpmmSellPortfolio(options, { [outcome]: shares });
  const currentCost = marketCost(options, liquidity);
  const afterSale = options.map((option) => option.id === outcome ? { ...option, q: option.q - shares } : option);
  return Math.max(0, currentCost - marketCost(afterSale, liquidity));
}

function portfolioLiquidationValue(market, positions) {
  if (!positions.length) return 0;
  if (market.pricing_model === "FPMM") {
    return fpmmSellPortfolio(getOptions(market.id), Object.fromEntries(positions.map((position) => [position.outcome, position.shares])));
  }
  return positions.reduce((sum, position) => sum + liquidationValue(market.id, position.outcome, position.shares, market.liquidity), 0);
}

function sharesForSpend(options, outcome, liquidity, spend) {
  const base = marketCost(options, liquidity);
  let low = 0;
  let high = Math.max(spend * 4, 10);
  const nextCost = (shares) => marketCost(options.map((option) => option.id === outcome ? { ...option, q: option.q + shares } : option), liquidity);
  while (nextCost(high) - base < spend) high *= 2;
  for (let i = 0; i < 70; i += 1) {
    const mid = (low + high) / 2;
    if (nextCost(mid) - base > spend) high = mid; else low = mid;
  }
  return low;
}

function recordHistory(marketId, probabilities, createdAt) {
  const insert = db.prepare("INSERT INTO price_history(market_id,outcome,probability,created_at) VALUES(?,?,?,?)");
  for (const [outcome, probability] of Object.entries(probabilities)) insert.run(marketId, outcome, probability, createdAt);
}

// Upgrade still-open legacy LMSR markets into fully collateralized fixed-product pools.
// Resolved markets remain historical LMSR records so their completed payouts never change.
for (const market of db.prepare("SELECT * FROM markets WHERE status='OPEN' AND pricing_model<>'FPMM'").all()) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const netTradingCash = db.prepare(`SELECT COALESCE(SUM(CASE WHEN action='BUY' THEN amount ELSE -amount END),0) value FROM trades WHERE market_id=?`).get(market.id).value;
    const options = getOptions(market.id);
    const holdings = Object.fromEntries(options.map((option) => [option.id, db.prepare("SELECT COALESCE(SUM(shares),0) value FROM positions WHERE market_id=? AND outcome=?").get(market.id, option.id).value]));
    const largestOutstanding = Math.max(...Object.values(holdings));
    const minimumSeed = Math.max(1, largestOutstanding - netTradingCash + 0.001);
    const valueAtSeed = (candidate) => {
      const candidateCollateral = candidate + netTradingCash;
      const candidateOptions = options.map((option) => ({ ...option, reserve: candidateCollateral - holdings[option.id] }));
      return fpmmSellPortfolio(candidateOptions, holdings);
    };
    let low = minimumSeed; let high = Math.max(market.liquidity || 250, low * 2);
    let lowError = valueAtSeed(low) - netTradingCash; let highError = valueAtSeed(high) - netTradingCash;
    if (!(netTradingCash > 0) || !(largestOutstanding > 0)) { lowError = 1; highError = 1; }
    for (let i = 0; i < 30 && netTradingCash > 0 && largestOutstanding > 0 && lowError * highError > 0; i += 1) {
      high *= 2; highError = valueAtSeed(high) - netTradingCash;
    }
    let seed = market.liquidity || 250;
    if (lowError * highError <= 0) {
      for (let i = 0; i < 90; i += 1) {
        const mid = (low + high) / 2; const midError = valueAtSeed(mid) - netTradingCash;
        if (midError * lowError > 0) { low = mid; lowError = midError; } else high = mid;
      }
      seed = (low + high) / 2;
    }
    const collateral = seed + netTradingCash;
    for (const option of options) {
      option.reserve = collateral - holdings[option.id];
      if (!(option.reserve > 0)) throw new Error("Cannot safely collateralize legacy market.");
      db.prepare("UPDATE market_options SET reserve=? WHERE market_id=? AND id=?").run(option.reserve, market.id, option.id);
    }
    const migratedAt = now();
    db.prepare("UPDATE markets SET pricing_model='FPMM',collateral=?,house_seed=? WHERE id=?").run(collateral, seed, market.id);
    houseEntry("HOUSE_SEED", -seed, market.id, { slug: market.slug, migration: true }, migratedAt);
    recordHistory(market.id, fpmmProbabilities(options), migratedAt);
    audit("PRICING_MODEL_MIGRATION", { marketId: market.id, createdAt: migratedAt, details: { from: "LMSR", to: "FPMM", collateral, houseSeed: seed } });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const at = part.indexOf("=");
    return [part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1))];
  }));
}

function currentUser(req) {
  const token = cookies(req).dg_session;
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.username, u.balance, u.created_at, u.role, u.avatar_data
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at>?`).get(token, now()) || null;
}

function avatarUrl(user) {
  const version = user?.avatar_data ? createHash("sha256").update(user.avatar_data).digest("hex").slice(0, 12) : "pixel";
  return `/api/avatar/${encodeURIComponent(user.id)}?v=${version}`;
}

function safeUser(user) {
  return user && { id: user.id, username: user.username, balance: round(user.balance, 2), createdAt: user.created_at, role: user.role || "USER", avatarUrl: avatarUrl(user) };
}

function avatarSvg(id) {
  const hash = createHash("sha256").update(String(id)).digest();
  const palette = ["#a6e22e", "#f3cc55", "#ff6b62", "#7dd3fc", "#c4b5fd"];
  const color = palette[hash[0] % palette.length];
  const cells = [];
  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 3; x += 1) {
    if ((hash[1 + y * 3 + x] & 1) === 0) continue;
    cells.push(`<rect x="${x + 1}" y="${y + 1}" width="1" height="1"/>`);
    if (x !== 2) cells.push(`<rect x="${7 - (x + 1) - 1}" y="${y + 1}" width="1" height="1"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 7" shape-rendering="crispEdges"><rect width="7" height="7" fill="#20221f"/><g fill="${color}">${cells.join("")}</g></svg>`;
}

function sendAvatar(res, user) {
  if (user?.avatar_data) {
    const match = user.avatar_data.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (match) {
      const content = Buffer.from(match[2], "base64");
      res.writeHead(200, { "Content-Type": match[1], "Content-Length": content.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      return res.end(content);
    }
  }
  const content = avatarSvg(user?.id || "missing");
  res.writeHead(user ? 200 : 404, { "Content-Type": "image/svg+xml; charset=utf-8", "Content-Length": Buffer.byteLength(content), "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
  return res.end(content);
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function notifyMarket(marketId, type = "update") {
  const subscribers = marketSubscribers.get(marketId);
  if (!subscribers) return;
  const message = `event: market\ndata: ${JSON.stringify({ type, at:now() })}\n\n`;
  for (const response of subscribers) {
    try { response.write(message); } catch { subscribers.delete(response); }
  }
  if (!subscribers.size) marketSubscribers.delete(marketId);
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 400_000) throw new Error("Request too large");
  }
  try { return JSON.parse(raw || "{}"); } catch { throw new Error("Invalid JSON"); }
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) json(res, 401, { error: "Sign in to continue." });
  return user;
}

function marketView(m, userId = null) {
  const creator = db.prepare("SELECT username FROM users WHERE id=?").get(m.created_by);
  const positions = userId ? db.prepare("SELECT outcome, shares FROM positions WHERE user_id=? AND market_id=?").all(userId, m.id) : [];
  const rawOptions = getOptions(m.id);
  const probabilities = m.status === "RESOLVED"
    ? Object.fromEntries(rawOptions.map((option) => [option.id, option.id === m.resolution ? 1 : 0]))
    : probabilitiesFor(m, rawOptions);
  const optionViews = rawOptions.map((option) => ({ id: option.id, label: option.label, probability: round(probabilities[option.id], 4), shares: round(positions.find((position) => position.outcome === option.id)?.shares || 0, 4) }));
  const leading = [...optionViews].sort((a, b) => b.probability - a.probability)[0];
  return {
    id: m.id, slug: m.slug, question: m.question, description: m.description,
    category: m.category, closesAt: m.closes_at,
    status: (m.status === "OPEN" && new Date(m.closes_at) <= new Date()) ? "CLOSED" : m.status,
    resolution: m.resolution, oracleLabel: m.oracle_label, createdAt: m.created_at, creator: creator?.username || "Unknown",
    marketType: m.market_type || "BINARY", pricingModel: m.pricing_model || "LMSR", probability: leading?.probability || 0, leadingOption: leading,
    options: optionViews, volume: round(m.volume, 2),
    positions: Object.fromEntries(positions.map((p) => [p.outcome, round(p.shares, 4)])),
  };
}

function uniqueSlug(question) {
  const base = slugify(question);
  let slug = base;
  let index = 2;
  while (db.prepare("SELECT 1 FROM markets WHERE slug=?").get(slug)) slug = `${base}-${index++}`;
  return slug;
}

function verifyTelegramLogin(url) {
  const receivedHash = String(url.searchParams.get("hash") || "");
  const authDate = Number(url.searchParams.get("auth_date"));
  if (!telegramBotToken || !receivedHash || !authDate || Math.abs(Date.now() / 1000 - authDate) > 900) throw new Error("Invalid or expired Telegram sign-in.");
  const fields = [...url.searchParams.entries()].filter(([key]) => key !== "hash").sort(([a], [b]) => a.localeCompare(b));
  const checkString = fields.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHash("sha256").update(telegramBotToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  const received = Buffer.from(receivedHash, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("Telegram signature verification failed.");
  return Object.fromEntries(fields);
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, service: "dg-markets", time: now() });
  }
  if (req.method === "GET" && url.pathname === "/api/me") {
    return json(res, 200, { user: safeUser(currentUser(req)) });
  }
  const avatarMatch = url.pathname.match(/^\/api\/avatar\/([^/]+)$/);
  if (req.method === "GET" && avatarMatch) {
    const user = db.prepare("SELECT id,avatar_data FROM users WHERE id=? AND telegram_id IS NOT NULL").get(decodeURIComponent(avatarMatch[1]));
    return sendAvatar(res, url.searchParams.has("default") && user ? { ...user, avatar_data: null } : user);
  }
  if (req.method === "GET" && url.pathname === "/api/auth/telegram/callback") {
    let claims;
    try { claims = verifyTelegramLogin(url); } catch (error) { return json(res, 400, { error: error.message }); }
    const telegramId = String(claims.id); let user; const created = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      user = db.prepare("SELECT * FROM users WHERE telegram_id=?").get(telegramId);
      if (!user) {
        const fullName = [claims.first_name, claims.last_name].filter(Boolean).join(" ");
        const base = String(claims.username || fullName || `Telegram ${telegramId.slice(-5)}`).trim().slice(0, 22);
        let username = base; let index = 2;
        while (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) username = `${base.slice(0, 20)} ${index++}`;
        const role = db.prepare("SELECT COUNT(*) count FROM users WHERE telegram_id IS NOT NULL").get().count === 0 ? "ADMIN" : "USER";
        const id = randomUUID();
        db.prepare("INSERT INTO users(id,username,balance,created_at,telegram_id,avatar_url,role) VALUES(?,?,?,?,?,?,?)").run(id, username, startingBalance, created, telegramId, null, role);
        db.prepare("INSERT INTO ledger(id,user_id,kind,amount,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), id, "WELCOME", startingBalance, created);
        user = db.prepare("SELECT * FROM users WHERE id=?").get(id);
      }
      const token = randomBytes(32).toString("base64url");
      db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)").run(token, user.id, new Date(Date.now() + 180 * 86400000).toISOString());
      db.exec("COMMIT");
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      res.writeHead(302, { Location: "/", "Set-Cookie": `dg_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${180 * 86400}${secure}`, "Cache-Control": "no-store" });
      return res.end();
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = cookies(req).dg_session;
    if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    return json(res, 200, { ok: true }, { "Set-Cookie": "dg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
  }
  if (req.method === "PATCH" && url.pathname === "/api/me/profile") {
    const user = requireUser(req, res); if (!user) return;
    const input = await body(req);
    const username = String(input.username || "").trim();
    if (username.length < 3 || username.length > 24) return json(res, 400, { error: "Username must be 3–24 characters." });
    if (!/^[\p{L}\p{N}_ .-]+$/u.test(username)) return json(res, 400, { error: "Use letters, numbers, spaces, dots, dashes, or underscores." });
    if (db.prepare("SELECT 1 FROM users WHERE username=? AND id<>?").get(username, user.id)) return json(res, 409, { error: "That username is already taken." });
    let avatarData = user.avatar_data;
    if (Object.hasOwn(input, "avatarData")) {
      avatarData = input.avatarData || null;
      if (avatarData) {
        const match = String(avatarData).match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!match || Buffer.from(match[1], "base64").length > 250_000) return json(res, 400, { error: "Upload a PNG, JPEG, or WebP image under 250 KB." });
      }
    }
    db.prepare("UPDATE users SET username=?,avatar_data=? WHERE id=?").run(username, avatarData, user.id);
    audit("PROFILE_UPDATE", {
      actorUserId: user.id,
      targetUserId: user.id,
      details: { previousUsername: user.username, username, avatarChanged: avatarData !== user.avatar_data },
    });
    return json(res, 200, { user: safeUser(db.prepare("SELECT * FROM users WHERE id=?").get(user.id)) });
  }
  if (req.method === "GET" && url.pathname === "/api/markets") {
    const user = currentUser(req);
    const q = String(url.searchParams.get("q") || "").trim();
    const category = String(url.searchParams.get("category") || "");
    const sort = String(url.searchParams.get("sort") || "newest");
    const status = String(url.searchParams.get("status") || "all").toLowerCase();
    let rows = db.prepare(`SELECT m.*,
      SUM(CASE WHEN t.created_at>? THEN 1 ELSE 0 END) recent_trades,
      MAX(t.created_at) last_trade_at
      FROM markets m LEFT JOIN trades t ON t.market_id=m.id
      GROUP BY m.id`).all(new Date(Date.now() - 7 * 86400000).toISOString());
    rows.sort(sort === "trending"
      ? (a, b) => (b.recent_trades * 1000 + b.volume) - (a.recent_trades * 1000 + a.volume) || String(b.last_trade_at || b.created_at).localeCompare(String(a.last_trade_at || a.created_at))
      : (a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (q) rows = rows.filter((m) => `${m.question} ${m.description}`.toLowerCase().includes(q.toLowerCase()));
    if (category && category !== "All") rows = rows.filter((m) => m.category === category);
    if (status === "active") rows = rows.filter((m) => m.status !== "RESOLVED");
    if (status === "resolved") rows = rows.filter((m) => m.status === "RESOLVED");
    const stats = db.prepare("SELECT COUNT(*) trades, COALESCE(SUM(amount),0) volume FROM trades").get();
    return json(res, 200, { markets: rows.map((m) => ({ ...marketView(m, user?.id), recentTrades: m.recent_trades || 0 })), categories: ["All", ...new Set(rows.map((m) => m.category))], stats: { markets: rows.length, trades: stats.trades, volume: round(stats.volume, 2) } });
  }
  const streamMatch = url.pathname.match(/^\/api\/markets\/([^/]+)\/stream$/);
  if (req.method === "GET" && streamMatch) {
    const market = db.prepare("SELECT id FROM markets WHERE slug=?").get(decodeURIComponent(streamMatch[1]));
    if (!market) return json(res, 404, { error: "Market not found." });
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write(`retry: 2000\nevent: ready\ndata: ${JSON.stringify({ at:now() })}\n\n`);
    const subscribers = marketSubscribers.get(market.id) || new Set();
    subscribers.add(res); marketSubscribers.set(market.id, subscribers);
    const heartbeat = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 15000);
    req.on("close", () => {
      clearInterval(heartbeat); subscribers.delete(res);
      if (!subscribers.size) marketSubscribers.delete(market.id);
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/leaderboard") {
    const users = db.prepare("SELECT id,username,balance,avatar_data FROM users WHERE telegram_id IS NOT NULL").all().map((user) => {
      const positions = db.prepare(`SELECT p.market_id marketId,p.outcome,p.shares
        FROM positions p JOIN markets m ON m.id=p.market_id
        WHERE p.user_id=? AND p.shares>0.0001 AND m.status='OPEN' AND m.closes_at>?`).all(user.id, now());
      const byMarket = Map.groupBy(positions, (position) => position.marketId);
      const tiedUp = [...byMarket].reduce((sum, [marketId, holdings]) => {
        const market = db.prepare("SELECT * FROM markets WHERE id=?").get(marketId);
        return sum + portfolioLiquidationValue(market, holdings);
      }, 0);
      return { ...user, tiedUp, markets: new Set(positions.map((position) => position.marketId)).size };
    }).sort((a, b) => (b.balance + b.tiedUp) - (a.balance + a.tiedUp)).slice(0, 50);
    return json(res, 200, { users: users.map((u, index) => ({ rank: index + 1, username: u.username, avatarUrl: avatarUrl(u), cash: round(u.balance, 2), tiedUp: round(u.tiedUp, 2), netAssets: round(u.balance + u.tiedUp, 2), markets: u.markets })) });
  }
  if (req.method === "GET" && url.pathname === "/api/search") {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    if (q.length < 2) return json(res, 200, { markets: [], users: [] });
    const markets = db.prepare("SELECT * FROM markets WHERE lower(question) LIKE ? OR lower(description) LIKE ? ORDER BY volume DESC LIMIT 24").all(`%${q}%`, `%${q}%`).map((m) => marketView(m));
    const users = db.prepare("SELECT id,username,balance,created_at,avatar_data FROM users WHERE telegram_id IS NOT NULL AND lower(username) LIKE ? ORDER BY balance DESC LIMIT 24").all(`%${q}%`).map((u) => ({ username: u.username, avatarUrl: avatarUrl(u), cash: round(u.balance, 2), createdAt: u.created_at }));
    return json(res, 200, { markets, users });
  }
  const profileMatch = url.pathname.match(/^\/api\/profile\/([^/]+)$/);
  if (req.method === "GET" && profileMatch) {
    const username = decodeURIComponent(profileMatch[1]);
    const user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
    if (!user || !user.telegram_id) return json(res, 404, { error: "Profile not found." });
    const positions = db.prepare(`SELECT p.outcome,p.shares,o.label outcomeLabel,m.id marketId,m.liquidity,m.slug,m.question,m.status,m.resolution,m.closes_at closesAt
      FROM positions p JOIN markets m ON m.id=p.market_id JOIN market_options o ON o.market_id=p.market_id AND o.id=p.outcome
      WHERE p.user_id=? AND p.shares>0.0001 ORDER BY m.created_at DESC`).all(user.id).map((p) => ({
        ...p,
        shares: round(p.shares, 3),
        probability: round((() => {
          const market = db.prepare("SELECT * FROM markets WHERE id=?").get(p.marketId);
          if (market.status === "RESOLVED") return p.outcome === market.resolution ? 1 : 0;
          return probabilitiesFor(market, getOptions(p.marketId))[p.outcome];
        })(), 4),
        cashoutValue: p.status === "OPEN" && new Date(p.closesAt) > new Date() ? round(liquidationValue(p.marketId, p.outcome, p.shares, p.liquidity), 2) : 0,
      }));
    const openByMarket = Map.groupBy(positions.filter((position) => position.status === "OPEN" && new Date(position.closesAt) > new Date()), (position) => position.marketId);
    const portfolioCashoutValue = [...openByMarket].reduce((sum, [marketId, holdings]) => sum + portfolioLiquidationValue(db.prepare("SELECT * FROM markets WHERE id=?").get(marketId), holdings), 0);
    const created = db.prepare("SELECT * FROM markets WHERE created_by=? ORDER BY created_at DESC").all(user.id).map((m) => marketView(m));
    const trades = db.prepare(`SELECT t.*,o.label outcomeLabel,m.question,m.slug FROM trades t JOIN markets m ON m.id=t.market_id LEFT JOIN market_options o ON o.market_id=t.market_id AND o.id=t.outcome
      WHERE t.user_id=? ORDER BY t.created_at DESC LIMIT 30`).all(user.id).map((t) => ({ ...t, amount: round(t.amount, 2), shares: round(t.shares, 3) }));
    return json(res, 200, { user: safeUser(user), portfolioCashoutValue: round(portfolioCashoutValue, 2), positions, created, trades });
  }
  if (req.method === "POST" && url.pathname === "/api/markets") {
    const user = requireUser(req, res); if (!user) return;
    const input = await body(req);
    const question = String(input.question || "").trim();
    const description = String(input.description || "").trim();
    const category = String(input.category || "Miscellaneous").trim().slice(0, 32);
    const closesAt = new Date(input.closesAt);
    const marketType = String(input.marketType || "BINARY").toUpperCase() === "MULTIPLE" ? "MULTIPLE" : "BINARY";
    const openingOutcomeInput = String(input.openingOutcome || "").trim();
    const suppliedOptions = Array.isArray(input.options) ? input.options.map((value) => String(value).trim()).filter(Boolean) : [];
    const labels = marketType === "BINARY" ? ["Yes", "No"] : suppliedOptions;
    if (question.length < 10 || question.length > 160 || !question.endsWith("?")) return json(res, 400, { error: "Write a clear question of 10–160 characters ending in a question mark." });
    if (description.length < 20 || description.length > 1200) return json(res, 400, { error: "Resolution rules must be 20–1,200 characters." });
    if (!Number.isFinite(closesAt.getTime()) || closesAt <= new Date(Date.now() + 15 * 60000)) return json(res, 400, { error: "Closing time must be at least 15 minutes from now." });
    if (marketType === "MULTIPLE" && (labels.length < 2 || labels.length > 10)) return json(res, 400, { error: "Multiple-choice markets need 2–10 initial options." });
    if (labels.some((label) => label.length < 1 || label.length > 50) || new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) return json(res, 400, { error: "Options must be unique and 1–50 characters each." });
    const optionSpecs = labels.map((label, index) => ({ id: marketType === "BINARY" ? label.toUpperCase() : `option-${randomUUID()}`, label, sortOrder: index }));
    const openingOption = marketType === "BINARY"
      ? optionSpecs.find((option) => option.id === openingOutcomeInput.toUpperCase())
      : optionSpecs.find((option) => option.label.toLowerCase() === openingOutcomeInput.toLowerCase());
    if (!openingOption) return json(res, 400, { error: "Choose which option receives your opening 100 DGC." });
    const id = randomUUID(); const created = now(); const b = 250; const openingStake = 100;
    const slug = uniqueSlug(question);
    db.exec("BEGIN IMMEDIATE");
    try {
      const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
      if (freshUser.balance < openingStake) throw new Error("You need 100 DGC to open a market.");
      const house = db.prepare("SELECT balance FROM system_accounts WHERE name='HOUSE'").get();
      if (!house || house.balance < b) throw new Error("The house treasury cannot seed another market.");
      db.prepare(`INSERT INTO markets(id,slug,question,description,category,closes_at,status,created_by,created_at,liquidity,q_yes,q_no,volume,market_type,pricing_model,collateral,house_seed)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, slug, question, description, category, closesAt.toISOString(), "OPEN", user.id, created, b, 0, 0, openingStake, marketType, "FPMM", b + openingStake, b);
      const insertOption = db.prepare("INSERT INTO market_options(market_id,id,label,q,reserve,created_by,created_at,sort_order) VALUES(?,?,?,?,?,?,?,?)");
      for (const option of optionSpecs) insertOption.run(id, option.id, option.label, 0, b, user.id, created, option.sortOrder);
      const initialOptions = getOptions(id);
      const beforeProbabilities = fpmmProbabilities(initialOptions);
      const shares = fpmmBuy(initialOptions, openingOption.id, openingStake);
      saveFpmmReserves(id, initialOptions);
      const afterProbabilities = fpmmProbabilities(initialOptions);
      const afterP = afterProbabilities[openingOption.id];
      db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(openingStake, user.id);
      houseEntry("HOUSE_SEED", -b, id, { slug, optionCount: optionSpecs.length }, created);
      db.prepare("INSERT INTO positions(user_id,market_id,outcome,shares,cost_basis) VALUES(?,?,?,?,?)").run(user.id, id, openingOption.id, shares, openingStake);
      db.prepare("INSERT INTO trades(id,user_id,market_id,outcome,action,amount,shares,price_after,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), user.id, id, openingOption.id, "BUY", openingStake, shares, afterP, created);
      recordHistory(id, beforeProbabilities, new Date(Date.now() - 1).toISOString());
      recordHistory(id, afterProbabilities, created);
      db.prepare("INSERT INTO ledger(id,user_id,kind,amount,market_id,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), user.id, "MARKET_OPEN", -openingStake, id, created);
      audit("MARKET_CREATE", {
        actorUserId: user.id,
        marketId: id,
        createdAt: created,
        details: { slug, question, marketType, optionCount: optionSpecs.length, openingOption: openingOption.id, openingStake },
      });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); return json(res, 400, { error: error.message }); }
    return json(res, 201, { market: marketView(db.prepare("SELECT * FROM markets WHERE id=?").get(id), user.id) });
  }
  const marketMatch = url.pathname.match(/^\/api\/markets\/([^/]+)$/);
  if (req.method === "GET" && marketMatch) {
    const m = db.prepare("SELECT * FROM markets WHERE slug=?").get(decodeURIComponent(marketMatch[1]));
    if (!m) return json(res, 404, { error: "Market not found." });
    const user = currentUser(req);
    const history = db.prepare("SELECT outcome,probability,created_at createdAt FROM price_history WHERE market_id=? ORDER BY created_at").all(m.id);
    const trades = db.prepare(`SELECT t.outcome,o.label outcomeLabel,t.action,t.amount,t.shares,t.price_after priceAfter,t.created_at createdAt,u.username
      FROM trades t JOIN users u ON u.id=t.user_id LEFT JOIN market_options o ON o.market_id=t.market_id AND o.id=t.outcome
      WHERE t.market_id=? ORDER BY t.created_at DESC LIMIT 30`).all(m.id);
    return json(res, 200, { market: marketView(m, user?.id), history, trades });
  }
  if (req.method === "DELETE" && marketMatch) {
    const admin = requireUser(req, res); if (!admin) return;
    if (admin.role !== "ADMIN") return json(res, 403, { error: "Admin permission required." });
    const m = db.prepare("SELECT * FROM markets WHERE slug=?").get(decodeURIComponent(marketMatch[1]));
    if (!m) return json(res, 404, { error: "Market not found." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const refunds = db.prepare(`SELECT user_id,MAX(0,SUM(cost_basis)) amount FROM positions WHERE market_id=? GROUP BY user_id`).all(m.id);
      const refundedAt = now();
      for (const refund of refunds) {
        if (refund.amount <= 0) continue;
        db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(refund.amount, refund.user_id);
        db.prepare("INSERT INTO ledger(id,user_id,kind,amount,market_id,created_at) VALUES(?,?,?,?,?,?)")
          .run(randomUUID(), refund.user_id, "MARKET_REFUND", refund.amount, m.id, refundedAt);
      }
      const refundedUsers = refunds.filter((refund) => refund.amount > 0).length;
      const refundedAmount = round(refunds.reduce((sum, refund) => sum + Math.max(0, refund.amount), 0), 2);
      let houseReturn = null;
      if (m.pricing_model === "FPMM") {
        if (refundedAmount > m.collateral + 1e-6) throw new Error("Refunds exceed locked market collateral.");
        houseReturn = Math.max(0, m.collateral - refundedAmount);
        houseEntry("HOUSE_DELETE_RETURN", houseReturn, m.id, { slug: m.slug, collateral: m.collateral, refundedAmount }, refundedAt);
      }
      audit("MARKET_DELETE", {
        actorUserId: admin.id,
        marketId: m.id,
        createdAt: refundedAt,
        details: { slug: m.slug, question: m.question, refundedUsers, refundedAmount, houseReturn },
      });
      db.prepare("DELETE FROM price_history WHERE market_id=?").run(m.id);
      db.prepare("DELETE FROM trades WHERE market_id=?").run(m.id);
      db.prepare("DELETE FROM positions WHERE market_id=?").run(m.id);
      db.prepare("DELETE FROM market_options WHERE market_id=?").run(m.id);
      db.prepare("DELETE FROM markets WHERE id=?").run(m.id);
      db.exec("COMMIT");
      notifyMarket(m.id, "deleted");
      return json(res, 200, { ok: true, refundedUsers, refundedAmount });
    } catch (error) {
      db.exec("ROLLBACK");
      return json(res, 400, { error: error.message });
    }
  }
  const quoteMatch = url.pathname.match(/^\/api\/markets\/([^/]+)\/quote$/);
  if (req.method === "GET" && quoteMatch) {
    try {
      const m = db.prepare("SELECT * FROM markets WHERE slug=?").get(decodeURIComponent(quoteMatch[1]));
      if (!m) return json(res, 404, { error: "Market not found." });
      if (m.status !== "OPEN" || new Date(m.closes_at) <= new Date()) return json(res, 400, { error: "This market is closed." });
      const outcome = String(url.searchParams.get("outcome") || "").trim();
      const action = String(url.searchParams.get("action") || "BUY").toUpperCase();
      const amount = Number(url.searchParams.get("amount"));
      const options = getOptions(m.id);
      const selected = options.find((option) => option.id === outcome);
      if (!selected || !["BUY", "SELL"].includes(action) || !Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: "Invalid quote." });
      if (action === "BUY") {
        const shares = m.pricing_model === "FPMM" ? fpmmBuy(options, outcome, amount) : sharesForSpend(options, outcome, m.liquidity, amount);
        return json(res, 200, { action, amount: round(amount, 4), shares: round(shares, 4), toWin: round(shares, 4), profit: round(shares - amount, 4) });
      }
      const cash = m.pricing_model === "FPMM"
        ? fpmmSellPortfolio(options, { [outcome]: amount })
        : Math.max(0, marketCost(options, m.liquidity) - marketCost(options.map((option) => option.id === outcome ? { ...option, q: option.q - amount } : option), m.liquidity));
      return json(res, 200, { action, shares: round(amount, 4), cash: round(cash, 4) });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  const optionMatch = url.pathname.match(/^\/api\/markets\/([^/]+)\/options$/);
  if (req.method === "POST" && optionMatch) {
    const user = requireUser(req, res); if (!user) return;
    const input = await body(req); const label = String(input.label || "").trim();
    if (label.length < 1 || label.length > 50) return json(res, 400, { error: "Option must be 1–50 characters." });
    const m = db.prepare("SELECT * FROM markets WHERE slug=?").get(decodeURIComponent(optionMatch[1]));
    if (!m) return json(res, 404, { error: "Market not found." });
    if (m.market_type !== "MULTIPLE") return json(res, 400, { error: "New options can only be added to multiple-choice markets." });
    if (m.pricing_model !== "FPMM") return json(res, 400, { error: "This legacy market cannot accept new options." });
    if (m.status !== "OPEN" || new Date(m.closes_at) <= new Date()) return json(res, 400, { error: "This market is closed." });
    const count = db.prepare("SELECT COUNT(*) count FROM market_options WHERE market_id=?").get(m.id).count;
    if (count >= 20) return json(res, 400, { error: "This market already has the maximum of 20 options." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const stake = 100; const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
      if (freshUser.balance < stake) throw new Error("You need 100 DGC to add and open a new option.");
      const id = `option-${randomUUID()}`; const created = now();
      db.prepare("INSERT INTO market_options(market_id,id,label,q,reserve,created_by,created_at,sort_order) VALUES(?,?,?,?,?,?,?,?)").run(m.id, id, label, 0, m.collateral, user.id, created, count);
      const options = getOptions(m.id); const before = fpmmProbabilities(options);
      const shares = fpmmBuy(options, id, stake);
      saveFpmmReserves(m.id, options);
      db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(stake, user.id);
      db.prepare("INSERT INTO positions(user_id,market_id,outcome,shares,cost_basis) VALUES(?,?,?,?,?)").run(user.id, m.id, id, shares, stake);
      const after = fpmmProbabilities(options);
      db.prepare("INSERT INTO trades(id,user_id,market_id,outcome,action,amount,shares,price_after,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), user.id, m.id, id, "BUY", stake, shares, after[id], created);
      db.prepare("UPDATE markets SET volume=volume+?,collateral=collateral+? WHERE id=?").run(stake, stake, m.id);
      recordHistory(m.id, before, new Date(Date.now()-1).toISOString()); recordHistory(m.id, after, created);
      db.prepare("INSERT INTO ledger(id,user_id,kind,amount,market_id,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), user.id, "OPTION_OPEN", -stake, m.id, created);
      audit("OPTION_ADD", { actorUserId: user.id, marketId: m.id, createdAt: created, details: { optionId: id, label, openingStake: stake, convertedCompleteSets: m.collateral } });
      db.exec("COMMIT");
      notifyMarket(m.id, "option");
      return json(res, 201, { market: marketView(db.prepare("SELECT * FROM markets WHERE id=?").get(m.id), user.id), user: safeUser(db.prepare("SELECT * FROM users WHERE id=?").get(user.id)), option: { id, label } });
    } catch (error) {
      db.exec("ROLLBACK");
      return json(res, String(error.message).includes("UNIQUE") ? 409 : 400, { error: String(error.message).includes("UNIQUE") ? "That option already exists." : error.message });
    }
  }
  const tradeMatch = url.pathname.match(/^\/api\/markets\/([^/]+)\/trade$/);
  if (req.method === "POST" && tradeMatch) {
    const user = requireUser(req, res); if (!user) return;
    const input = await body(req);
    const outcome = String(input.outcome || "").trim();
    const action = String(input.action || "BUY").toUpperCase();
    const amount = Number(input.amount);
    if (!outcome || !['BUY','SELL'].includes(action) || !Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: "Invalid trade." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const m = db.prepare("SELECT * FROM markets WHERE slug=?").get(decodeURIComponent(tradeMatch[1]));
      const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
      if (!m) throw new Error("Market not found.");
      if (m.status !== "OPEN" || new Date(m.closes_at) <= new Date()) throw new Error("This market is closed.");
      const options = getOptions(m.id);
      const selected = options.find((option) => option.id === outcome);
      if (!selected) throw new Error("That option does not exist.");
      let cash; let shares; let basisDelta;
      if (action === "BUY") {
        cash = round(amount, 4);
        if (cash < 1) throw new Error("Minimum trade is 1 DGC.");
        if (cash > freshUser.balance + 1e-8) throw new Error("Not enough DGC.");
        shares = m.pricing_model === "FPMM" ? fpmmBuy(options, outcome, cash) : sharesForSpend(options, outcome, m.liquidity, cash);
        if (m.pricing_model !== "FPMM") selected.q += shares;
        basisDelta = cash;
        db.prepare("UPDATE users SET balance=balance-? WHERE id=?").run(cash, user.id);
      } else {
        const position = db.prepare("SELECT shares,cost_basis FROM positions WHERE user_id=? AND market_id=? AND outcome=?").get(user.id, m.id, outcome);
        if (!position || amount > position.shares + 1e-4) throw new Error("You do not own that many shares.");
        shares = Math.min(round(amount, 6), position.shares);
        basisDelta = -position.cost_basis * Math.min(1, shares / position.shares);
        if (m.pricing_model === "FPMM") {
          cash = fpmmApplySale(options, outcome, shares);
          if (cash > m.collateral + 1e-7) throw new Error("Market collateral would become invalid.");
        } else {
          const before = marketCost(options, m.liquidity);
          selected.q -= shares;
          if (selected.q < -1e-7) throw new Error("Market inventory would become invalid.");
          cash = before - marketCost(options, m.liquidity);
        }
        db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(cash, user.id);
      }
      const delta = action === "BUY" ? shares : -shares;
      db.prepare(`INSERT INTO positions(user_id,market_id,outcome,shares,cost_basis) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,market_id,outcome) DO UPDATE SET shares=shares+excluded.shares,cost_basis=MAX(0,cost_basis+excluded.cost_basis)`).run(user.id, m.id, outcome, delta, basisDelta);
      if (m.pricing_model === "FPMM") saveFpmmReserves(m.id, options);
      else db.prepare("UPDATE market_options SET q=? WHERE market_id=? AND id=?").run(selected.q, m.id, outcome);
      const afterProbabilities = probabilitiesFor(m, options);
      const afterP = afterProbabilities[outcome];
      const yes = options.find((option) => option.id === "YES")?.q || 0; const no = options.find((option) => option.id === "NO")?.q || 0;
      db.prepare("UPDATE markets SET q_yes=?,q_no=?,volume=volume+?,collateral=collateral+? WHERE id=?").run(yes, no, cash, action === "BUY" ? cash : -cash, m.id);
      const created = now();
      db.prepare("INSERT INTO trades(id,user_id,market_id,outcome,action,amount,shares,price_after,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), user.id, m.id, outcome, action, cash, shares, afterP, created);
      recordHistory(m.id, afterProbabilities, created);
      db.prepare("INSERT INTO ledger(id,user_id,kind,amount,market_id,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), user.id, action, action === "BUY" ? -cash : cash, m.id, created);
      db.exec("COMMIT");
      notifyMarket(m.id, "trade");
      const updated = db.prepare("SELECT * FROM markets WHERE id=?").get(m.id);
      const updatedUser = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
      return json(res, 201, { market: marketView(updated, user.id), user: safeUser(updatedUser), trade: { action, outcome, outcomeLabel: selected.label, amount: round(cash, 2), shares: round(shares, 3) } });
    } catch (error) { db.exec("ROLLBACK"); return json(res, 400, { error: error.message }); }
  }
  const resolveMatch = url.pathname.match(/^\/api\/markets\/([^/]+)\/resolve$/);
  if (req.method === "POST" && resolveMatch) {
    const staff = requireUser(req, res); if (!staff) return;
    if (!['ADMIN','MODERATOR'].includes(staff.role)) return json(res, 403, { error: "Staff permission required." });
    const input = await body(req); const resolution = String(input.resolution || "").trim();
    const trueResolver = String(input.trueResolver || "").trim().toLowerCase();
    if (!resolution) return json(res, 400, { error: "Choose a resolving option." });
    if (!trueResolvers.includes(trueResolver)) return json(res, 400, { error: "Choose an approved resolver." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const m = db.prepare("SELECT * FROM markets WHERE slug=?").get(decodeURIComponent(resolveMatch[1]));
      if (!m || m.status === "RESOLVED") throw new Error("Market is missing or already resolved.");
      const options = getOptions(m.id);
      if (!options.some((option) => option.id === resolution)) throw new Error("That resolving option does not exist.");
      const winners = db.prepare("SELECT user_id,shares FROM positions WHERE market_id=? AND outcome=? AND shares>0").all(m.id, resolution);
      const totalPayout = winners.reduce((sum, winner) => sum + winner.shares, 0);
      if (m.pricing_model === "FPMM" && totalPayout > m.collateral + 1e-6) throw new Error("Winning claims exceed locked collateral.");
      for (const winner of winners) {
        db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(winner.shares, winner.user_id);
        db.prepare("INSERT INTO ledger(id,user_id,kind,amount,market_id,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), winner.user_id, "PAYOUT", winner.shares, m.id, now());
      }
      db.prepare("UPDATE positions SET cost_basis=0 WHERE market_id=?").run(m.id);
      const resolvedAt = now();
      let houseSettlement = null;
      if (m.pricing_model === "FPMM") {
        houseSettlement = Math.max(0, m.collateral - totalPayout);
        houseEntry("HOUSE_SETTLEMENT", houseSettlement, m.id, { resolution, collateral: m.collateral, payout: totalPayout }, resolvedAt);
      }
      db.prepare("UPDATE markets SET status='RESOLVED',resolution=?,resolved_by=?,oracle_label=?,resolver_true_name=?,collateral=? WHERE id=?").run(resolution, staff.id, trueResolver, trueResolver, m.pricing_model === "FPMM" ? 0 : m.collateral, m.id);
      recordHistory(m.id, Object.fromEntries(options.map((option) => [option.id, option.id === resolution ? 1 : 0])), resolvedAt);
      audit("MARKET_RESOLVE", {
        actorUserId: staff.id,
        marketId: m.id,
        createdAt: resolvedAt,
        details: { resolution, trueResolver, winnerCount: winners.length, totalPayout: round(totalPayout, 4), houseSettlement: houseSettlement === null ? null : round(houseSettlement, 4) },
      });
      db.exec("COMMIT");
      notifyMarket(m.id, "resolved");
      return json(res, 200, { market: marketView(db.prepare("SELECT * FROM markets WHERE id=?").get(m.id)) });
    } catch (error) { db.exec("ROLLBACK"); return json(res, 400, { error: error.message }); }
  }
  if (req.method === "GET" && url.pathname === "/api/staff") {
    const staff = requireUser(req, res); if (!staff) return;
    if (!['ADMIN','MODERATOR'].includes(staff.role)) return json(res, 403, { error: "Staff permission required." });
    const payload = { role: staff.role, resolvers: trueResolvers };
    if (staff.role === "ADMIN") {
      payload.users = db.prepare("SELECT id,username,role,created_at FROM users WHERE telegram_id IS NOT NULL ORDER BY created_at").all();
      payload.canManageRoles = true;
    }
    return json(res, 200, payload);
  }
  const staffMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
  if (req.method === "POST" && staffMatch) {
    const admin = requireUser(req, res); if (!admin) return;
    if (admin.role !== "ADMIN") return json(res, 403, { error: "Admin permission required." });
    const input = await body(req); const role = String(input.role || "").toUpperCase();
    if (!['USER','MODERATOR'].includes(role)) return json(res, 400, { error: "Role must be USER or MODERATOR." });
    if (staffMatch[1] === admin.id) return json(res, 400, { error: "The founding admin cannot demote themselves." });
    const target = db.prepare("SELECT id,username,role FROM users WHERE id=? AND telegram_id IS NOT NULL").get(staffMatch[1]);
    if (!target) return json(res, 404, { error: "User not found." });
    const result = db.prepare("UPDATE users SET role=? WHERE id=? AND telegram_id IS NOT NULL").run(role, staffMatch[1]);
    if (!result.changes) return json(res, 404, { error: "User not found." });
    audit("ROLE_CHANGE", { actorUserId: admin.id, targetUserId: target.id, details: { username: target.username, previousRole: target.role, role } });
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/audit") {
    const admin = requireUser(req, res); if (!admin) return;
    if (admin.role !== "ADMIN") return json(res, 403, { error: "Admin permission required." });
    const requestedLimit = Number(url.searchParams.get("limit") || 200);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, Math.trunc(requestedLimit))) : 200;
    const auditRows = db.prepare(`SELECT a.*,actor.username actor_username,target.username target_username,
      m.slug market_slug,m.question market_question
      FROM audit_log a
      LEFT JOIN users actor ON actor.id=a.actor_user_id
      LEFT JOIN users target ON target.id=a.target_user_id
      LEFT JOIN markets m ON m.id=a.market_id
      ORDER BY a.created_at DESC LIMIT ?`).all(limit);
    const ledgerRows = db.prepare(`SELECT l.*,u.username,m.slug market_slug,m.question market_question
      FROM ledger l
      LEFT JOIN users u ON u.id=l.user_id
      LEFT JOIN markets m ON m.id=l.market_id
      ORDER BY l.created_at DESC LIMIT ?`).all(limit);
    const houseRows = db.prepare(`SELECT h.*,m.slug market_slug,m.question market_question
      FROM house_ledger h LEFT JOIN markets m ON m.id=h.market_id
      ORDER BY h.created_at DESC LIMIT ?`).all(limit);
    const events = [
      ...auditRows.map((row) => {
        let details = {};
        try { details = JSON.parse(row.details_json || "{}"); } catch { details = { unreadable: true }; }
        return {
          source: "AUDIT", id: row.id, type: row.event_type, createdAt: row.created_at,
          actor: row.actor_user_id ? { id: row.actor_user_id, username: row.actor_username || null } : null,
          targetUser: row.target_user_id ? { id: row.target_user_id, username: row.target_username || null } : null,
          market: row.market_id ? { id: row.market_id, slug: row.market_slug || details.slug || null, question: row.market_question || details.question || null } : null,
          details,
        };
      }),
      ...ledgerRows.map((row) => ({
        source: "LEDGER", id: row.id, type: row.kind, createdAt: row.created_at,
        actor: null,
        user: row.user_id ? { id: row.user_id, username: row.username || null } : null,
        market: row.market_id ? { id: row.market_id, slug: row.market_slug || null, question: row.market_question || null } : null,
        amount: round(row.amount, 4),
      })),
      ...houseRows.map((row) => {
        let details = {};
        try { details = JSON.parse(row.details_json || "{}"); } catch { details = { unreadable: true }; }
        return {
          source: "HOUSE", id: row.id, type: row.kind, createdAt: row.created_at,
          actor: { id: "HOUSE", username: "house treasury" },
          market: row.market_id ? { id: row.market_id, slug: row.market_slug || details.slug || null, question: row.market_question || null } : null,
          amount: round(row.amount, 4), details,
        };
      }),
    ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
    const houseBalance = db.prepare("SELECT balance FROM system_accounts WHERE name='HOUSE'").get()?.balance || 0;
    return json(res, 200, { events, limit, houseBalance: round(houseBalance, 4) });
  }
  return json(res, 404, { error: "Not found." });
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function staticFile(req, res, url) {
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  const candidate = normalize(join(publicDir, path));
  const file = candidate.startsWith(publicDir) && existsSync(candidate) ? candidate : join(publicDir, "index.html");
  const content = readFileSync(file);
  res.writeHead(200, {
    "Content-Type": mime[extname(file)] || "application/octet-stream",
    "Content-Length": content.length,
    "Cache-Control": [".html", ".js", ".css"].includes(extname(file)) ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data: blob: https://dataguild.fi https://*.telegram.org https://*.telesco.pe; connect-src 'self'; font-src 'self'; frame-src https://oauth.telegram.org https://telegram.org; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://oauth.telegram.org",
  });
  res.end(content);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await api(req, res, url); else staticFile(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: "Something went wrong." }); else res.end();
  }
});

server.listen(port, "0.0.0.0", () => console.log(`DG Markets listening on ${port}`));
