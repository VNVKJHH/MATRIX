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
// Nota: não usamos mais o parâmetro "lang" da API (o campo "lang" no corpo do
// /trackings/create causava erro "formato de campo inválido" na J&T Brasil).
// A tradução pro português agora é feita 100% pelo nosso próprio dicionário
// (função traduzirTextoJT logo abaixo), que já funciona bem e não depende
// de nenhum parâmetro extra da API.

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

// O texto de cada evento da J&T vem no formato "[Cidade] Descrição [UF CÓDIGO]
// enviada para [UF CÓDIGO]" — por exemplo:
// "[Barueri] Saída da encomenda expressa [SP BRE] enviada para [ES SRR]".
// Essa função extrai "Cidade/UF" a partir disso, no mesmo formato que o resto
// do MATRIX já usa (ex: pro globo 3D localizar o envio no mapa).
// O parâmetro lang=pt do TrackingMore nem sempre traduz o texto bruto da J&T
// (às vezes o rastreio já foi criado antes desse pedido de idioma, ou o dado
// simplesmente vem sempre em inglês pra essa transportadora). Pra garantir
// que o operador sempre veja em português, aplicamos nossa própria tradução
// por dicionário de termos comuns, em vez de depender só da tradução deles.
const DICIONARIO_PT_JT = [
  [/if there is any exception or complaint,?\s*please contact the network:?/gi, 'se houver qualquer problema ou reclamação, entre em contato com a unidade:'],
  [/shipped for/gi, 'enviado para'],
  [/picked up by/gi, 'retirado por'],
  [/picked up/gi, 'coletado'],
  [/pick[- ]?up/gi, 'coleta'],
  [/departed/gi, 'saída de'],
  [/arrival/gi, 'chegada em'],
  [/arrived/gi, 'chegou em'],
  [/out for delivery/gi, 'saiu para entrega'],
  [/delivering/gi, 'em rota de entrega'],
  [/delivered/gi, 'entregue'],
  [/undelivered/gi, 'não entregue'],
  [/returned to sender/gi, 'devolvido ao remetente'],
  [/returning to sender/gi, 'sendo devolvido ao remetente'],
  [/refused by/gi, 'recusado por'],
  [/customs/gi, 'alfândega'],
  [/received/gi, 'recebido'],
  [/collected/gi, 'coletado'],
  [/consignee/gi, 'destinatário'],
  [/addressee/gi, 'destinatário'],
  [/warehouse/gi, 'depósito'],
  [/sorting center/gi, 'centro de triagem'],
  [/in transit/gi, 'em trânsito'],
];
function traduzirTextoJT(texto){
  if(!texto) return texto;
  let t = texto;
  DICIONARIO_PT_JT.forEach(([regex, sub]) => { t = t.replace(regex, sub); });
  return t;
}

function rotuloStatusGeral(status){
  const rotulos = {
    delivered: 'Pacote entregue ao destinatário',
    undelivered: 'Tentativa de entrega sem sucesso',
    exception: 'Problema com a encomenda — verifique com a transportadora',
    expired: 'Sem atualização há 30 dias — verifique com a transportadora',
  };
  return rotulos[status] || status || 'Status atualizado';
}

