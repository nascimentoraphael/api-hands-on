const express = require("express");
const https   = require("https");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3001;

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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CNPJVerificador/1.0)",
        "Accept": "application/json",
      }
    }, (res) => {
      // Segue redirect manualmente se necessário
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout após 12s")); });
  });
}

// ─── Rota /api/cnpj/:cnpj ────────────────────────────────────────────────────
// Prefixo /api/ para não colidir com arquivos estáticos

app.get("/api/cnpj/:cnpj", async (req, res) => {
  const cnpj = normalizeCnpj(req.params.cnpj);

  if (cnpj.length !== 14)  return res.status(400).json({ error: "CNPJ deve ter 14 dígitos." });
  if (!validateCnpj(cnpj)) return res.status(400).json({ error: "CNPJ com dígitos verificadores inválidos." });

  let response;
  try {
    response = await httpsGet(`https://publica.cnpj.ws/cnpj/${cnpj}`);
  } catch (err) {
    return res.status(502).json({ error: "Falha ao contatar a API de CNPJ: " + err.message });
  }

  if (response.status === 429) {
    return res.status(429).json({ error: "Limite da API atingido (3 req/min). Aguarde 1 minuto e tente novamente." });
  }
  if (response.status === 404) {
    return res.status(404).json({ error: "CNPJ não encontrado na base da Receita Federal." });
  }
  if (response.status !== 200) {
    return res.status(502).json({ error: `API retornou status ${response.status}.` });
  }

  let raw;
  try {
    raw = JSON.parse(response.body);
  } catch {
    return res.status(502).json({ error: "Resposta inválida da API de CNPJ (JSON malformado)." });
  }

  const est = raw.estabelecimento ?? {};

  const situacao = est.situacao_cadastral ?? "";
  const isAtivo  = situacao.toLowerCase() === "ativa";

  // publica.cnpj.ws usa "atividade_principal" e "atividades_secundarias"
  const cnaeP = est.atividade_principal
    ? String(est.atividade_principal.subclasse ?? est.atividade_principal.id ?? est.atividade_principal)
    : "";

  const cnaeS = Array.isArray(est.atividades_secundarias)
    ? est.atividades_secundarias.map(c => String(c.subclasse ?? c.id ?? c))
    : [];

  const cnaePDesc = est.atividade_principal?.descricao ?? "";

  const cnaesFull = [
    ...(cnaeP ? [{
      codigo:          getCnaeDigits(cnaeP),
      codigoFormatado: cnaeP,
      descricao:       cnaePDesc,
      tipo:            "principal",
    }] : []),
    ...(Array.isArray(est.atividades_secundarias)
      ? est.atividades_secundarias.map(c => {
          const fmt = String(c.subclasse ?? c.id ?? c);
          return {
            codigo:          getCnaeDigits(fmt),
            codigoFormatado: fmt,
            descricao:       String(c.descricao ?? ""),
            tipo:            "secundario",
          };
        })
      : []),
  ];

  const analysis = analyzeCnaes(cnaeP, cnaeS);

  const result = {
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
    cnaeP,
    cnaeS,
    cnaePDesc,
    cnaesFull,
    telefone1:  est.ddd1 && est.telefone1 ? `(${est.ddd1}) ${est.telefone1}` : "",
    telefone2:  est.ddd2 && est.telefone2 ? `(${est.ddd2}) ${est.telefone2}` : "",
    email:      est.email ?? "",
    ...analysis,
    jaParticipou: false, // definido pelo frontend ao cruzar com histórico
  };

  result.eligibility = getEligibility(result);

  return res.json(result);
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/api/health", (_, res) => res.json({ ok: true }));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅  Servidor rodando em http://localhost:${PORT}`);
  console.log(`   Abra http://localhost:${PORT} no navegador\n`);
});
