# Verificador de Elegibilidade SENAI — Cadeia Automotiva

## Requisitos

- Node.js 18+

## Setup (uma vez)

```bash
cd backend
npm install
```

## Rodando

```bash
cd backend
node server.js
```

Depois abra **http://localhost:3001** no navegador.

> ⚠️ Não abra o `index.html` diretamente no browser — abra pelo servidor.
> O frontend é servido automaticamente pelo backend.

## Estrutura

```
cnpj-verificador/
├── backend/
│   ├── package.json
│   └── server.js     ← Express: serve o frontend + proxy para cnpj.ws
└── frontend/
    └── index.html    ← UI (servida pelo backend em /)
```

## Critérios verificados automaticamente

| Critério | Fonte |
|---|---|
| Situação cadastral ativa | publica.cnpj.ws (Receita Federal) |
| CNAE industrial (seções B–D, prefixos 05–33) | idem |
| Isenção de comprovação (27.22, 29.3, 29.4) | idem |
| Bloqueio Hands-on (28.3, 28.5, 29.1, 29.2) | idem |
| Participação em chamadas anteriores | Planilha .xlsx carregada pelo usuário |

**Não verificável automaticamente:** existência de planta industrial e documentos da cadeia automotiva.

## Limite da API

`publica.cnpj.ws` aceita 3 req/min na versão gratuita. O servidor retorna mensagem clara ao atingir o limite.
