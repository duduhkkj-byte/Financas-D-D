import { useState, useMemo, useEffect, useCallback } from "react";

const fmt = (v) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0);

const TOKEN_KEY = "guardar-plus-token";
const THEME_KEY = "guardar-plus-theme";
const LOCAL_USERS_KEY = "guardar-plus-local-users";
const LOCAL_SESSION_KEY = "guardar-plus-local-session";
const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://localhost:3333" : "");
const STATIC_MODE = !API_URL;

const normalizeEmail = (email = "") => email.trim().toLowerCase();
const readLocalUsers = () => {
  try {
    return JSON.parse(window.localStorage.getItem(LOCAL_USERS_KEY) || "{}");
  } catch {
    return {};
  }
};
const writeLocalUsers = (users) => {
  window.localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users));
};
const publicLocalUser = (record) => record ? ({ id: record.email, name: record.name, email: record.email }) : null;
const makeSalt = () => {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const hashLocalPassword = async (password, salt) => {
  const bytes = new TextEncoder().encode(`${salt}:${password}`);
  const hash = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const getLocalSession = () => {
  const email = normalizeEmail(window.localStorage.getItem(LOCAL_SESSION_KEY));
  if (!email) return null;

  return readLocalUsers()[email] || null;
};

async function apiRequest(path, { method = "GET", body, token, timeoutMs = 10000 } = {}) {
  if (!API_URL) throw new Error("API não configurada para este site.");

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Erro ao falar com o servidor.");
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("O servidor demorou para responder. Tente novamente.", { cause: error });
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

const validTab = (tab) => ["home", "expenses", "add", "invest"].includes(tab) ? tab : "home";
const validInvSubTab = (tab) => ["metas", "aprender", "ia"].includes(tab) ? tab : "metas";
const validSetupStep = (step, hasSalary) => ["name", "salary", "done"].includes(step) ? step : (hasSalary ? "done" : "salary");
const validTheme = (theme) => ["light", "dark"].includes(theme) ? theme : "dark";

const fmtMarket = (asset) => {
  if (!asset || typeof asset.price !== "number") return "--";
  if (asset.currency === "PERCENT") return `${asset.price.toFixed(2).replace(".", ",")}%`;
  if (asset.symbol === "^BVSP" || asset.symbol === "^GSPC" || asset.symbol === "^IXIC") {
    return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(asset.price);
  }
  const currency = asset.symbol === "BRL=X" ? "BRL" : asset.currency || "USD";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency, maximumFractionDigits: 2 }).format(asset.price);
};

const fmtPercent = (v) =>
  typeof v === "number" ? `${v >= 0 ? "+" : ""}${v.toFixed(2).replace(".", ",")}%` : "--";

const buildStaticMarketData = () => ({
  updatedAt: new Date().toISOString(),
  stale: true,
  assets: [
    { symbol: "SELIC", label: "Selic Meta", kind: "Referência", category: "Renda fixa", risk: "Baixo", note: "Configure uma API online para carregar a taxa atual.", price: null, currency: "PERCENT" },
    { symbol: "^BVSP", label: "Ibovespa", kind: "Bolsa Brasil", category: "Bolsa Brasil", risk: "Alto", note: "Índice principal da bolsa brasileira. Dados atuais dependem da API.", price: null, currency: "BRL" },
    { symbol: "IVVB11.SA", label: "IVVB11", kind: "ETF exterior", category: "Exterior", risk: "Médio", note: "Exposição ao S&P 500 em reais. Confira cotação na corretora antes de investir.", price: null, currency: "BRL" },
    { symbol: "BTC-USD", label: "Bitcoin", kind: "Cripto", category: "Cripto", risk: "Muito alto", note: "Cripto é volátil e deve ser pequena parte da carteira.", price: null, currency: "USD" },
  ],
});

function findMarketAsset(marketData, symbol) {
  return marketData?.assets?.find((asset) => asset.symbol === symbol);
}

function buildInvestmentInsights({ salaryNum, remaining, totalInvested, invGoal, spentPct, marketData }) {
  const selic = findMarketAsset(marketData, "SELIC");
  const ibov = findMarketAsset(marketData, "^BVSP");
  const usd = findMarketAsset(marketData, "BRL=X");
  const btc = findMarketAsset(marketData, "BTC-USD");
  const insights = [];

  if (!salaryNum) {
    insights.push({
      title: "Comece pelo salário",
      body: "Informe seu salário para a IA calcular limite de gastos, meta de aporte e próximos passos com mais precisão.",
      tone: "blue",
    });
  }

  if (remaining < 0) {
    insights.push({
      title: "Pare novos aportes de risco",
      body: "Seu saldo disponível está negativo. Priorize reorganizar gastos e evitar dívida antes de aumentar exposição a bolsa ou cripto.",
      tone: "red",
    });
  } else if (spentPct >= 85) {
    insights.push({
      title: "Proteja o caixa do mês",
      body: "Você já usou boa parte do limite. Mantenha dinheiro líquido para contas essenciais e deixe compras de risco para depois.",
      tone: "orange",
    });
  }

  if (invGoal > 0 && totalInvested < invGoal) {
    insights.push({
      title: "Aporte automático primeiro",
      body: `Faltam ${fmt(Math.max(invGoal - totalInvested, 0))} para sua meta mensal. A melhor decisão costuma ser separar o aporte antes dos gastos variáveis.`,
      tone: "green",
    });
  }

  if (selic?.price >= 10) {
    insights.push({
      title: "Juros altos favorecem renda fixa",
      body: `Com Selic perto de ${fmtMarket(selic)}, pós-fixados líquidos e Tesouro Selic tendem a ser bons candidatos para reserva e objetivos curtos.`,
      tone: "blue",
    });
  }

  if (typeof ibov?.changePct === "number") {
    insights.push({
      title: "Bolsa exige calma",
      body: `O Ibovespa está em ${fmtPercent(ibov.changePct)} hoje. Use aportes fracionados e diversificação em vez de tentar acertar o melhor dia.`,
      tone: ibov.changePct < 0 ? "orange" : "green",
    });
  }

  if (typeof usd?.changePct === "number" && Math.abs(usd.changePct) >= 0.5) {
    insights.push({
      title: "Dólar mexeu forte",
      body: `USD/BRL está em ${fmtMarket(usd)} (${fmtPercent(usd.changePct)}). Para proteção internacional, prefira constância a compras grandes por impulso.`,
      tone: "blue",
    });
  }

  if (typeof btc?.changePct === "number" && Math.abs(btc.changePct) >= 2) {
    insights.push({
      title: "Cripto está volátil",
      body: `Bitcoin está em ${fmtPercent(btc.changePct)} hoje. Se usar cripto, limite a uma fatia pequena e só depois da reserva de emergência.`,
      tone: "orange",
    });
  }

  insights.push({
    title: "Regra base da IA",
    body: "Ordem sugerida: reserva de emergência, renda fixa para metas curtas, diversificação gradual para longo prazo e cripto só como parcela pequena.",
    tone: "blue",
  });

  return insights.slice(0, 6);
}

const CATEGORIES = [
  { id: "moradia",     label: "Moradia",     icon: "🏠", color: "#60a5fa" },
  { id: "alimentacao", label: "Alimentação", icon: "🍽️", color: "#fb923c" },
  { id: "transporte",  label: "Transporte",  icon: "🚗", color: "#a78bfa" },
  { id: "saude",       label: "Saúde",       icon: "❤️",  color: "#f472b6" },
  { id: "lazer",       label: "Lazer",       icon: "🎯", color: "#34d399" },
  { id: "educacao",    label: "Educação",    icon: "📚", color: "#fbbf24" },
  { id: "contas",      label: "Contas",      icon: "📄", color: "#94a3b8" },
  { id: "outros",      label: "Outros",      icon: "📦", color: "#64748b" },
];
const cat = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[7];

const EXPENSE_CATEGORY_RULES = [
  { id: "alimentacao", words: ["mercado", "supermercado", "padaria", "restaurante", "ifood", "delivery", "lanche", "pizza", "hamburguer", "comida", "almoco", "jantar", "cafe", "acougue", "hortifruti", "feira", "sorvete"] },
  { id: "transporte", words: ["uber", "99", "taxi", "onibus", "metro", "trem", "combustivel", "gasolina", "alcool", "etanol", "posto", "estacionamento", "pedagio", "mecanico", "oficina", "pneu", "carro", "moto"] },
  { id: "moradia", words: ["aluguel", "condominio", "iptu", "casa", "apartamento", "apto", "moradia", "reforma", "material de construcao", "moveis", "limpeza", "faxina"] },
  { id: "saude", words: ["farmacia", "remedio", "medico", "consulta", "exame", "dentista", "hospital", "plano de saude", "psicologo", "terapia", "academia", "suplemento"] },
  { id: "lazer", words: ["cinema", "netflix", "spotify", "show", "bar", "festa", "viagem", "hotel", "airbnb", "jogo", "game", "presente", "shopping", "praia", "passeio"] },
  { id: "educacao", words: ["escola", "faculdade", "curso", "livro", "material escolar", "mensalidade", "aula", "ingles", "ead", "udemy", "alura", "apostila"] },
  { id: "contas", words: ["luz", "energia", "agua", "internet", "telefone", "celular", "gas", "fatura", "boleto", "seguro", "assinatura", "imposto", "tarifa", "banco"] },
];

const normalizeExpenseText = (value = "") =>
  value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function suggestExpenseCategory(desc) {
  const text = normalizeExpenseText(desc);
  if (text.trim().length < 3) return "";

  let best = { id: "", score: 0 };
  EXPENSE_CATEGORY_RULES.forEach((rule, index) => {
    const score = rule.words.reduce((total, word) => {
      if (!text.includes(word)) return total;
      return total + (word.length >= 6 ? 2 : 1);
    }, 0);

    if (score > best.score) best = { id: rule.id, score, index };
  });

  return best.score > 0 ? best.id : "";
}

const SPEND_TIPS = [
  { pct: 0,   msg: "💡 Separe sua meta de investimento assim que o salário cair." },
  { pct: 30,  msg: "✅ Bom início! Pague contas fixas e separe o investimento primeiro." },
  { pct: 50,  msg: "🟡 Metade usada. Revise se há gastos desnecessários para cortar." },
  { pct: 70,  msg: "🟠 Atenção! Restam apenas 30%. Priorize alimentação e saúde." },
  { pct: 85,  msg: "🔴 Alerta! Quase no limite. Evite novos gastos não essenciais." },
  { pct: 100, msg: "🚨 Salário esgotado! Planeje melhor o próximo mês." },
];
function getAlert(pct) {
  let tip = SPEND_TIPS[0];
  for (const t of SPEND_TIPS) if (pct >= t.pct) tip = t;
  return tip;
}

const INV_TYPES = [
  { id: "reserva",    label: "Reserva de Emergência", icon: "🛡️", color: "#22c55e" },
  { id: "cdb",        label: "CDB / LCI / LCA",       icon: "🏦", color: "#60a5fa" },
  { id: "tesouro",    label: "Tesouro Direto",         icon: "🇧🇷", color: "#fbbf24" },
  { id: "fundos",     label: "Fundos",                 icon: "📊", color: "#a78bfa" },
  { id: "acoes",      label: "Ações / ETFs",           icon: "📈", color: "#f472b6" },
  { id: "previdencia",label: "Previdência",            icon: "🌅", color: "#34d399" },
  { id: "crypto",     label: "Cripto",                 icon: "🪙", color: "#f59e0b" },
  { id: "outro",      label: "Outro",                  icon: "💼", color: "#94a3b8" },
];
const invType = (id) => INV_TYPES.find((t) => t.id === id) || INV_TYPES[7];

const LEARN = [
  {
    id: "reserva", name: "Reserva de Emergência", icon: "🛡️", color: "#22c55e",
    tag: "Prioridade #1", tagColor: "#22c55e", risk: "Sem risco", riskColor: "#22c55e",
    liquidity: "Imediata", minValue: "R$ 1,00",
    where: "CDB 100%+ CDI, Conta rendimento, Tesouro Selic",
    goal: "3 a 6 meses de gastos fixos guardados",
    tip: "Sem isso, qualquer imprevisto vira dívida. É o primeiro passo antes de qualquer investimento.",
    steps: ["Calcule seus gastos fixos mensais","Multiplique por 6 — esse é seu alvo","Abra CDB com liquidez diária ou conta rendimento","Transfira automaticamente todo mês"],
  },
  {
    id: "cdb", name: "CDB / LCI / LCA", icon: "🏦", color: "#60a5fa",
    tag: "Conservador", tagColor: "#60a5fa", risk: "Baixo", riskColor: "#22c55e",
    liquidity: "Variada (verificar prazo)", minValue: "R$ 100,00",
    where: "Nubank, Inter, XP, BTG, bancos digitais",
    goal: "Render mais que a poupança com segurança (FGC até R$ 250 mil)",
    tip: "LCI e LCA são isentos de IR para pessoa física — vantagem enorme em relação ao CDB.",
    steps: ["Busque CDB acima de 100% do CDI","Prefira emissores com FGC","LCI/LCA: ideal para valores com prazo definido","Compare no app Renda Fixa ou Rico"],
  },
  {
    id: "tesouro", name: "Tesouro Direto", icon: "🇧🇷", color: "#fbbf24",
    tag: "Conservador", tagColor: "#60a5fa", risk: "Baixo", riskColor: "#22c55e",
    liquidity: "D+1 (Selic) / Variada", minValue: "R$ 30,00",
    where: "tesouro.gov.br ou corretoras parceiras",
    goal: "Preservar capital com rentabilidade acima da inflação",
    tip: "Tesouro Selic = curto prazo. Tesouro IPCA+ = proteção contra inflação no longo prazo.",
    steps: ["Acesse tesouro.gov.br com seu CPF","Selic para curto prazo","IPCA+ para aposentadoria ou metas longas","Aporte mínimo de R$ 30 mensalmente"],
  },
  {
    id: "fundos", name: "Fundos de Investimento", icon: "📊", color: "#a78bfa",
    tag: "Moderado", tagColor: "#f59e0b", risk: "Médio", riskColor: "#f59e0b",
    liquidity: "Variada (D+1 a D+30)", minValue: "R$ 100,00",
    where: "XP, Rico, BTG, corretoras diversas",
    goal: "Diversificação gerenciada por profissionais",
    tip: "Atenção à taxa de administração: prefira fundos com taxa abaixo de 1% ao ano.",
    steps: ["Veja rentabilidade dos últimos 3 anos","Compare taxa de adm. com fundos similares","Prefira fundos com mais de R$ 50 mi sob gestão","Diversifique entre renda fixa e multimercado"],
  },
  {
    id: "acoes", name: "Ações / ETFs", icon: "📈", color: "#f472b6",
    tag: "Avançado", tagColor: "#ef4444", risk: "Alto", riskColor: "#ef4444",
    liquidity: "D+2 (mercado aberto)", minValue: "R$ 1,00 (frações)",
    where: "B3 via corretoras: XP, Clear, Rico, Nubank",
    goal: "Crescimento de patrimônio no longo prazo (5+ anos)",
    tip: "Nunca invista em ações dinheiro que precisará em menos de 3 anos.",
    steps: ["Só após ter reserva de emergência completa","Comece com ETFs (BOVA11, IVVB11)","Invista mensalmente independente do mercado","Estude na B3, Bastter, Faculdade do Dinheiro"],
  },
  {
    id: "previdencia", name: "Previdência Privada", icon: "🌅", color: "#34d399",
    tag: "Longo Prazo", tagColor: "#34d399", risk: "Variável", riskColor: "#f59e0b",
    liquidity: "Baixa (longo prazo)", minValue: "R$ 50,00",
    where: "Bancos, seguradoras, corretoras",
    goal: "Complementar aposentadoria, benefício fiscal no PGBL",
    tip: "PGBL deduz até 12% da renda bruta no IR. VGBL é melhor para quem não declara completo.",
    steps: ["PGBL: quem declara IR completo","VGBL: demais casos","Fuja de fundos com taxa de carregamento","Busque taxa de adm. abaixo de 1% ao ano"],
  },
];

function Arc({ pct, size = 180, trackColor = "#1e293b", mutedColor = "#475569" }) {
  const r = size * 0.38;
  const cx = size / 2, cy = size / 2;
  const safePct = Math.max(0, Math.min(pct, 100));
  const endAngle = Math.PI * (safePct / 100);
  const endX = cx + r * Math.cos(Math.PI - endAngle);
  const endY = cy - r * Math.sin(endAngle);
  const color = safePct >= 100 ? "#ef4444" : safePct >= 85 ? "#f97316" : safePct >= 70 ? "#eab308" : safePct >= 50 ? "#facc15" : "#22c55e";
  return (
    <svg width={size} height={size * 0.62} viewBox={`0 0 ${size} ${size * 0.62}`} style={{ overflow: "visible" }}>
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none" stroke={trackColor} strokeWidth={size * 0.09} strokeLinecap="round" />
      {safePct > 0 && (
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${endX} ${endY}`}
          fill="none" stroke={color} strokeWidth={size * 0.09} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 6px ${color}99)` }} />
      )}
      <text x={cx} y={cy - 4} textAnchor="middle" fill={color} fontSize={size * 0.15} fontWeight="800" fontFamily="'DM Sans', sans-serif">
        {Math.round(safePct)}%
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" fill={mutedColor} fontSize={size * 0.075} fontFamily="'DM Sans', sans-serif">
        usado
      </text>
    </svg>
  );
}

