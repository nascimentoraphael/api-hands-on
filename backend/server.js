require("dotenv").config();
const express  = require("express");
const https    = require("https");
const path     = require("path");
const Database = require("better-sqlite3");

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Cache SQLite ─────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

const db = new Database(path.join(__dirname, "cnpj_cache.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS cnpj_cache (
    cnpj       TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )
`);

const stmtGet    = db.prepare("SELECT data, fetched_at FROM cnpj_cache WHERE cnpj = ?");
const stmtUpsert = db.prepare(`
  INSERT INTO cnpj_cache (cnpj, data, fetched_at)
  VALUES (?, ?, ?)
  ON CONFLICT(cnpj) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at
`);

function cacheGet(cnpj) {
  const row = stmtGet.get(cnpj);
  if (!row) return null;
  if (Date.now() - row.fetched_at > CACHE_TTL_MS) return null; // expirado
  return JSON.parse(row.data);
}

function cacheSet(cnpj, data) {
  stmtUpsert.run(cnpj, JSON.stringify(data), Date.now());
}

// Serve o frontend estático — elimina o problema file:// vs http://
app.use(express.static(path.join(__dirname, "..", "frontend")));
app.use(express.json());

// ─── Constantes ──────────────────────────────────────────────────────────────

const CNAE_INDUSTRIAL_PREFIXES = [
  "05","06","07","08","09",
  "10","11","12","13","14","15","16","17","18","19",
  "20","21","22","23","24","25","26","27","28","29",
  "30","31","32","33",
];
const CNAE_AUTOMOTIVE_EXEMPT  = ["2722","293","294"];
const CNAE_AUTOMOTIVE_CHAIN   = ["2722","283","285","291","292","293","294"];
const CNAE_HANDSON_BLOCKED    = ["283","285","291","292"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeCnpj(raw) {
  return String(raw).replace(/\D/g, "");
}

function validateCnpj(cnpj) {
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
  const calc = (cn, w) => {
    let s = 0;
    for (let i = 0; i < w.length; i++) s += parseInt(cn[i]) * w[i];
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return (
    parseInt(cnpj[12]) === calc(cnpj, [5,4,3,2,9,8,7,6,5,4,3,2]) &&
    parseInt(cnpj[13]) === calc(cnpj, [6,5,4,3,2,9,8,7,6,5,4,3,2])
  );
}

function getCnaeDigits(raw) {
  return String(raw).replace(/\D/g, "").substring(0, 7);
}

function isIndustrial(digits) {
  return CNAE_INDUSTRIAL_PREFIXES.includes(digits.substring(0, 2));
}

function matchesGroup(digits, groups) {
  return groups.some(g => digits.startsWith(g));
}

function analyzeCnaes(principal, secundarios) {
  const all = [principal, ...secundarios].filter(Boolean).map(getCnaeDigits);
  return {
    allCnaes:            all,
    industrialCnaes:     all.filter(isIndustrial),
    hasIndustrial:       all.some(isIndustrial),
    isExempt:            all.some(d => matchesGroup(d, CNAE_AUTOMOTIVE_EXEMPT)),
    isInAutomotiveChain: all.some(d => matchesGroup(d, CNAE_AUTOMOTIVE_CHAIN)),
    isHandsOnBlocked:    all.some(d => matchesGroup(d, CNAE_HANDSON_BLOCKED)),
  };
}

function getEligibility({ isAtivo, hasIndustrial, isExempt, isInAutomotiveChain, isHandsOnBlocked, jaParticipou }) {
  if (!isAtivo)            return { status: "ineligible", label: "Não elegível",           reason: "Empresa com situação cadastral inativa." };
  if (!hasIndustrial)      return { status: "ineligible", label: "Não elegível",           reason: "Nenhum CNAE industrial (seções B, C ou D) identificado." };
  if (jaParticipou)        return { status: "ineligible", label: "Não elegível",           reason: "CNPJ já participou de chamada anterior." };
  if (isHandsOnBlocked)    return { status: "restricted", label: "Elegível com restrição", reason: "Elegível para consultoria, mas BLOQUEADA para o eixo Hands-on (CNAEs 28.3, 28.5, 29.1 ou 29.2). Exige carta de comprovação de fornecimento." };
  if (isExempt)            return { status: "eligible",   label: "Elegível",               reason: "Isenta de comprovação da cadeia automotiva (CNAE 27.22, 29.3 ou 29.4)." };
  if (isInAutomotiveChain) return { status: "restricted", label: "Elegível com restrição", reason: "Exige comprovação de participação na cadeia automotiva (carta de OEM, associação ou autodeclaração com NFs)." };
  return { status: "ineligible", label: "Não elegível", reason: "Nenhum CNAE automotivo identificado. Exige comprovação documental." };
}

// ─── Fetch nativo (sem node-fetch) ───────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CNPJVerificador/1.0)",
        "Accept": "application/json",
        ...headers,
      }
    }, (res) => {
      // Segue redirect manualmente se necessário
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout após 12s")); });
  });
}

// ─── Parsers por fonte ────────────────────────────────────────────────────────

function parseFromCnpjWs(cnpj, raw) {
  const est = raw.estabelecimento ?? {};

  const situacao = est.situacao_cadastral ?? "";
  const isAtivo  = situacao.toLowerCase() === "ativa";

  const cnaeP = est.atividade_principal
    ? String(est.atividade_principal.subclasse ?? est.atividade_principal.id ?? est.atividade_principal)
    : "";
  const cnaeS = Array.isArray(est.atividades_secundarias)
    ? est.atividades_secundarias.map(c => String(c.subclasse ?? c.id ?? c))
    : [];
  const cnaePDesc = est.atividade_principal?.descricao ?? "";

  const cnaesFull = [
    ...(cnaeP ? [{ codigo: getCnaeDigits(cnaeP), codigoFormatado: cnaeP, descricao: cnaePDesc, tipo: "principal" }] : []),
    ...(Array.isArray(est.atividades_secundarias)
      ? est.atividades_secundarias.map(c => {
          const fmt = String(c.subclasse ?? c.id ?? c);
          return { codigo: getCnaeDigits(fmt), codigoFormatado: fmt, descricao: String(c.descricao ?? ""), tipo: "secundario" };
        })
      : []),
  ];

  return {
    cnpj,
    cnpjFormatado:    cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5"),
    razaoSocial:      raw.razao_social ?? "",
    nomeFantasia:     est.nome_fantasia ?? "",
    situacao,
    isAtivo,
    municipio:        est.cidade?.nome  ?? est.municipio ?? "",
    uf:               est.estado?.sigla ?? est.uf ?? "",
    abertura:         est.data_inicio_atividade ?? "",
    porte:            raw.porte?.descricao ?? raw.porte ?? "",
    naturezaJuridica: raw.natureza_juridica?.descricao ?? raw.natureza_juridica ?? "",
    cnaeP, cnaeS, cnaePDesc, cnaesFull,
    telefone1: est.ddd1 && est.telefone1 ? `(${est.ddd1}) ${est.telefone1}` : "",
    telefone2: est.ddd2 && est.telefone2 ? `(${est.ddd2}) ${est.telefone2}` : "",
    email:     est.email ?? "",
  };
}

function parseFromBrasilApi(cnpj, raw) {
  const situacao = raw.descricao_situacao_cadastral ?? "";
  const isAtivo  = situacao.toUpperCase() === "ATIVA";

  const cnaeP     = raw.cnae_fiscal ? String(raw.cnae_fiscal) : "";
  const cnaePDesc = raw.cnae_fiscal_descricao ?? "";
  const cnaeS     = Array.isArray(raw.cnaes_secundarios)
    ? raw.cnaes_secundarios.map(c => String(c.codigo))
    : [];

  const cnaesFull = [
    ...(cnaeP ? [{ codigo: getCnaeDigits(cnaeP), codigoFormatado: cnaeP, descricao: cnaePDesc, tipo: "principal" }] : []),
    ...(Array.isArray(raw.cnaes_secundarios)
      ? raw.cnaes_secundarios.map(c => ({
          codigo: getCnaeDigits(String(c.codigo)), codigoFormatado: String(c.codigo),
          descricao: c.descricao ?? "", tipo: "secundario",
        }))
      : []),
  ];

  const tel1 = raw.ddd_telefone_1 ? raw.ddd_telefone_1.replace(/^(\d{2})(\d+)$/, "($1) $2") : "";
  const tel2 = raw.ddd_telefone_2 ? raw.ddd_telefone_2.replace(/^(\d{2})(\d+)$/, "($1) $2") : "";

  return {
    cnpj,
    cnpjFormatado:    cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5"),
    razaoSocial:      raw.razao_social ?? "",
    nomeFantasia:     raw.nome_fantasia ?? "",
    situacao,
    isAtivo,
    municipio:        raw.municipio ?? "",
    uf:               raw.uf ?? "",
    abertura:         raw.data_inicio_atividade ?? "",
    porte:            raw.porte ?? "",
    naturezaJuridica: raw.descricao_natureza_juridica ?? raw.natureza_juridica ?? "",
    cnaeP, cnaeS, cnaePDesc, cnaesFull,
    telefone1: tel1,
    telefone2: tel2,
    email:     raw.email ?? "",
  };
}

// ─── Rota /api/cnpj/:cnpj ────────────────────────────────────────────────────

app.get("/api/cnpj/:cnpj", async (req, res) => {
  const cnpj = normalizeCnpj(req.params.cnpj);

  if (cnpj.length !== 14)  return res.status(400).json({ error: "CNPJ deve ter 14 dígitos." });
  if (!validateCnpj(cnpj)) return res.status(400).json({ error: "CNPJ com dígitos verificadores inválidos." });

  const cached = cacheGet(cnpj);
  if (cached) return res.json({ ...cached, fromCache: true });

  // ── Tentativa 1: api.cnpj.ws (autenticada) ────────────────────────────────
  let parsed = null;

  try {
    const apiKey = process.env.CNPJ_WS_API_KEY;
    const headers = { "Accept": "application/json", "User-Agent": "Mozilla/5.0 (compatible; CNPJVerificador/1.0)" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const url = apiKey ? `https://api.cnpj.ws/cnpj/v1/${cnpj}` : `https://publica.cnpj.ws/cnpj/${cnpj}`;
    const r = await httpsGet(url, headers);
    if (r.status === 200) {
      parsed = parseFromCnpjWs(cnpj, JSON.parse(r.body));
    } else if (r.status === 404) {
      return res.status(404).json({ error: "CNPJ não encontrado na base da Receita Federal." });
    }
    // 429 ou outro erro: cai para o fallback
  } catch (_) { /* cai para o fallback */ }

  // ── Tentativa 2: BrasilAPI (fallback) ─────────────────────────────────────
  if (!parsed) {
    try {
      const r = await httpsGet(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
      if (r.status === 200) {
        parsed = parseFromBrasilApi(cnpj, JSON.parse(r.body));
      } else if (r.status === 404) {
        return res.status(404).json({ error: "CNPJ não encontrado na base da Receita Federal." });
      } else {
        return res.status(502).json({ error: "Ambas as APIs estão indisponíveis no momento. Tente novamente em instantes." });
      }
    } catch (err) {
      return res.status(502).json({ error: "Falha ao contatar as APIs de CNPJ: " + err.message });
    }
  }

  const analysis = analyzeCnaes(parsed.cnaeP, parsed.cnaeS);
  const result   = { ...parsed, ...analysis, jaParticipou: false };
  result.eligibility = getEligibility(result);

  cacheSet(cnpj, result);

  return res.json({ ...result, fromCache: false });
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/api/health", (_, res) => res.json({ ok: true }));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅  Servidor rodando em http://localhost:${PORT}`);
  console.log(`   Abra http://localhost:${PORT} no navegador\n`);
});
