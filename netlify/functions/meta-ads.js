// /.netlify/functions/meta-ads
// Integração com a Meta Marketing API (Facebook/Instagram Ads) para o MATRIX.
//
// O token de acesso é enviado pelo cliente via POST (no corpo da requisição),
// nunca em variável de ambiente fixa — isso permite que o MATRIX gerencie
// múltiplas contas de anúncios (de pessoas/clientes diferentes), cada uma com
// seu próprio token, em vez de um único token global.
//
// Ações suportadas (body.action):
//   contas             -> lista as contas de anúncios disponíveis para o token enviado
//   insights            -> retorna investimento/leads/cliques/CTR/CPC/impressões/alcance por dia (nível conta, geral)
//   insights_por_adset  -> mesma coisa, mas quebrado por conjunto de anúncios (nome incluído),
//                          usado para atribuir investimento a atendentes pelo nome do adset
//
// Exemplos de uso a partir do MATRIX (sempre POST, nunca GET, para não expor o token na URL):
//   POST { action: "contas", token: "EAAxxx..." }
//   POST { action: "insights", token: "EAAxxx...", account: "act_123", inicio: "2026-06-01", fim: "2026-06-26" }
//   POST { action: "insights_por_adset", token: "EAAxxx...", account: "act_123", inicio: "...", fim: "..." }

const GRAPH_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// action_type da Graph API que representamos como "Leads" no MATRIX.
// Campanhas de Engajamento (OUTCOME_ENGAGEMENT) com objetivo de mensagem reportam
// o resultado como "Conversas por mensagem" no Gerenciador de Anúncios, que corresponde
// ao action_type onsite_conversion.messaging_first_reply.
const LEAD_ACTION_TYPE = 'onsite_conversion.messaging_first_reply';

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return resposta(405, { erro: 'Use POST, enviando o token no corpo da requisição.' }, headers);
  }

  let params;
  try {
    params = JSON.parse(event.body || '{}');
  } catch (e) {
    return resposta(400, { erro: 'Corpo da requisição inválido (esperado JSON).' }, headers);
  }

  // Aceita o token enviado pelo cliente; cai para a variável de ambiente apenas
  // como compatibilidade com configurações antigas (uma única conta "padrão").
  const token = params.token || process.env.META_ACCESS_TOKEN;
  if (!token) {
    return resposta(400, { erro: 'Token de acesso não informado.' }, headers);
  }

  const action = params.action || 'insights';

  try {
    if (action === 'contas') {
      return await listarContas(token, headers);
    }
    if (action === 'insights') {
      return await buscarInsights(token, params, headers);
    }
    if (action === 'insights_por_adset') {
      return await buscarInsightsPorAdset(token, params, headers);
    }
    return resposta(400, { erro: `Ação desconhecida: ${action}` }, headers);
  } catch (err) {
    console.error('meta-ads error:', err);
    return resposta(500, { erro: 'Erro interno na função.', detalhe: String(err.message || err) }, headers);
  }
};

