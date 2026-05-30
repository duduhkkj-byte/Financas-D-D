import { createServer } from "node:http";
import { randomBytes, randomUUID, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(process.env.DB_PATH || join(dataDir, "guardar-plus.sqlite"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
`);

const PORT = Number(process.env.PORT || 3333);
const SESSION_DAYS = 30;
const MAX_BODY_BYTES = 1_000_000;
const CURRENT_PASSWORD_ITERATIONS = 80000;
const MARKET_CACHE_MS = 60 * 1000;
let marketCache = null;

const YAHOO_MARKETS = [
  { symbol: "^BVSP", label: "Ibovespa", kind: "Índice Brasil", category: "Bolsa Brasil", risk: "Alto", note: "Termômetro da bolsa brasileira." },
  { symbol: "BOVA11.SA", label: "BOVA11", kind: "ETF Brasil", category: "Bolsa Brasil", risk: "Alto", note: "ETF amplo ligado ao Ibovespa." },
  { symbol: "SMAL11.SA", label: "SMAL11", kind: "ETF small caps", category: "Bolsa Brasil", risk: "Alto", note: "Empresas menores, mais volatilidade." },
  { symbol: "XFIX11.SA", label: "XFIX11", kind: "ETF FIIs", category: "Fundos imobiliários", risk: "Médio", note: "Exposição diversificada a FIIs." },
  { symbol: "KNRI11.SA", label: "KNRI11", kind: "FII tijolo", category: "Fundos imobiliários", risk: "Médio", note: "FII grande de imóveis físicos." },
  { symbol: "HGLG11.SA", label: "HGLG11", kind: "FII logística", category: "Fundos imobiliários", risk: "Médio", note: "Foco em galpões logísticos." },
  { symbol: "BRL=X", label: "Dólar", kind: "Câmbio", category: "Proteção", risk: "Médio", note: "Proteção cambial e compras externas." },
  { symbol: "GC=F", label: "Ouro", kind: "Commodities", category: "Proteção", risk: "Médio", note: "Ativo defensivo em crises." },
  { symbol: "GOLD11.SA", label: "GOLD11", kind: "ETF ouro", category: "Proteção", risk: "Médio", note: "ETF local ligado ao ouro." },
  { symbol: "^GSPC", label: "S&P 500", kind: "Índice EUA", category: "Exterior", risk: "Alto", note: "Índice amplo dos EUA." },
  { symbol: "^IXIC", label: "Nasdaq", kind: "Índice EUA", category: "Exterior", risk: "Alto", note: "Tecnologia e crescimento." },
  { symbol: "IVVB11.SA", label: "IVVB11", kind: "ETF exterior", category: "Exterior", risk: "Alto", note: "ETF local ligado ao S&P 500." },
  { symbol: "VOO", label: "VOO", kind: "ETF EUA", category: "Exterior", risk: "Alto", note: "ETF americano de S&P 500." },
  { symbol: "QQQ", label: "QQQ", kind: "ETF EUA", category: "Exterior", risk: "Alto", note: "ETF americano de Nasdaq." },
  { symbol: "BTC-USD", label: "Bitcoin", kind: "Cripto", category: "Cripto", risk: "Muito alto", note: "Alta volatilidade, use parcela pequena." },
  { symbol: "ETH-USD", label: "Ethereum", kind: "Cripto", category: "Cripto", risk: "Muito alto", note: "Rede cripto com alta volatilidade." },
  { symbol: "HASH11.SA", label: "HASH11", kind: "ETF cripto", category: "Cripto", risk: "Muito alto", note: "ETF local diversificado de cripto." },
];

const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
if (!userColumns.includes("password_iterations")) {
  db.exec("ALTER TABLE users ADD COLUMN password_iterations INTEGER NOT NULL DEFAULT 210000");
}

function defaultData(name) {
  return {
    userName: name,
    salary: "",
    invGoalPct: 20,
    expenses: [],
    invEntries: [],
    tab: "home",
    setupStep: "salary",
    invSubTab: "metas",
  };
}

function normalizeAppData(data, fallbackName) {
  const source = data && typeof data === "object" ? data : {};
  const salary = source.salary === undefined || source.salary === null ? "" : String(source.salary);

  return {
    userName: source.userName || fallbackName,
    salary,
    invGoalPct: Number(source.invGoalPct) || 20,
    expenses: Array.isArray(source.expenses) ? source.expenses : [],
    invEntries: Array.isArray(source.invEntries) ? source.invEntries : [],
    tab: ["home", "expenses", "add", "invest"].includes(source.tab) ? source.tab : "home",
    setupStep: ["name", "salary", "done"].includes(source.setupStep) ? source.setupStep : (salary ? "done" : "salary"),
    invSubTab: ["metas", "aprender", "ia"].includes(source.invSubTab) ? source.invSubTab : "metas",
  };
}

function hashPassword(password, salt = randomBytes(16).toString("hex"), iterations = CURRENT_PASSWORD_ITERATIONS) {
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return { hash, salt, iterations };
}

function verifyPassword(password, salt, storedHash, iterations) {
  const { hash } = hashPassword(password, salt, iterations);
  const left = Buffer.from(hash, "hex");
  const right = Buffer.from(storedHash, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function createSession(userId) {
  const token = `${randomUUID()}.${randomBytes(24).toString("hex")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(token, userId, expiresAt, now.toISOString());
  return token;
}

function parseData(dataJson) {
  try {
    const data = JSON.parse(dataJson);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Falha ao buscar dados externos (${response.status}).`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function lastValid(values = []) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (typeof values[i] === "number") return values[i];
  }
  return null;
}

async function fetchYahooMarket(item) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=1d&interval=1m`;
  const json = await fetchJson(url);
  const result = json.chart?.result?.[0];
  const meta = result?.meta || {};
  const close = result?.indicators?.quote?.[0]?.close || [];
  const price = meta.regularMarketPrice ?? lastValid(close);
  const previousClose = meta.chartPreviousClose ?? meta.previousClose;
  const change = typeof price === "number" && typeof previousClose === "number" ? price - previousClose : null;

  return {
    ...item,
    price,
    previousClose,
    change,
    changePct: typeof change === "number" && previousClose ? (change / previousClose) * 100 : null,
    currency: meta.currency || "USD",
    marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    source: "Yahoo Finance",
  };
}

async function fetchSelicTarget() {
  const url = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json";
  const json = await fetchJson(url);
  const row = Array.isArray(json) ? json[0] : json?.value?.[0];
  const value = row?.valor ? Number(String(row.valor).replace(",", ".")) : null;

  return {
    symbol: "SELIC",
    label: "Selic Meta",
    kind: "Juros Brasil",
    category: "Renda fixa",
    risk: "Baixo",
    note: "Referência para Tesouro Selic, CDB pós-fixado e liquidez.",
    price: value,
    currency: "PERCENT",
    marketTime: row?.data || null,
    source: "Banco Central do Brasil",
  };
}

async function loadMarketData() {
  if (marketCache && Date.now() - marketCache.createdAt < MARKET_CACHE_MS) {
    return marketCache.data;
  }

  const results = await Promise.allSettled([
    ...YAHOO_MARKETS.map(fetchYahooMarket),
    fetchSelicTarget(),
  ]);

  const assets = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((asset) => typeof asset.price === "number");

  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || "Falha ao buscar cotação.");

  if (assets.length === 0 && marketCache?.data) {
    return {
      ...marketCache.data,
      stale: true,
      errors: ["Não consegui atualizar agora. Mantive os últimos dados carregados."],
    };
  }

  const data = {
    assets,
    errors: assets.length >= 6 ? [] : errors,
    updatedAt: new Date().toISOString(),
    sources: [
      { name: "Yahoo Finance chart API", url: "https://query1.finance.yahoo.com/v8/finance/chart/" },
      { name: "Banco Central do Brasil SGS", url: "https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json" },
    ],
  };

  marketCache = { createdAt: Date.now(), data };
  return data;
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw Object.assign(new Error("Dados enviados são grandes demais."), { status: 413 });
    }
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function setCors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function getUserFromRequest(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  const row = db.prepare(`
    SELECT users.id, users.name, users.email, users.data_json, sessions.expires_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
  `).get(token);

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }

  return row;
}

async function handleRegister(req, res) {
  const body = await readJson(req);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!name) return sendError(res, 400, "Informe seu nome.");
  if (!email.includes("@")) return sendError(res, 400, "Informe um e-mail válido.");
  if (password.length < 6) return sendError(res, 400, "A senha precisa ter pelo menos 6 caracteres.");

  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return sendError(res, 409, "Este e-mail já está cadastrado.");

  const id = randomUUID();
  const { hash, salt, iterations } = hashPassword(password);
  const data = body.data ? normalizeAppData(body.data, name) : defaultData(name);

  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, password_salt, password_iterations, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, email, hash, salt, iterations, JSON.stringify(data), new Date().toISOString());

  const token = createSession(id);
  sendJson(res, 201, { token, user: { id, name, email }, data });
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const iterations = row?.password_iterations || 210000;
  if (!row || !verifyPassword(password, row.password_salt, row.password_hash, iterations)) {
    return sendError(res, 401, "E-mail ou senha inválidos.");
  }

  if (iterations !== CURRENT_PASSWORD_ITERATIONS) {
    const updated = hashPassword(password);
    db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?")
      .run(updated.hash, updated.salt, updated.iterations, row.id);
  }

  const token = createSession(row.id);
  sendJson(res, 200, {
    token,
    user: { id: row.id, name: row.name, email: row.email },
    data: parseData(row.data_json),
  });
}

