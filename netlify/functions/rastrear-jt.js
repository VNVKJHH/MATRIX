// Netlify Function: consulta o rastreamento da J&T Express Brasil através da
// API oficial do TrackingMore (https://api.trackingmore.com/v4).
//
// Por que TrackingMore em vez de falar direto com a J&T? O site público de
// rastreio da J&T (jtexpress.com.br) é protegido por CAPTCHA (Tencent Turing
// Captcha) — não dá pra automatizar isso de forma confiável nem legítima. O
// TrackingMore é um agregador oficial que já tem integração direta com a J&T
// Brasil (courier_code: "jtexpress-br"), então usamos a API deles.
//
// Fluxo:
//   1) POST /trackings/create — registra o código pra rastreio (se já existir,
//      a API retorna um erro que a gente simplesmente ignora e segue em frente)
//   2) GET /trackings/get?tracking_numbers=... — busca o status atual/eventos
//
// A resposta desta function já vem normalizada no MESMO formato usado pelas
// outras functions de rastreio do MATRIX:
//   { success, status, historico:[{descricao,data,local,statusBruto}], eventoMaisRecente, previsaoEntrega }

const TRACKINGMORE_BASE = 'https://api.trackingmore.com/v4';
const COURIER_CODE = 'jtexpress-br'; // confirmado com teste real: bate com jtexpress.com.br

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return resposta(405, { success: false, status: 'error', erro: 'Método não permitido' });
  }

  const apiKey = process.env.TRACKINGMORE_API_KEY;
  if (!apiKey) {
    console.error('[rastrear-jt] TRACKINGMORE_API_KEY não configurado nas variáveis de ambiente do Netlify');
    return resposta(200, { success: false, status: 'error', erro: 'TRACKINGMORE_API_KEY não configurado.' });
  }

  let codigo, telefone;
  try {
    const body = JSON.parse(event.body || '{}');
    codigo = (body.codigo || '').trim().replace(/\s/g, '');
    telefone = (body.telefone || '').replace(/\D/g, '');
  } catch (e) {
    return resposta(200, { success: false, status: 'invalid_format', erro: 'Corpo da requisição inválido' });
  }

  if (!codigo) {
    return resposta(200, { success: false, status: 'invalid_format', erro: 'Código de rastreio ausente' });
  }

  // A J&T Brasil (assim como as outras variantes regionais da J&T no
  // TrackingMore — México, Tailândia, Vietnã) exige um campo extra pra
  // liberar o rastreio. Seguindo o mesmo padrão delas, mandamos os últimos 4
  // dígitos do telefone do destinatário no campo "tracking_postal_code".
  const ultimosDigitosTelefone = telefone.slice(-4);
  console.log('[rastrear-jt] Consultando código:', codigo, '| courier_code:', COURIER_CODE, '| últimos 4 dígitos do telefone:', ultimosDigitosTelefone || '(nenhum)');

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Tracking-Api-Key': apiKey,
  };

  try {
    // 1) Tenta registrar o rastreio. Se já existir (código já foi consultado
    // antes SEM o campo extra do telefone, como aconteceu nos testes
    // iniciais), a API recusa o create — nesse caso vamos tentar corrigir com
    // um update logo abaixo.
    console.log('[rastrear-jt] Registrando/criando rastreio...');
    const corpoCreate = { tracking_number: codigo, courier_code: COURIER_CODE };
    if (ultimosDigitosTelefone) corpoCreate.tracking_postal_code = ultimosDigitosTelefone;
    const resCreate = await fetch(`${TRACKINGMORE_BASE}/trackings/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify(corpoCreate),
    });
    const textoCreate = await resCreate.text();
    console.log('[rastrear-jt] Resposta do create (status ' + resCreate.status + '):', textoCreate.substring(0, 300));

    let dataCreate = null;
    try { dataCreate = JSON.parse(textoCreate); } catch (e) { /* ignora */ }

    // Se o create falhou e temos os últimos dígitos do telefone, é bem
    // provável que o motivo seja um registro antigo (de antes de sabermos
    // desse campo extra) já existir sem ele. Buscamos o "id" desse registro
    // existente e usamos PUT /trackings/update/{id} pra corrigir.
    if (!resCreate.ok && ultimosDigitosTelefone) {
      console.log('[rastrear-jt] Create falhou — tentando localizar registro existente pra corrigir via update...');
      const resGetPrevio = await fetch(`${TRACKINGMORE_BASE}/trackings/get?tracking_numbers=${encodeURIComponent(codigo)}&courier_code=${COURIER_CODE}`, {
        method: 'GET',
        headers,
      });
      if (resGetPrevio.ok) {
        const dataGetPrevio = await resGetPrevio.json().catch(() => null);
        const trackingPrevio = dataGetPrevio && dataGetPrevio.data && dataGetPrevio.data[0];
        if (trackingPrevio && trackingPrevio.id) {
          console.log('[rastrear-jt] Registro existente encontrado, id:', trackingPrevio.id, '— enviando update com tracking_postal_code...');
          const resUpdate = await fetch(`${TRACKINGMORE_BASE}/trackings/update/${trackingPrevio.id}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ tracking_postal_code: ultimosDigitosTelefone }),
          });
          const textoUpdate = await resUpdate.text();
          console.log('[rastrear-jt] Resposta do update (status ' + resUpdate.status + '):', textoUpdate.substring(0, 300));
        } else {
          console.warn('[rastrear-jt] Não encontrou registro existente pra atualizar.');
        }
      }
    }

    // 2) Busca o status/eventos atuais desse rastreio.
    console.log('[rastrear-jt] Buscando eventos do rastreio...');
    const resGet = await fetch(`${TRACKINGMORE_BASE}/trackings/get?tracking_numbers=${encodeURIComponent(codigo)}&courier_code=${COURIER_CODE}`, {
      method: 'GET',
      headers,
    });

    console.log('[rastrear-jt] Status HTTP do get:', resGet.status);

    if (!resGet.ok) {
      const textoErro = await resGet.text().catch(() => '(sem corpo)');
      console.error('[rastrear-jt] HTTP não-OK no get:', resGet.status, '| corpo:', textoErro.substring(0, 500));
      return resposta(200, { success: false, status: 'error', erro: 'HTTP ' + resGet.status + ' ao buscar rastreio' });
    }

    const textoGet = await resGet.text();
    console.log('[rastrear-jt] Corpo bruto da resposta do get (primeiros 500 chars):', textoGet.substring(0, 500));

    let dataGet;
    try {
      dataGet = JSON.parse(textoGet);
    } catch (eParse) {
      console.error('[rastrear-jt] Resposta do get não é JSON válido:', eParse.message);
      return resposta(200, { success: false, status: 'error', erro: 'Resposta do TrackingMore não é JSON válido' });
    }

    if (!dataGet || !dataGet.meta || dataGet.meta.code !== 200 || !dataGet.data || dataGet.data.length === 0) {
      console.warn('[rastrear-jt] Get sem sucesso ou sem dados:', JSON.stringify(dataGet).substring(0, 300));
      return resposta(200, { success: false, status: 'not_found' });
    }

    const tracking = dataGet.data[0];
    const trackinfo = (tracking.origin_info && tracking.origin_info.trackinfo) || [];

    if (trackinfo.length === 0) {
      // A criação do rastreio dispara uma busca em segundo plano no
      // TrackingMore — pode levar de alguns segundos a poucos minutos pra
      // popular o histórico na primeira consulta de um código novo.
      console.log('[rastrear-jt] Ainda sem eventos (provavelmente processando em segundo plano). delivery_status:', tracking.delivery_status);
      return resposta(200, { success: false, status: 'not_found' });
    }

    // O TrackingMore já retorna do evento mais recente para o mais antigo.
    const historico = trackinfo.map((t) => ({
      descricao: t.tracking_detail || '—',
      data: t.checkpoint_date || '', // já vem em formato ISO com "T"
      local: t.location || '',
      // checkpoint_delivery_status é o campo padronizado do TrackingMore
      // (valores tipo: pending, transit, pickup, delivered, exception,
      // undelivered, expired, notfound) — mais confiável que tentar
      // classificar só pelo texto livre.
      statusBruto: t.checkpoint_delivery_status || tracking.delivery_status || '',
    }));

    console.log('[rastrear-jt] Sucesso —', historico.length, 'evento(s) encontrados para', codigo, '| delivery_status geral:', tracking.delivery_status);

    return resposta(200, {
      success: true,
      status: 'ok',
      historico,
      eventoMaisRecente: historico[0],
      previsaoEntrega: '', // TrackingMore não retorna previsão de entrega estimada para este courier
    });
  } catch (e) {
    console.error('[rastrear-jt] Exceção não tratada para código', codigo, ':', e.name, '-', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 5).join(' | '));
    return resposta(200, { success: false, status: 'error', erro: e.message });
  }
};

function resposta(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
