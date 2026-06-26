// /.netlify/functions/meta-ads
// Integração com a Meta Marketing API (Facebook/Instagram Ads) para o MATRIX.
//
// Variáveis de ambiente necessárias (configuradas no Netlify):
//   META_ACCESS_TOKEN   -> token de acesso (System User ou de longa duração)
//   META_AD_ACCOUNT_ID  -> conta de anúncios padrão, formato "act_XXXXXXXXXX" (opcional, pode vir por query)
//
// Ações suportadas (?action=...):
//   contas   -> lista as contas de anúncios disponíveis para o token
//   insights -> retorna investimento/leads/cliques/CTR/CPC/impressões/alcance por dia
//
// Exemplos de uso a partir do MATRIX:
//   /.netlify/functions/meta-ads?action=contas
//   /.netlify/functions/meta-ads?action=insights&account=act_123&inicio=2026-06-01&fim=2026-06-26

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    return resposta(500, { erro: 'META_ACCESS_TOKEN não configurado no Netlify.' }, headers);
  }

  const params = event.queryStringParameters || {};
  const action = params.action || 'insights';

  try {
    if (action === 'contas') {
      return await listarContas(token, headers);
    }
    if (action === 'insights') {
      return await buscarInsights(token, params, headers);
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
  const account = params.account || process.env.META_AD_ACCOUNT_ID;
  if (!account) {
    return resposta(400, { erro: 'Informe a conta (?account=act_XXXX) ou configure META_AD_ACCOUNT_ID.' }, headers);
  }

  // Período: por padrão, os últimos 7 dias. Pode ser sobrescrito via query.
  const fim = params.fim || isoHoje();
  const inicio = params.inicio || isoDiasAtras(7);

  const fields = [
    'spend', 'impressions', 'reach', 'clicks', 'cpc', 'ctr', 'actions', 'date_start', 'date_stop'
  ].join(',');

  const url = `${GRAPH_BASE}/${account}/insights`
    + `?fields=${fields}`
    + `&time_range=${encodeURIComponent(JSON.stringify({ since: inicio, until: fim }))}`
    + `&time_increment=1`
    + `&level=account`
    + `&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    return resposta(400, { erro: data.error.message, codigo: data.error.code }, headers);
  }

  const dias = (data.data || []).map(formatarDia);

  return resposta(200, { conta: account, periodo: { inicio, fim }, dias }, headers);
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
