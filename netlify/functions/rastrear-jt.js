// Netlify Function: consulta o rastreamento da J&T Express (jtjms-br).
//
// A J&T não tem API pública oficial — esta function replica exatamente as
// chamadas que o próprio site https://www.jtexpress.com.br/trajectoryQuery
// faz por trás dos panos (capturadas via DevTools > Network):
//   1) POST https://official.jtjms-br.com/official/logisticsTracking/v2
//      -> lista de eventos do rastreio
//   2) POST https://official.jtjms-br.com/official/logisticsTracking/trace
//      -> data prevista de entrega
// Ambas exigem { cpf, waybillNo, langType } no corpo. O CPF é o do titular
// do pedido (a própria J&T exige isso pra evitar rastreio por terceiros).
//
// A resposta desta function já vem normalizada no MESMO formato usado pela
// function `rastrear.js` (Correios/SeuRastreio.com.br), pra o front-end do
// MATRIX não precisar tratar os dois casos de forma diferente:
//   { success, status, historico:[{descricao,data,local,statusBruto}], eventoMaisRecente, previsaoEntrega }

const URL_DETALHE = 'https://official.jtjms-br.com/official/logisticsTracking/v2';
const URL_PREVISAO = 'https://official.jtjms-br.com/official/logisticsTracking/trace';

// Headers extras que o site oficial da J&T envia em toda chamada (capturados
// via DevTools > Network > Request Headers). "appid" e "key" parecem ser
// valores fixos do app cliente web (não mudam entre requisições). "nonce" é
// um número aleatório novo a cada chamada. "sign" é uma assinatura calculada
// que AINDA NÃO conseguimos reproduzir (escondida em JS minificado) — por
// enquanto tentamos sem ela, pra ver se o erro muda e nos dá mais pistas.
function montarHeadersExtras() {
  return {
    appid: '3B29A9C5728BF3E1DB0C4D66B79748B7',
    key: '94bbcac67ab47c736d530efe3e1dc358',
    clientsource: 'web',
    countryid: '1',
    langtype: 'PT',
    timezone: 'GMT-0300',
    nonce: String(Math.random()),
    timestamp: String(Date.now()),
    token: '',
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return resposta(405, { success: false, status: 'error', erro: 'Método não permitido' });
  }

  let codigo, cpf;
  try {
    const body = JSON.parse(event.body || '{}');
    codigo = (body.codigo || '').trim().replace(/\s/g, '');
    cpf = (body.cpf || '').replace(/\D/g, '');
  } catch (e) {
    console.error('[rastrear-jt] Body inválido:', event.body);
    return resposta(200, { success: false, status: 'invalid_format', erro: 'Corpo da requisição inválido' });
  }

  console.log('[rastrear-jt] Consultando código:', codigo, '| CPF informado:', cpf ? 'sim ('+cpf.length+' dígitos)' : 'NÃO');

  if (!codigo) {
    return resposta(200, { success: false, status: 'invalid_format', erro: 'Código de rastreio ausente' });
  }
  if (!cpf) {
    // A J&T exige CPF junto do código pra liberar a consulta — sem isso nem
    // adianta chamar a API deles, sempre vai voltar vazio/erro.
    console.warn('[rastrear-jt] CPF ausente para o código', codigo);
    return resposta(200, { success: false, status: 'error', erro: 'CPF do pedido é obrigatório para consultar a J&T Express' });
  }

  const payload = JSON.stringify({ cpf, waybillNo: codigo, langType: 'PT' });
  const headersExtras = montarHeadersExtras();
  console.log('[rastrear-jt] Headers extras enviados:', JSON.stringify(headersExtras));

  try {
    console.log('[rastrear-jt] Chamando', URL_DETALHE);
    const resDetalhe = await fetch(URL_DETALHE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin': 'https://www.jtexpress.com.br',
        'Referer': 'https://www.jtexpress.com.br/',
        ...headersExtras,
      },
      body: payload,
    });

    console.log('[rastrear-jt] Status HTTP da resposta:', resDetalhe.status);

    if (!resDetalhe.ok) {
      const textoErro = await resDetalhe.text().catch(() => '(sem corpo)');
      console.error('[rastrear-jt] HTTP não-OK:', resDetalhe.status, '| corpo:', textoErro.substring(0, 500));
      return resposta(200, { success: false, status: 'error', erro: 'HTTP ' + resDetalhe.status + ' na consulta de detalhes' });
    }

    const textoBruto = await resDetalhe.text();
    console.log('[rastrear-jt] Corpo bruto da resposta (primeiros 500 chars):', textoBruto.substring(0, 500));

    let dataDetalhe;
    try {
      dataDetalhe = JSON.parse(textoBruto);
    } catch (eParse) {
      console.error('[rastrear-jt] Resposta não é JSON válido:', eParse.message);
      return resposta(200, { success: false, status: 'error', erro: 'Resposta da J&T não é JSON válido' });
    }

    // A API da J&T retorna succ:true/false e code:1 em caso de sucesso.
    if (!dataDetalhe || dataDetalhe.succ !== true || dataDetalhe.code !== 1 || !dataDetalhe.data) {
      console.warn('[rastrear-jt] Resposta sem sucesso ou sem dados:', JSON.stringify(dataDetalhe).substring(0, 300));
      return resposta(200, { success: false, status: 'not_found' });
    }

    const details = dataDetalhe.data.details || [];
    if (details.length === 0) {
      return resposta(200, { success: false, status: 'not_found' });
    }

    // A J&T já retorna os eventos do mais recente para o mais antigo, igual
    // o MATRIX espera (eventos[0] = mais recente).
    const historico = details.map((d) => ({
      descricao: d.customerTracking || d.status || '—',
      // scanTime vem como "2026-07-30 04:59:14" — troca o espaço por "T" pra
      // ficar no formato ISO que o front-end do MATRIX já sabe interpretar.
      data: (d.scanTime || '').replace(' ', 'T'),
      local: '', // já vem embutido no texto de customerTracking, ex: "[SP BRE]"
      statusBruto: d.status || '', // ex: "Coletado", "Em transferencia" — usado pra classificar o status
    }));

    // Previsão de entrega é uma chamada separada. Se falhar, não é motivo
    // pra invalidar a consulta principal — só fica sem a data prevista.
    let previsaoEntrega = '';
    try {
      const resPrevisao = await fetch(URL_PREVISAO, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Origin': 'https://www.jtexpress.com.br',
          'Referer': 'https://www.jtexpress.com.br/',
          ...montarHeadersExtras(),
        },
        body: payload,
      });
      if (resPrevisao.ok) {
        const dataPrevisao = await resPrevisao.json();
        if (dataPrevisao && dataPrevisao.succ === true && dataPrevisao.data) {
          // dataPrevisao.data vem como "2026-08-04 23:59" — converte pra ISO
          previsaoEntrega = String(dataPrevisao.data).replace(' ', 'T');
        }
      } else {
        console.warn('[rastrear-jt] Previsão falhou com HTTP', resPrevisao.status, '(não é crítico)');
      }
    } catch (ePrevisao) {
      console.warn('[rastrear-jt] Erro ao buscar previsão (não é crítico):', ePrevisao.message);
    }

    console.log('[rastrear-jt] Sucesso —', historico.length, 'evento(s) encontrados para', codigo);

    return resposta(200, {
      success: true,
      status: 'ok',
      historico,
      eventoMaisRecente: historico[0],
      previsaoEntrega,
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