function handleMe(req, res) {
  const user = getUserFromRequest(req);
  if (!user) return sendError(res, 401, "Sessão expirada. Entre novamente.");

  sendJson(res, 200, {
    user: { id: user.id, name: user.name, email: user.email },
    data: parseData(user.data_json),
  });
}

async function handleSaveData(req, res) {
  const user = getUserFromRequest(req);
  if (!user) return sendError(res, 401, "Sessão expirada. Entre novamente.");

  const body = await readJson(req);
  const data = body.data && typeof body.data === "object" ? body.data : {};
  db.prepare("UPDATE users SET data_json = ? WHERE id = ?").run(JSON.stringify(data), user.id);
  sendJson(res, 200, { ok: true });
}

function handleLogout(req, res) {
  const token = getBearerToken(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  sendJson(res, 200, { ok: true });
}

async function handleMarket(req, res) {
  const data = await loadMarketData();
  sendJson(res, 200, data);
}

const server = createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(302, { location: "http://localhost:5173/" });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/api/register") return await handleRegister(req, res);
    if (req.method === "POST" && url.pathname === "/api/login") return await handleLogin(req, res);
    if (req.method === "POST" && url.pathname === "/api/logout") return handleLogout(req, res);
    if (req.method === "GET" && url.pathname === "/api/me") return handleMe(req, res);
    if (req.method === "PUT" && url.pathname === "/api/data") return await handleSaveData(req, res);
    if (req.method === "GET" && url.pathname === "/api/market") return await handleMarket(req, res);
    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: true });

    sendError(res, 404, "Rota não encontrada.");
  } catch (error) {
    if (error instanceof SyntaxError) return sendError(res, 400, "JSON inválido.");
    sendError(res, error.status || 500, error.message || "Erro interno.");
  }
});

server.listen(PORT, () => {
  console.log(`API Guardar+ rodando em http://localhost:${PORT}`);
});