// ---------- Listar contas de anúncios disponíveis ----------
async function listarContas(token, headers) {
  const url = `${GRAPH_BASE}/me/adaccounts?fields=id,name,account_id,account_status,currency&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    return resposta(400, { erro: data.error.message, codigo: data.error.code }, headers);
  }

  const contas = (data.data || []).map(c => ({
    id: c.id,                    // formato act_XXXXXXXXXX
    nome: c.name || c.id,
    status: c.account_status,
    moeda: c.currency,
  }));

  return resposta(200, { contas }, headers);
}

// ---------- Buscar insights diários ----------
async function buscarInsights(token, params, headers) {
  const account = params.account;
  if (!account) {
    return resposta(400, { erro: 'Informe a conta de anúncios (account).' }, headers);
  }

  // Período: por padrão, os últimos 7 dias. Pode ser sobrescrito via query.
  const fim = params.fim || isoHoje();
  const inicio = params.inicio || isoDiasAtras(7);

  const fields = [
    'spend', 'impressions', 'reach', 'clicks', 'cpc', 'ctr', 'actions', 'date_start', 'date_stop'
  ].join(',');

  let url = `${GRAPH_BASE}/${account}/insights`
    + `?fields=${fields}`
    + `&time_range=${encodeURIComponent(JSON.stringify({ since: inicio, until: fim }))}`
    + `&time_increment=1`
    + `&level=account`
    + `&limit=500`
    + `&access_token=${encodeURIComponent(token)}`;

  const todosRegistros = [];
  let paginas = 0;
  const MAX_PAGINAS = 50; // proteção contra loop infinito

  while (url && paginas < MAX_PAGINAS) {
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      return resposta(400, { erro: data.error.message, codigo: data.error.code }, headers);
    }

    todosRegistros.push(...(data.data || []));
    url = (data.paging && data.paging.next) ? data.paging.next : null;
    paginas++;
  }

  const dias = todosRegistros.map(formatarDia);

  return resposta(200, { conta: account, periodo: { inicio, fim }, paginas, total_registros: dias.length, dias }, headers);
}

// ---------- Buscar insights diários, quebrado por conjunto de anúncios (adset) ----------
// Usado para atribuir investimento/leads a atendentes, comparando o nome do adset
// com os nomes dos atendentes cadastrados no MATRIX. Não afeta a busca "insights" (geral).
async function buscarInsightsPorAdset(token, params, headers) {
  const account = params.account;
  if (!account) {
    return resposta(400, { erro: 'Informe a conta de anúncios (account).' }, headers);
  }

  const fim = params.fim || isoHoje();
  const inicio = params.inicio || isoDiasAtras(7);

  const fields = [
    'adset_name', 'adset_id', 'spend', 'impressions', 'reach', 'clicks', 'cpc', 'ctr', 'actions', 'date_start', 'date_stop'
  ].join(',');

  let url = `${GRAPH_BASE}/${account}/insights`
    + `?fields=${fields}`
    + `&time_range=${encodeURIComponent(JSON.stringify({ since: inicio, until: fim }))}`
    + `&time_increment=1`
    + `&level=adset`
    + `&limit=500`
    + `&access_token=${encodeURIComponent(token)}`;

  const todosRegistros = [];
  let paginas = 0;
  const MAX_PAGINAS = 50;

  while (url && paginas < MAX_PAGINAS) {
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      return resposta(400, { erro: data.error.message, codigo: data.error.code }, headers);
    }

    todosRegistros.push(...(data.data || []));
    url = (data.paging && data.paging.next) ? data.paging.next : null;
    paginas++;
  }

  const linhas = todosRegistros.map(r => ({
    ...formatarDia(r),
    adset_id: r.adset_id,
    adset_nome: r.adset_name || '',
  }));

  return resposta(200, { conta: account, periodo: { inicio, fim }, paginas, total_registros: linhas.length, linhas }, headers);
}

// Converte um registro diário da Graph API no formato usado pelo MATRIX
// (mesmas chaves de adminLancs: dia, mes, ano, investido, leads + extras)
function formatarDia(registro) {
  const data = new Date(registro.date_start + 'T00:00:00');
  const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  const acoes = registro.actions || [];
  const leadsAction = acoes.find(a => a.action_type === LEAD_ACTION_TYPE);
  const leads = leadsAction ? parseInt(leadsAction.value, 10) : 0;

  const cliquesLink = acoes.find(a => a.action_type === 'link_click');

  return {
    dia: data.getDate(),
    mes: MESES[data.getMonth()],
    ano: data.getFullYear(),
    data_iso: registro.date_start,
    investido: parseFloat(registro.spend || 0),
    leads,
    cliques: parseInt(registro.clicks || 0, 10),
    cliques_link: cliquesLink ? parseInt(cliquesLink.value, 10) : null,
    cpc: parseFloat(registro.cpc || 0),
    ctr: parseFloat(registro.ctr || 0),
    impressoes: parseInt(registro.impressions || 0, 10),
    alcance: parseInt(registro.reach || 0, 10),
  };
}

function isoHoje() {
  return new Date().toISOString().split('T')[0];
}
function isoDiasAtras(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function resposta(statusCode, body, headers) {
  return { statusCode, headers, body: JSON.stringify(body) };
}