function MiniArc({ pct, size = 56, color = "#3b82f6", trackColor = "#1e293b" }) {
  const r = size * 0.38, cx = size / 2, cy = size / 2;
  const safePct = Math.max(0, Math.min(pct, 100));
  const endAngle = Math.PI * (safePct / 100);
  const endX = cx + r * Math.cos(Math.PI - endAngle);
  const endY = cy - r * Math.sin(endAngle);
  return (
    <svg width={size} height={size * 0.62} viewBox={`0 0 ${size} ${size * 0.62}`} style={{ overflow: "visible" }}>
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none" stroke={trackColor} strokeWidth={size * 0.1} strokeLinecap="round" />
      {safePct > 0 && (
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${endX} ${endY}`}
          fill="none" stroke={color} strokeWidth={size * 0.1} strokeLinecap="round" />
      )}
      <text x={cx} y={cy - 1} textAnchor="middle" fill={color} fontSize={size * 0.22} fontWeight="800" fontFamily="'DM Sans', sans-serif">
        {Math.round(safePct)}%
      </text>
    </svg>
  );
}

export default function App() {
  const today                       = new Date().toISOString().slice(0, 10);
  const [authUser, setAuthUser]     = useState(null);
  const [authMode, setAuthMode]     = useState("login");
  const [authForm, setAuthForm]     = useState({ name: "", email: "", password: "" });
  const [authLoading, setAuthLoading] = useState(true);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError]   = useState("");
  const [dataReady, setDataReady]   = useState(false);
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState("");
  const [marketData, setMarketData] = useState(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [marketWarning, setMarketWarning] = useState("");
  const [userName, setUserName]     = useState("");
  const [nameInput, setNameInput]   = useState("");
  const [salary, setSalary]         = useState("");
  const [salaryInput, setSalaryInput] = useState("");
  const [invGoalPct, setInvGoalPct] = useState(20);
  const [expenses, setExpenses]     = useState([]);
  const [invEntries, setInvEntries] = useState([]); // { id, label, type, value, date }
  const [form, setForm]             = useState({ desc: "", value: "", category: "alimentacao", date: today });
  const [expenseCategoryManual, setExpenseCategoryManual] = useState(false);
  const [invForm, setInvForm]       = useState({ label: "", type: "reserva", value: "", date: today });
  const [tab, setTab]               = useState("home");
  const [setupStep, setSetupStep]   = useState("name");
  const [notification, setNotification] = useState(null);
  const [prevPct, setPrevPct]       = useState(0);
  const [expandedLearn, setExpandedLearn] = useState(null);
  const [invSubTab, setInvSubTab]   = useState("metas"); // metas | aprender | ia
  const [theme, setTheme]           = useState(() => validTheme(window.localStorage.getItem(THEME_KEY)));

  const totalExpenses = useMemo(() => expenses.reduce((s, e) => s + e.value, 0), [expenses]);
  const totalInvested = useMemo(() => invEntries.reduce((s, e) => s + e.value, 0), [invEntries]);
  const salaryNum     = parseFloat(salary) || 0;
  const invGoal       = salaryNum * (invGoalPct / 100);
  const available     = salaryNum - invGoal;
  const remaining     = available - totalExpenses;
  const spentPct      = available > 0 ? (totalExpenses / available) * 100 : 0;
  const invProgress   = invGoal > 0 ? Math.min((totalInvested / invGoal) * 100, 100) : 0;
  const alert         = getAlert(spentPct);
  const alertColor    = spentPct >= 100 ? "#ef4444" : spentPct >= 85 ? "#f97316" : spentPct >= 70 ? "#eab308" : spentPct >= 50 ? "#fbbf24" : "#22c55e";

  const byCategory = useMemo(() => {
    const map = {};
    expenses.forEach((e) => { map[e.category] = (map[e.category] || 0) + e.value; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [expenses]);

  const byInvType = useMemo(() => {
    const map = {};
    invEntries.forEach((e) => { map[e.type] = (map[e.type] || 0) + e.value; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [invEntries]);

  const marketInsights = useMemo(() => buildInvestmentInsights({
    salaryNum,
    remaining,
    totalInvested,
    invGoal,
    spentPct,
    marketData,
  }), [salaryNum, remaining, totalInvested, invGoal, spentPct, marketData]);

  const marketCategories = useMemo(() => {
    const assets = marketData?.assets || [];
    const selic = findMarketAsset(marketData, "SELIC");
    const fixedIncome = selic ? [
      {
        symbol: "TESOURO_SELIC",
        label: "Tesouro Selic",
        kind: "Pós-fixado",
        category: "Renda fixa",
        risk: "Baixo",
        note: `Reserva e objetivos curtos. Referência atual: Selic ${fmtMarket(selic)}.`,
        price: selic.price,
        currency: "PERCENT",
      },
      {
        symbol: "CDB_CDI",
        label: "CDB 100%+ CDI",
        kind: "Liquidez diária",
        category: "Renda fixa",
        risk: "Baixo",
        note: "Boa opção para reserva quando tem liquidez diária e cobertura do FGC.",
        price: selic.price,
        currency: "PERCENT",
      },
      {
        symbol: "LCI_LCA",
        label: "LCI / LCA",
        kind: "Isento de IR",
        category: "Renda fixa",
        risk: "Baixo",
        note: "Compare prazo, liquidez e taxa equivalente ao CDI antes de aplicar.",
        price: selic.price,
        currency: "PERCENT",
      },
    ] : [];
    const groups = new Map();

    [...assets, ...fixedIncome].forEach((asset) => {
      const category = asset.category || "Outros";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(asset);
    });

    const order = ["Renda fixa", "Bolsa Brasil", "Fundos imobiliários", "Exterior", "Proteção", "Cripto", "Outros"];
    return order
      .filter((category) => groups.has(category))
      .map((category) => ({ category, assets: groups.get(category) }));
  }, [marketData]);

  const refreshMarketData = useCallback(async () => {
    const token = window.localStorage.getItem(TOKEN_KEY);

    setMarketLoading(true);
    setMarketError("");
    setMarketWarning("");

    try {
      if (STATIC_MODE) {
        setMarketData(buildStaticMarketData());
        setMarketWarning("No GitHub Pages, a IA de mercado usa dados educativos. Configure VITE_API_URL para cotações atuais.");
        return;
      }

      const data = await apiRequest("/api/market", { token: token || undefined, timeoutMs: 30000 });
      setMarketData(data);
      if (data.stale || (data.errors?.length > 0 && !data.assets?.length)) {
        setMarketWarning("Não consegui atualizar agora. Mantive os últimos dados carregados.");
      }
    } catch (error) {
      if (marketData) {
        setMarketWarning("Não consegui atualizar agora. Mantive os últimos dados carregados.");
      } else {
        setMarketError(error.message);
      }
    } finally {
      setMarketLoading(false);
    }
  }, [marketData]);

  const applyRemoteData = (data = {}, user = null) => {
    const nextName = data.userName || user?.name || "";
    const nextSalary = data.salary || "";

    setUserName(nextName);
    setNameInput(nextName);
    setSalary(nextSalary);
    setSalaryInput(nextSalary);
    setInvGoalPct(Number(data.invGoalPct) || 20);
    setExpenses(Array.isArray(data.expenses) ? data.expenses : []);
    setInvEntries(Array.isArray(data.invEntries) ? data.invEntries : []);
    setTab(validTab(data.tab));
    setSetupStep(validSetupStep(data.setupStep, Boolean(nextSalary)));
    setInvSubTab(validInvSubTab(data.invSubTab));
    setTheme(validTheme(data.theme || window.localStorage.getItem(THEME_KEY)));
  };

  const appData = useMemo(() => ({
    userName,
    salary,
    invGoalPct,
    expenses,
    invEntries,
    tab,
    setupStep,
    invSubTab,
    theme,
  }), [userName, salary, invGoalPct, expenses, invEntries, tab, setupStep, invSubTab, theme]);

  useEffect(() => {
    let cancelled = false;

    if (STATIC_MODE) {
      const record = getLocalSession();
      if (record) {
        const user = publicLocalUser(record);
        setAuthUser(user);
        applyRemoteData(record.data, user);
        setDataReady(true);
      }
      setAuthLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const token = window.localStorage.getItem(TOKEN_KEY);

    if (!token) {
      setAuthLoading(false);
      return;
    }

    apiRequest("/api/me", { token })
      .then(({ user, data }) => {
        if (cancelled) return;
        setAuthUser(user);
        applyRemoteData(data, user);
        setDataReady(true);
      })
      .catch(() => {
        window.localStorage.removeItem(TOKEN_KEY);
        if (!cancelled) {
          setAuthUser(null);
          setDataReady(false);
        }
      })
      .finally(() => {
        if (!cancelled) setAuthLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authUser || !dataReady || authLoading) return;

    if (STATIC_MODE) {
      const timeout = window.setTimeout(() => {
        setSaving(true);

        try {
          const users = readLocalUsers();
          const email = normalizeEmail(authUser.email);
          if (!users[email]) throw new Error("Sessão local não encontrada.");
          users[email] = {
            ...users[email],
            name: userName || authUser.name,
            data: appData,
          };
          writeLocalUsers(users);
          setSaveError("");
        } catch (error) {
          setSaveError(error.message);
        } finally {
          setSaving(false);
        }
      }, 350);

      return () => window.clearTimeout(timeout);
    }

    const token = window.localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    const timeout = window.setTimeout(async () => {
      setSaving(true);

      try {
        await apiRequest("/api/data", {
          method: "PUT",
          token,
          body: { data: appData },
        });
        setSaveError("");
      } catch (error) {
        setSaveError(error.message);
      } finally {
        setSaving(false);
      }
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [authUser, dataReady, authLoading, appData, userName]);

  useEffect(() => {
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (authUser && tab === "invest" && invSubTab === "ia" && !marketData && !marketLoading) {
      refreshMarketData();
    }
  }, [authUser, tab, invSubTab, marketData, marketLoading, refreshMarketData]);

  useEffect(() => {
    const thresholds = [50, 70, 85, 100];
    for (const t of thresholds) {
      if (prevPct < t && spentPct >= t) {
        setNotification(getAlert(t).msg);
        setTimeout(() => setNotification(null), 5000);
        break;
      }
    }
    setPrevPct(spentPct);
  }, [spentPct, prevPct]);

  const addExpense = () => {
    if (!form.desc || !form.value) return;
    setExpenses((p) => [...p, { ...form, id: Date.now(), value: parseFloat(form.value) }]);
    setForm((f) => ({ ...f, desc: "", value: "" }));
    setExpenseCategoryManual(false);
    setTab("home");
  };

  const addInvestment = () => {
    if (!invForm.label || !invForm.value) return;
    setInvEntries((p) => [...p, { ...invForm, id: Date.now(), value: parseFloat(invForm.value) }]);
    setInvForm((f) => ({ ...f, label: "", value: "" }));
  };

  const handleExpenseDescChange = (desc) => {
    const suggestedCategory = suggestExpenseCategory(desc);
    setForm((f) => ({
      ...f,
      desc,
      category: expenseCategoryManual ? f.category : (suggestedCategory || (desc.trim().length >= 3 ? "outros" : f.category)),
    }));
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthSubmitting(true);

    try {
      if (STATIC_MODE) {
        const email = normalizeEmail(authForm.email);
        const password = authForm.password;
        if (!email) throw new Error("Informe seu e-mail.");
        if (password.length < 6) throw new Error("A senha precisa ter pelo menos 6 caracteres.");

        const users = readLocalUsers();
        let record = users[email];

        if (authMode === "register") {
          const name = authForm.name.trim();
          if (!name) throw new Error("Informe seu nome.");
          if (record) throw new Error("Este e-mail já tem uma conta neste navegador.");

          const salt = makeSalt();
          record = {
            email,
            name,
            salt,
            passwordHash: await hashLocalPassword(password, salt),
            data: { userName: name, setupStep: "salary", theme },
          };
          users[email] = record;
          writeLocalUsers(users);
        } else {
          if (!record) throw new Error("Conta não encontrada neste navegador.");
          const passwordHash = await hashLocalPassword(password, record.salt);
          if (passwordHash !== record.passwordHash) throw new Error("E-mail ou senha inválidos.");
        }

        const user = publicLocalUser(record);
        window.localStorage.setItem(LOCAL_SESSION_KEY, email);
        setAuthUser(user);
        applyRemoteData(record.data, user);
        setDataReady(true);
        setAuthForm({ name: "", email: "", password: "" });
        return;
      }

      const path = authMode === "login" ? "/api/login" : "/api/register";
      const body = authMode === "login"
        ? { email: authForm.email, password: authForm.password }
        : { name: authForm.name, email: authForm.email, password: authForm.password };
      const { token, user, data } = await apiRequest(path, { method: "POST", body });

      window.localStorage.setItem(TOKEN_KEY, token);
      setAuthUser(user);
      applyRemoteData(data, user);
      setDataReady(true);
      setAuthForm({ name: "", email: "", password: "" });
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogout = async () => {
    if (STATIC_MODE) {
      window.localStorage.removeItem(LOCAL_SESSION_KEY);
      setAuthUser(null);
      setDataReady(false);
      setAuthMode("login");
      setAuthError("");
      return;
    }

    const token = window.localStorage.getItem(TOKEN_KEY);

    if (token) {
      await apiRequest("/api/logout", { method: "POST", token }).catch(() => {});
    }

    window.localStorage.removeItem(TOKEN_KEY);
    setAuthUser(null);
    setDataReady(false);
    setAuthMode("login");
    setAuthError("");
  };

  const isLight = theme === "light";
  const C = isLight
    ? {
        bg: "#eef4fb", card: "#ffffff", surface: "#f8fafc", soft: "#eaf2ff", border: "#c7d8ee",
        text: "#102033", muted: "#64748b", mutedStrong: "#475569", blue: "#2563eb", green: "#16a34a", red: "#dc2626",
        orange: "#ea580c", yellow: "#ca8a04", purple: "#7c3aed", track: "#dbe7f5", nav: "#ffffff",
        header: "linear-gradient(160deg,#eaf2ff 0%,#ffffff 100%)", shadow: "0 18px 45px #0f172a22",
        dangerBg: "#fee2e2", dangerBorder: "#fecaca", dangerText: "#991b1b",
        warnBg: "#fffbeb", warnBorder: "#f59e0b55", warnText: "#92400e",
        aiBg: "#e0f2fe", aiTitle: "#0369a1", aiText: "#075985", aiMuted: "#0284c7",
        learnBg: "#dcfce7", learnTitle: "#166534", learnText: "#15803d",
        specialBg: "#eff6ff", specialBorder: "#bfdbfe", disclaimerBg: "#f8fafc", navHighlight: "#eaf2ff",
      }
    : {
        bg: "#070d1a", card: "#0d1a2d", surface: "#050b15", soft: "#0a1929", border: "#1e3a5f",
        text: "#e2e8f0", muted: "#64748b", mutedStrong: "#94a3b8", blue: "#3b82f6", green: "#22c55e", red: "#f87171",
        orange: "#f97316", yellow: "#fbbf24", purple: "#a78bfa", track: "#1e293b", nav: "#070d1a",
        header: "linear-gradient(160deg,#0d1f3c 0%,#070d1a 100%)", shadow: "0 20px 40px #00000099",
        dangerBg: "#450a0a", dangerBorder: "#7f1d1d", dangerText: "#fecaca",
        warnBg: "#422006", warnBorder: "#92400e", warnText: "#fde68a",
        aiBg: "linear-gradient(135deg,#082f49,#0d1a2d)", aiTitle: "#38bdf8", aiText: "#bae6fd", aiMuted: "#7dd3fc",
        learnBg: "linear-gradient(135deg,#052e16,#064e3b)", learnTitle: "#34d399", learnText: "#6ee7b7",
        specialBg: "linear-gradient(135deg,#071a2e,#0d1a2d)", specialBorder: "#1e3a8a", disclaimerBg: "#0a0f1e", navHighlight: "#0d1a2d",
      };
  const base   = { fontFamily: "'DM Sans', sans-serif", fontSize: 14, color: C.text };
  const inp    = { width: "100%", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, color: C.text, padding: "13px 16px", fontSize: 15, outline: "none", fontFamily: "'DM Sans', sans-serif", boxSizing: "border-box" };
  const btnBlue= { background: "linear-gradient(135deg,#1d4ed8,#3b82f6)", color: "#fff", border: "none", borderRadius: 12, padding: "13px 24px", fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", width: "100%" };
  const card   = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 20, padding: 20, marginBottom: 14 };
  const lbl    = { fontSize: 12, color: C.muted, marginBottom: 6, display: "block", fontWeight: 600 };

  if (authLoading && !authUser) return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
      <div style={{ ...base, minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ color: C.muted, fontWeight: 700 }}>Carregando...</div>
      </div>
    </>
  );

  if (!authUser) return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
      <div style={{ ...base, minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 420, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{ fontSize: 42, marginBottom: 10 }}>💰</div>
            <div style={{ fontSize: 30, fontWeight: 900, color: C.text, lineHeight: 1.1 }}>Guardar<span style={{ color: C.blue }}>+</span></div>
            <div style={{ fontSize: 14, color: C.muted, marginTop: 8 }}>{STATIC_MODE ? "Entre para salvar seus dados neste navegador" : "Entre para salvar seus dados no banco"}</div>
          </div>

          <form onSubmit={handleAuthSubmit} style={card}>
            <div style={{ display: "flex", gap: 6, background: C.surface, borderRadius: 12, padding: 4, marginBottom: 18 }}>
              {[
                { id: "login", label: "Entrar" },
                { id: "register", label: "Criar conta" },
              ].map((mode) => (
                <button key={mode.id} type="button" disabled={authSubmitting} onClick={() => { setAuthMode(mode.id); setAuthError(""); }}
                  style={{ flex: 1, padding: "10px 0", border: "none", borderRadius: 9, cursor: "pointer", fontSize: 13, fontWeight: 800, background: authMode === mode.id ? C.blue : "transparent", color: authMode === mode.id ? "#fff" : C.muted, fontFamily: "'DM Sans', sans-serif" }}>
                  {mode.label}
                </button>
              ))}
            </div>

            {authMode === "register" && (
              <div style={{ marginBottom: 14 }}>
                <label style={lbl}>Nome</label>
                <input style={inp} disabled={authSubmitting} value={authForm.name} placeholder="Seu nome"
                  onChange={e => setAuthForm(f => ({ ...f, name: e.target.value }))} />
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={lbl}>E-mail</label>
              <input style={inp} disabled={authSubmitting} type="email" value={authForm.email} placeholder="voce@email.com"
                onChange={e => setAuthForm(f => ({ ...f, email: e.target.value }))} />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Senha</label>
              <input style={inp} disabled={authSubmitting} type="password" value={authForm.password} placeholder="Mínimo 6 caracteres"
                onChange={e => setAuthForm(f => ({ ...f, password: e.target.value }))} />
            </div>

            {authError && (
              <div style={{ background: C.dangerBg, border: `1px solid ${C.dangerBorder}`, color: C.dangerText, borderRadius: 12, padding: "10px 12px", fontSize: 13, marginBottom: 14 }}>
                {authError}
              </div>
            )}

            <button style={{ ...btnBlue, opacity: authSubmitting ? 0.75 : 1 }} disabled={authSubmitting} type="submit">
              {authSubmitting ? (authMode === "login" ? "Entrando..." : "Criando...") : (authMode === "login" ? "Entrar" : "Criar conta")}
            </button>
          </form>
        </div>
      </div>
    </>
  );

  // ── SETUP NAME ──
  if (setupStep === "name") return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
      <div style={{ ...base, minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 400, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div style={{ fontSize: 52, marginBottom: 12 }}>💰</div>
            <div style={{ fontSize: 28, fontWeight: 900, color: C.text, lineHeight: 1.2 }}>Guardar<span style={{ color: C.blue }}>+</span></div>
            <div style={{ fontSize: 14, color: C.muted, marginTop: 8 }}>Controle financeiro inteligente</div>
          </div>
          <div style={card}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>Qual é o seu nome?</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 18 }}>Vou personalizar tudo para você.</div>
            <label style={lbl}>Nome</label>
            <input style={inp} placeholder="Ex: João, Maria..." value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && nameInput.trim()) { setUserName(nameInput.trim()); setSetupStep("salary"); }}} />
            <div style={{ marginTop: 16 }}>
              <button style={btnBlue} onClick={() => { if (nameInput.trim()) { setUserName(nameInput.trim()); setSetupStep("salary"); }}}>Continuar →</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );

  // ── SETUP SALARY ──
  if (setupStep === "salary") return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
      <div style={{ ...base, minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 400, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{ fontSize: 28, fontWeight: 900, color: C.text }}>Olá, <span style={{ color: C.blue }}>{userName}</span>!</div>
            <div style={{ fontSize: 14, color: C.muted, marginTop: 6 }}>Agora me diga seu salário deste mês.</div>
          </div>
          <div style={card}>
            <label style={lbl}>Salário líquido (R$)</label>
            <input style={inp} type="number" placeholder="0.00" value={salaryInput}
              onChange={e => setSalaryInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && salaryInput) { setSalary(salaryInput); setSetupStep("done"); }}} />
            <div style={{ background: C.surface, borderRadius: 12, padding: 14, marginTop: 14, fontSize: 13, color: C.muted, lineHeight: 1.7 }}>
              💡 Coloque o valor que cai na sua conta, já descontado imposto e benefícios.
            </div>
            <div style={{ marginTop: 16 }}>
              <button style={btnBlue} onClick={() => { if (salaryInput) { setSalary(salaryInput); setSetupStep("done"); }}}>Começar meu controle →</button>
            </div>
            <button onClick={() => setSetupStep("name")} style={{ marginTop: 10, width: "100%", background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>← Voltar</button>
          </div>
        </div>
      </div>
    </>
  );

  // ── MAIN APP ──
  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
      <style>{`* { box-sizing: border-box; margin: 0; padding: 0; } input:focus { border-color: #3b82f6 !important; } @keyframes slideUp { from{opacity:0;transform:translateX(-50%) translateY(16px)} to{opacity:1;transform:translateX(-50%) translateY(0)} } @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }`}</style>

      <div style={{ ...base, minHeight: "100vh", background: C.bg, paddingBottom: 88 }}>

        {notification && (
          <div style={{ position: "fixed", bottom: 100, left: "50%", transform: "translateX(-50%)", background: C.soft, border: `1px solid ${C.border}`, borderRadius: 16, padding: "14px 20px", fontSize: 13, color: C.text, maxWidth: 340, width: "calc(100% - 40px)", boxShadow: C.shadow, zIndex: 999, textAlign: "center", lineHeight: 1.6, animation: "slideUp .3s ease" }}>
            {notification}
          </div>
        )}

        {/* Header */}
        <div style={{ background: C.header, padding: "28px 22px 20px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ maxWidth: 560, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>Olá, {userName} 👋</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: C.text, lineHeight: 1 }}>Guardar<span style={{ color: C.blue }}>+</span></div>
              <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>{authUser.email}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: C.muted }}>Salário</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{fmt(salaryNum)}</div>
              <div style={{ fontSize: 10, color: saveError ? C.red : C.muted, marginTop: 2 }}>
                {saveError ? "erro ao salvar" : saving ? "salvando..." : STATIC_MODE ? "salvo localmente" : "salvo no banco"}
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 3 }}>
                <button onClick={() => setTheme(isLight ? "dark" : "light")} title={isLight ? "Ativar modo escuro" : "Ativar modo claro"} style={{ fontSize: 10, color: C.blue, background: "none", border: "none", cursor: "pointer", fontFamily: "'DM Sans', sans-serif", fontWeight: 700 }}>
                  {isLight ? "🌙 escuro" : "☀️ claro"}
                </button>
                <button onClick={() => { setSalary(""); setSetupStep("salary"); setSalaryInput(""); }} style={{ fontSize: 10, color: C.muted, background: "none", border: "none", cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>✏️ editar</button>
                <button onClick={handleLogout} style={{ fontSize: 10, color: C.red, background: "none", border: "none", cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>sair</button>
              </div>
            </div>
          </div>
        </div>

        <div style={{ padding: "18px 18px 0", maxWidth: 560, margin: "0 auto" }}>

          {/* ── HOME ── */}
          {tab === "home" && (
            <div style={{ animation: "fadeIn .3s ease" }}>
              <div style={{ ...card, textAlign: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, marginBottom: 12 }}>Gastos vs. saldo disponível</div>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <Arc pct={Math.min(spentPct, 100)} size={190} trackColor={C.track} mutedColor={C.muted} />
                </div>
                <div style={{ background: alertColor + "15", border: `1px solid ${alertColor}33`, borderRadius: 12, padding: "11px 14px", fontSize: 13, color: alertColor, fontWeight: 500, lineHeight: 1.5, marginTop: 4 }}>
                  {alert.msg}
                </div>
              </div>

              {/* Stats */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                {[
                  { label: "Total gasto",      value: fmt(totalExpenses),           color: C.red   },
                  { label: "Saldo disponível", value: fmt(Math.max(remaining, 0)),  color: remaining >= 0 ? C.green : C.red },
                  { label: "Meta investimento",value: fmt(invGoal),                 color: C.blue  },
                  { label: "Já investido",     value: fmt(totalInvested),           color: C.purple },
                ].map((s) => (
                  <div key={s.label} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: "14px 16px" }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, fontWeight: 600 }}>{s.label}</div>
                    <div style={{ fontSize: 17, fontWeight: 800, color: s.color }}>{s.value}</div>
                  </div>
                ))}
              </div>

              {/* Investment goal mini */}
              <div style={{ ...card, background: C.specialBg, borderColor: C.specialBorder }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>📈 Meta de investimento</div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{invGoalPct}% do salário</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: C.blue }}>{fmt(invGoal)}</div>
                    <div style={{ fontSize: 11, color: invProgress >= 100 ? C.green : C.muted }}>
                      {invProgress >= 100 ? "✅ Meta batida!" : `${Math.round(invProgress)}% atingido`}
                    </div>
                  </div>
                </div>
                <div style={{ height: 8, background: C.surface, borderRadius: 999, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${invProgress}%`, background: invProgress >= 100 ? C.green : C.blue, borderRadius: 999, transition: "width .6s", boxShadow: `0 0 8px ${invProgress >= 100 ? C.green : C.blue}55` }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginTop: 6 }}>
                  <span>Investido: {fmt(totalInvested)}</span>
                  <span>Faltam: {fmt(Math.max(invGoal - totalInvested, 0))}</span>
                </div>
                <button onClick={() => setTab("invest")} style={{ marginTop: 12, width: "100%", background: "#1d4ed811", border: `1px solid ${C.blue}44`, borderRadius: 10, color: C.blue, fontSize: 13, fontWeight: 700, padding: "9px 0", cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>
                  Gerenciar investimentos →
                </button>
              </div>

              {/* Dica pessoal */}
              <div style={{ background: C.soft, border: `1px solid ${C.border}`, borderRadius: 16, padding: 16, marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 6 }}>💬 Dica para você, {userName}</div>
                <div style={{ fontSize: 13, color: C.mutedStrong, lineHeight: 1.7 }}>
                  {remaining > invGoal
                    ? `Você tem ${fmt(remaining - invGoal)} além da meta de investimento. Considere aportar mais em CDB ou Tesouro Direto!`
                    : remaining > 0
                    ? `Faltam ${fmt(invGoal - totalInvested)} para bater sua meta de investimento este mês. Veja se consegue cortar algum gasto.`
                    : `Seus gastos ultrapassaram o limite seguro. No próximo mês, tente reduzir ${fmt(Math.abs(remaining))} em gastos variáveis.`}
                </div>
              </div>

              {/* Últimos gastos */}
              {expenses.length > 0 && (
                <div style={card}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, marginBottom: 12 }}>Últimos gastos</div>
                  {expenses.slice(-4).reverse().map(e => (
                    <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: `1px solid ${C.soft}` }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, background: cat(e.category).color + "22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>{cat(e.category).icon}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{e.desc}</div>
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{cat(e.category).label} · {new Date(e.date).toLocaleDateString("pt-BR")}</div>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 800, color: C.red }}>-{fmt(e.value)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── GASTOS ── */}
          {tab === "expenses" && (
            <div style={{ animation: "fadeIn .3s ease" }}>
              <div style={card}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, marginBottom: 12 }}>Todos os gastos</div>
                {expenses.length === 0 && (
                  <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
                    <div style={{ fontSize: 40, marginBottom: 10 }}>🧾</div>
                    <div>Nenhum gasto lançado</div>
                  </div>
                )}
                {expenses.slice().reverse().map(e => (
                  <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: `1px solid ${C.soft}` }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: cat(e.category).color + "22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>{cat(e.category).icon}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{e.desc}</div>
                      <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{cat(e.category).label} · {new Date(e.date).toLocaleDateString("pt-BR")}</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: C.red }}>-{fmt(e.value)}</div>
                    <button onClick={() => setExpenses(p => p.filter(x => x.id !== e.id))} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, padding: "0 4px" }}>×</button>
                  </div>
                ))}
              </div>
              {byCategory.length > 0 && (
                <div style={card}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, marginBottom: 14 }}>Por categoria</div>
                  {byCategory.map(([id, val]) => (
                    <div key={id} style={{ marginBottom: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontSize: 13, color: C.mutedStrong }}>{cat(id).icon} {cat(id).label}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: cat(id).color }}>{fmt(val)}</span>
                      </div>
                      <div style={{ height: 6, background: C.surface, borderRadius: 999, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${(val / totalExpenses) * 100}%`, background: cat(id).color, borderRadius: 999, transition: "width .5s" }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── NOVO GASTO ── */}
          {tab === "add" && (
            <div style={{ animation: "fadeIn .3s ease" }}>
              <div style={card}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 18 }}>Registrar gasto</div>
                <div style={{ marginBottom: 14 }}>
                  <label style={lbl}>Descrição</label>
                  <input style={inp} placeholder="Ex: Mercado, Uber, Conta de luz..." value={form.desc} onChange={e => handleExpenseDescChange(e.target.value)} />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={lbl}>Valor (R$)</label>
                  <input style={inp} type="number" placeholder="0.00" value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={lbl}>Data</label>
                  <input style={inp} type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
                </div>
                <div style={{ marginBottom: 18 }}>
                  <label style={lbl}>Categoria</label>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                    {CATEGORIES.map(c => (
                      <button key={c.id} onClick={() => { setExpenseCategoryManual(true); setForm(f => ({ ...f, category: c.id })); }}
                        style={{ padding: "10px 4px", borderRadius: 12, border: `1px solid ${form.category === c.id ? c.color : C.border}`, background: form.category === c.id ? c.color + "22" : C.surface, cursor: "pointer", textAlign: "center", color: form.category === c.id ? c.color : C.muted, fontSize: 11, fontWeight: 600, transition: "all .15s", fontFamily: "'DM Sans', sans-serif" }}>
                        <div style={{ fontSize: 20, marginBottom: 3 }}>{c.icon}</div>
                        <div>{c.label}</div>
                      </button>
                    ))}
                  </div>
                </div>
                {form.value && parseFloat(form.value) > 0 && (
                  <div style={{ background: C.surface, borderRadius: 12, padding: 14, marginBottom: 16 }}>
                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 5, fontWeight: 600 }}>Impacto no saldo</div>
                    <div style={{ fontSize: 14, color: C.mutedStrong, lineHeight: 1.6 }}>
                      Saldo após este gasto:{" "}
                      <span style={{ fontWeight: 800, color: remaining - parseFloat(form.value || 0) >= 0 ? C.green : C.red }}>
                        {fmt(remaining - parseFloat(form.value || 0))}
                      </span>
                    </div>
                    {remaining - parseFloat(form.value || 0) < 0 && (
                      <div style={{ fontSize: 12, color: C.red, marginTop: 6 }}>⚠️ Este gasto ultrapassa seu limite!</div>
                    )}
                  </div>
                )}
                <button style={btnBlue} onClick={addExpense}>Registrar gasto</button>
              </div>
            </div>
          )}

          {/* ── INVESTIMENTOS ── */}
          {tab === "invest" && (
            <div style={{ animation: "fadeIn .3s ease" }}>

              {/* Sub-tabs */}
              <div style={{ display: "flex", gap: 4, background: C.card, borderRadius: 14, padding: 4, marginBottom: 16, border: `1px solid ${C.border}` }}>
                {[{ id: "ia", label: "IA Mercado" }, { id: "metas", label: "Minhas Metas" }, { id: "aprender", label: "Como Investir" }].map(t => (
                  <button key={t.id} onClick={() => setInvSubTab(t.id)}
                    style={{ flex: 1, padding: "10px 0", border: "none", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 700, background: invSubTab === t.id ? C.blue : "transparent", color: invSubTab === t.id ? "#fff" : C.muted, transition: "all .2s", fontFamily: "'DM Sans', sans-serif" }}>
                    {t.label}
                  </button>
                ))}
              </div>

              {/* ── METAS sub-tab ── */}
              {invSubTab === "metas" && (
                <>
                  {/* Meta config */}
                  <div style={{ ...card, background: C.specialBg, borderColor: C.specialBorder }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>🎯 Meta de investimento mensal</div>

                    <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
                      <MiniArc pct={invProgress} size={60} color={invProgress >= 100 ? C.green : C.blue} trackColor={C.track} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 22, fontWeight: 900, color: invProgress >= 100 ? C.green : C.blue }}>{fmt(invGoal)}</div>
                        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                          {invGoalPct}% do salário · Investido: {fmt(totalInvested)}
                        </div>
                        <div style={{ fontSize: 12, color: invProgress >= 100 ? C.green : C.muted, marginTop: 2, fontWeight: 600 }}>
                          {invProgress >= 100 ? "✅ Meta batida este mês!" : `Faltam ${fmt(Math.max(invGoal - totalInvested, 0))}`}
                        </div>
                      </div>
                    </div>

                    <label style={{ ...lbl, marginBottom: 4 }}>Ajustar meta: {invGoalPct}% do salário</label>
                    <input type="range" min={5} max={50} step={5} value={invGoalPct}
                      onChange={e => setInvGoalPct(Number(e.target.value))}
                      style={{ width: "100%", accentColor: C.blue, cursor: "pointer" }} />
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginTop: 3 }}>
                      <span>5%</span><span>50%</span>
                    </div>
                    <div style={{ marginTop: 12, height: 8, background: C.surface, borderRadius: 999, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${invProgress}%`, background: invProgress >= 100 ? C.green : C.blue, borderRadius: 999, transition: "width .6s", boxShadow: `0 0 8px ${C.blue}55` }} />
                    </div>
                  </div>

                  {/* Registrar aporte */}
                  <div style={card}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 16 }}>➕ Registrar aporte</div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={lbl}>Descrição</label>
                      <input style={inp} placeholder="Ex: CDB Nubank, Tesouro Selic..." value={invForm.label} onChange={e => setInvForm(f => ({ ...f, label: e.target.value }))} />
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={lbl}>Valor (R$)</label>
                      <input style={inp} type="number" placeholder="0.00" value={invForm.value} onChange={e => setInvForm(f => ({ ...f, value: e.target.value }))} />
                    </div>
                    <div style={{ marginBottom: 14 }}>
                      <label style={lbl}>Tipo de investimento</label>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                        {INV_TYPES.map(t => (
                          <button key={t.id} onClick={() => setInvForm(f => ({ ...f, type: t.id }))}
                            style={{ padding: "9px 4px", borderRadius: 12, border: `1px solid ${invForm.type === t.id ? t.color : C.border}`, background: invForm.type === t.id ? t.color + "22" : C.surface, cursor: "pointer", textAlign: "center", color: invForm.type === t.id ? t.color : C.muted, fontSize: 10, fontWeight: 600, transition: "all .15s", fontFamily: "'DM Sans', sans-serif" }}>
                            <div style={{ fontSize: 18, marginBottom: 2 }}>{t.icon}</div>
                            <div style={{ lineHeight: 1.2 }}>{t.label}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={lbl}>Data</label>
                      <input style={inp} type="date" value={invForm.date} onChange={e => setInvForm(f => ({ ...f, date: e.target.value }))} />
                    </div>
                    <button style={btnBlue} onClick={addInvestment}>Registrar aporte</button>
                  </div>

                  {/* Histórico */}
                  {invEntries.length > 0 && (
                    <div style={card}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, marginBottom: 12 }}>Histórico de aportes</div>
                      {invEntries.slice().reverse().map(e => {
                        const t = invType(e.type);
                        return (
                          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: `1px solid ${C.soft}` }}>
                            <div style={{ width: 36, height: 36, borderRadius: 10, background: t.color + "22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>{t.icon}</div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 14, fontWeight: 600 }}>{e.label}</div>
                              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{t.label} · {new Date(e.date).toLocaleDateString("pt-BR")}</div>
                            </div>
                            <div style={{ fontSize: 14, fontWeight: 800, color: C.green }}>+{fmt(e.value)}</div>
                            <button onClick={() => setInvEntries(p => p.filter(x => x.id !== e.id))} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, padding: "0 4px" }}>×</button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Por tipo */}
                  {byInvType.length > 0 && (
                    <div style={card}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, marginBottom: 14 }}>Distribuição por tipo</div>
                      {byInvType.map(([id, val]) => {
                        const t = invType(id);
                        return (
                          <div key={id} style={{ marginBottom: 14 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                              <span style={{ fontSize: 13, color: C.mutedStrong }}>{t.icon} {t.label}</span>
                              <span style={{ fontSize: 13, fontWeight: 700, color: t.color }}>{fmt(val)}</span>
                            </div>
                            <div style={{ height: 6, background: C.surface, borderRadius: 999, overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${(val / totalInvested) * 100}%`, background: t.color, borderRadius: 999, transition: "width .5s" }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {/* ── APRENDER sub-tab ── */}
              {invSubTab === "ia" && (
                <>
                  <div style={{ ...card, background: C.aiBg, borderColor: "#0ea5e944" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 10 }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: C.aiTitle, marginBottom: 4 }}>IA de investimentos</div>
                        <div style={{ fontSize: 13, color: C.aiText, lineHeight: 1.6 }}>
                          Cotações atuais, leitura do seu orçamento e sinais para decidir com mais calma.
                        </div>
                      </div>
                      <button onClick={refreshMarketData} disabled={marketLoading}
                        style={{ background: marketLoading ? C.track : C.blue, color: marketLoading && isLight ? C.mutedStrong : "#fff", border: "none", borderRadius: 10, padding: "10px 12px", fontWeight: 800, fontSize: 12, cursor: marketLoading ? "default" : "pointer", fontFamily: "'DM Sans', sans-serif", whiteSpace: "nowrap" }}>
                        {marketLoading ? "Atualizando..." : "Atualizar"}
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: C.aiMuted, lineHeight: 1.6 }}>
                      {marketData?.updatedAt ? `Atualizado em ${new Date(marketData.updatedAt).toLocaleString("pt-BR")}` : "Abra esta aba para buscar os dados de mercado."}
                    </div>
                    {marketError && (
                      <div style={{ marginTop: 12, background: C.dangerBg, border: `1px solid ${C.dangerBorder}`, color: C.dangerText, borderRadius: 10, padding: "10px 12px", fontSize: 12, lineHeight: 1.5 }}>
                        {marketError}
                      </div>
                    )}
                    {marketWarning && (
                      <div style={{ marginTop: 12, background: C.warnBg, border: `1px solid ${C.warnBorder}`, color: C.warnText, borderRadius: 10, padding: "10px 12px", fontSize: 12, lineHeight: 1.5 }}>
                        {marketWarning}
                      </div>
                    )}
                  </div>

                  {marketLoading && !marketData && (
                    <div style={card}>
                      <div style={{ fontSize: 13, color: C.muted, fontWeight: 700 }}>Buscando mercado...</div>
                    </div>
                  )}

                  {marketData && (
                    <>
                      <div style={card}>
                        <div style={{ fontSize: 13, fontWeight: 800, color: C.muted, marginBottom: 14 }}>Mercado por categoria</div>
                        {marketCategories.map((group) => (
                          <div key={group.category} style={{ marginBottom: 16 }}>
                            <div style={{ fontSize: 12, fontWeight: 900, color: C.text, marginBottom: 8 }}>{group.category}</div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                              {group.assets.map((asset) => {
                                const positive = (asset.changePct || 0) >= 0;
                                const changeColor = positive ? C.green : C.red;
                                return (
                                  <div key={asset.symbol} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, minHeight: 124 }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                                      <div style={{ fontSize: 12, fontWeight: 800, color: C.text }}>{asset.label}</div>
                                      <div style={{ fontSize: 10, color: C.muted }}>{asset.kind}</div>
                                    </div>
                                    <div style={{ fontSize: 17, fontWeight: 900, color: C.text, marginBottom: 3 }}>{fmtMarket(asset)}</div>
                                    {asset.symbol !== "SELIC" && !asset.symbol.includes("_") && (
                                      <div style={{ fontSize: 12, color: changeColor, fontWeight: 800, marginBottom: 6 }}>{fmtPercent(asset.changePct)}</div>
                                    )}
                                    <div style={{ fontSize: 10, color: asset.risk === "Muito alto" ? C.red : asset.risk === "Alto" ? C.orange : asset.risk === "Médio" ? C.yellow : C.green, fontWeight: 800, marginBottom: 5 }}>
                                      Risco: {asset.risk || "Variável"}
                                    </div>
                                    <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.45 }}>{asset.note}</div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                        {marketData.errors?.length > 0 && (
                          <div style={{ fontSize: 11, color: C.muted, marginTop: 12, lineHeight: 1.5 }}>
                            Alguns ativos podem não aparecer se a fonte estiver fora do ar ou limitando consultas.
                          </div>
                        )}
                      </div>

                      <div style={card}>
                        <div style={{ fontSize: 13, fontWeight: 800, color: C.muted, marginBottom: 14 }}>Leitura da IA</div>
                        {marketInsights.map((tip) => {
                          const toneColor = tip.tone === "red" ? C.red : tip.tone === "orange" ? C.orange : tip.tone === "green" ? C.green : C.blue;
                          return (
                            <div key={tip.title} style={{ borderLeft: `3px solid ${toneColor}`, background: toneColor + "12", borderRadius: 10, padding: "11px 12px", marginBottom: 10 }}>
                              <div style={{ fontSize: 13, fontWeight: 800, color: toneColor, marginBottom: 4 }}>{tip.title}</div>
                              <div style={{ fontSize: 12, color: C.mutedStrong, lineHeight: 1.6 }}>{tip.body}</div>
                            </div>
                          );
                        })}
                      </div>

                      <div style={{ ...card, background: C.disclaimerBg, border: `1px solid ${C.border}` }}>
                        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
                          A IA usa regras educativas e dados públicos que podem ter atraso. Não é recomendação individual de investimento nem promessa de rentabilidade.
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}

              {invSubTab === "aprender" && (
                <>
                  <div style={{ ...card, background: C.learnBg, border: `1px solid ${C.green}44` }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.learnTitle, marginBottom: 6 }}>💡 Siga esta ordem, {userName}</div>
                    <div style={{ fontSize: 13, color: C.learnText, lineHeight: 1.7 }}>
                      Não pule etapas — cada bloco depende do anterior. Comece pela reserva de emergência antes de qualquer outra coisa.
                    </div>
                  </div>

                  {LEARN.map((inv) => (
                    <div key={inv.id} style={{ ...card, padding: 0, overflow: "hidden" }}>
                      <button onClick={() => setExpandedLearn(expandedLearn === inv.id ? null : inv.id)}
                        style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "16px 18px", textAlign: "left", fontFamily: "'DM Sans', sans-serif" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <div style={{ width: 42, height: 42, borderRadius: 12, background: inv.color + "22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{inv.icon}</div>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{inv.name}</span>
                              <span style={{ fontSize: 10, fontWeight: 700, color: inv.tagColor, background: inv.tagColor + "22", borderRadius: 6, padding: "2px 7px" }}>{inv.tag}</span>
                            </div>
                            <div style={{ display: "flex", gap: 12 }}>
                              <span style={{ fontSize: 12, color: inv.riskColor, fontWeight: 600 }}>● {inv.risk}</span>
                              <span style={{ fontSize: 12, color: C.muted }}>Liquidez: {inv.liquidity}</span>
                            </div>
                          </div>
                          <div style={{ fontSize: 18, color: C.muted, transition: "transform .2s", transform: expandedLearn === inv.id ? "rotate(180deg)" : "rotate(0deg)" }}>⌄</div>
                        </div>
                      </button>

                      {expandedLearn === inv.id && (
                        <div style={{ padding: "0 18px 18px", animation: "fadeIn .2s ease" }}>
                          <div style={{ height: 1, background: C.border, marginBottom: 14 }} />
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                            <div style={{ background: C.surface, borderRadius: 10, padding: "10px 12px" }}>
                              <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>Onde investir</div>
                              <div style={{ fontSize: 12, color: C.text, fontWeight: 600, lineHeight: 1.5 }}>{inv.where}</div>
                            </div>
                            <div style={{ background: C.surface, borderRadius: 10, padding: "10px 12px" }}>
                              <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>Mínimo</div>
                              <div style={{ fontSize: 13, color: inv.color, fontWeight: 700 }}>{inv.minValue}</div>
                              <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Objetivo</div>
                              <div style={{ fontSize: 12, color: C.text, fontWeight: 600, lineHeight: 1.4, marginTop: 2 }}>{inv.goal}</div>
                            </div>
                          </div>
                          <div style={{ background: inv.color + "11", border: `1px solid ${inv.color}33`, borderRadius: 10, padding: "11px 13px", marginBottom: 14 }}>
                            <div style={{ fontSize: 12, color: inv.color, fontWeight: 700, marginBottom: 4 }}>Dica importante</div>
                            <div style={{ fontSize: 13, color: C.mutedStrong, lineHeight: 1.6 }}>{inv.tip}</div>
                          </div>
                          <div style={{ fontSize: 12, color: C.muted, fontWeight: 700, marginBottom: 8 }}>Como começar</div>
                          {inv.steps.map((step, si) => (
                            <div key={si} style={{ display: "flex", gap: 10, marginBottom: 8, alignItems: "flex-start" }}>
                              <div style={{ width: 20, height: 20, borderRadius: "50%", background: inv.color + "33", color: inv.color, fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>{si + 1}</div>
                              <div style={{ fontSize: 13, color: C.mutedStrong, lineHeight: 1.6 }}>{step}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}

                  <div style={{ ...card, background: C.disclaimerBg, border: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
                      ⚠️ As informações são educativas e não constituem recomendação de investimento. Consulte um assessor certificado (CEA/CFP) para decisões personalizadas.
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Bottom Nav */}
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.nav, borderTop: `1px solid ${C.border}`, display: "flex", padding: "8px 8px 16px", boxShadow: isLight ? "0 -10px 30px #0f172a12" : "none" }}>
          {[
            { id: "home",     icon: "🏠", label: "Início"    },
            { id: "expenses", icon: "📋", label: "Gastos"    },
            { id: "add",      icon: "➕", label: "Novo",  highlight: true },
            { id: "invest",   icon: "📈", label: "Investir"  },
          ].map(n => (
            <button key={n.id} onClick={() => setTab(n.id)}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, border: "none", borderRadius: 14, padding: "8px 0", cursor: "pointer", fontFamily: "'DM Sans', sans-serif", transition: "all .2s", background: n.highlight && tab === "add" ? "linear-gradient(135deg,#1d4ed8,#3b82f6)" : n.highlight ? C.navHighlight : "none", color: tab === n.id ? (n.highlight ? "#fff" : C.blue) : C.muted, fontSize: 10, fontWeight: 700 }}>
              <span style={{ fontSize: 20 }}>{n.icon}</span>
              {n.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