function extrairLocalJT(texto) {
  if (!texto) return '';
  const colchetes = [...texto.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  if (colchetes.length === 0) return '';
  const cidade = colchetes[0];
  for (let i = 1; i < colchetes.length; i++) {
    // Os códigos das unidades vêm separados por espaço (ex: "SP BRE") ou
    // hífen (ex: "INDTB-SP") — quebramos pelos dois pra achar a sigla da UF.
    const tokens = colchetes[i].split(/[\s-]+/).map((t) => t.toUpperCase());
    const uf = tokens.find((t) => UFS.includes(t));
    if (uf) return cidade + '/' + uf;
  }
  return '';
}


exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return resposta(405, { success: false, status: 'error', erro: 'Método não permitido' });
  }

  const apiKey = process.env.TRACKINGMORE_API_KEY;
  if (!apiKey) {
    console.error('[rastrear-jt] TRACKINGMORE_API_KEY não configurado nas variáveis de ambiente do Netlify');
    return resposta(200, { success: false, status: 'error', erro: 'TRACKINGMORE_API_KEY não configurado.' });
  }

  let codigo, cpf;
  try {
    const body = JSON.parse(event.body || '{}');
    codigo = (body.codigo || '').trim().replace(/\s/g, '');
    cpf = (body.cpf || '').replace(/\D/g, '');
  } catch (e) {
    return resposta(200, { success: false, status: 'invalid_format', erro: 'Corpo da requisição inválido' });
  }

  if (!codigo) {
    return resposta(200, { success: false, status: 'invalid_format', erro: 'Código de rastreio ausente' });
  }

  // A "Get All Couriers API" do TrackingMore confirma que a jtexpress-br exige
  // o campo extra "tracking_key". Baseado no próprio site oficial da J&T (que
  // exige CPF junto do código pra liberar a consulta), o valor esperado aqui é
  // o CPF do destinatário.
  console.log('[rastrear-jt] Consultando código:', codigo, '| courier_code:', COURIER_CODE, '| CPF informado:', cpf ? 'sim ('+cpf.length+' dígitos)' : 'não');

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
    if (cpf) corpoCreate.tracking_key = cpf;
    const resCreate = await fetch(`${TRACKINGMORE_BASE}/trackings/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify(corpoCreate),
    });
    const textoCreate = await resCreate.text();
    console.log('[rastrear-jt] Resposta do create (status ' + resCreate.status + '):', textoCreate.substring(0, 300));

    let dataCreate = null;
    try { dataCreate = JSON.parse(textoCreate); } catch (e) { /* ignora */ }

    // Se o create falhou e temos o CPF, é bem provável que o motivo seja um
    // registro antigo (de antes de sabermos desse campo extra) já existir sem
    // ele. Buscamos o "id" desse registro existente e usamos
    // PUT /trackings/update/{id} pra corrigir.
    if (!resCreate.ok && cpf) {
      console.log('[rastrear-jt] Create falhou — tentando localizar registro existente pra corrigir via update...');
      const resGetPrevio = await fetch(`${TRACKINGMORE_BASE}/trackings/get?tracking_numbers=${encodeURIComponent(codigo)}&courier_code=${COURIER_CODE}`, {
        method: 'GET',
        headers,
      });
      if (resGetPrevio.ok) {
        const dataGetPrevio = await resGetPrevio.json().catch(() => null);
        const trackingPrevio = dataGetPrevio && dataGetPrevio.data && dataGetPrevio.data[0];
        if (trackingPrevio && trackingPrevio.id) {
          console.log('[rastrear-jt] Registro existente encontrado, id:', trackingPrevio.id, '— enviando update com tracking_key...');
          const resUpdate = await fetch(`${TRACKINGMORE_BASE}/trackings/update/${trackingPrevio.id}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ tracking_key: cpf }),
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
      // Se o status GERAL já é final (entregue, devolvido, etc.) mas o
      // TrackingMore ainda não sincronizou o detalhamento evento a evento,
      // não dá pra tratar como "ainda processando" — o pedido já tem uma
      // situação real e precisa aparecer certinho no MATRIX, não como
      // "código inválido". Monta um evento único com o que já temos.
      const statusFinal = ['delivered', 'undelivered', 'exception', 'expired'].includes(tracking.delivery_status);
      if (statusFinal) {
        console.log('[rastrear-jt] Sem detalhamento de eventos, mas status geral já é final:', tracking.delivery_status);
        const dataEvento = tracking.update_at || tracking.created_at || '';
        const historicoResumido = [{
          descricao: traduzirTextoJT(rotuloStatusGeral(tracking.delivery_status)),
          data: dataEvento,
          local: '',
          statusBruto: tracking.delivery_status,
          substatusBruto: '',
        }];
        return resposta(200, {
          success: true,
          status: 'ok',
          historico: historicoResumido,
          eventoMaisRecente: historicoResumido[0],
          previsaoEntrega: '',
        });
      }
      // A criação do rastreio dispara uma busca em segundo plano no
      // TrackingMore — pode levar de alguns segundos a poucos minutos pra
      // popular o histórico na primeira consulta de um código novo.
      console.log('[rastrear-jt] Ainda sem eventos (provavelmente processando em segundo plano). delivery_status:', tracking.delivery_status);
      return resposta(200, { success: false, status: 'not_found' });
    }

    // O TrackingMore já retorna do evento mais recente para o mais antigo.
    const historico = trackinfo.map((t) => ({
      descricao: traduzirTextoJT(t.tracking_detail) || '—',
      data: t.checkpoint_date || '', // já vem em formato ISO com "T"
      // O texto da J&T embute a cidade/UF entre colchetes (ex: "[Barueri]...
      // [SP BRE]") — extraímos "Cidade/UF" daí; se não achar, usa o campo
      // "location" que o TrackingMore às vezes já traz separado.
      local: extrairLocalJT(t.tracking_detail) || t.location || '',
      // checkpoint_delivery_status é o campo padronizado do TrackingMore
      // (valores tipo: pending, transit, pickup, delivered, exception,
      // undelivered, expired, notfound) — mais confiável que tentar
      // classificar só pelo texto livre.
      statusBruto: t.checkpoint_delivery_status || tracking.delivery_status || '',
      // Sub-status dá mais detalhe (ex: diferenciar "aguardando retirada" de
      // "tentativa de entrega falhou", ou "devolvido" de "em devolução").
      substatusBruto: t.checkpoint_delivery_substatus || '',
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
