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
    return resposta(200, { success: false, status: 'invalid_format', erro: 'Corpo da requisição inválido' });
  }

  if (!codigo) {
    return resposta(200, { success: false, status: 'invalid_format', erro: 'Código de rastreio ausente' });
  }
  if (!cpf) {
    // A J&T exige CPF junto do código pra liberar a consulta — sem isso nem
    // adianta chamar a API deles, sempre vai voltar vazio/erro.
    return resposta(200, { success: false, status: 'error', erro: 'CPF do pedido é obrigatório para consultar a J&T Express' });
  }

  const payload = JSON.stringify({ cpf, waybillNo: codigo, langType: 'PT' });

  try {
    const resDetalhe = await fetch(URL_DETALHE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    if (!resDetalhe.ok) {
      return resposta(200, { success: false, status: 'error', erro: 'HTTP ' + resDetalhe.status + ' na consulta de detalhes' });
    }

    const dataDetalhe = await resDetalhe.json();

    // A API da J&T retorna succ:true/false e code:1 em caso de sucesso.
    if (!dataDetalhe || dataDetalhe.succ !== true || dataDetalhe.code !== 1 || !dataDetalhe.data) {
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
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (resPrevisao.ok) {
        const dataPrevisao = await resPrevisao.json();
        if (dataPrevisao && dataPrevisao.succ === true && dataPrevisao.data) {
          // dataPrevisao.data vem como "2026-08-04 23:59" — converte pra ISO
          previsaoEntrega = String(dataPrevisao.data).replace(' ', 'T');
        }
      }
    } catch (ePrevisao) {
      // silencioso — previsão é opcional
    }

    return resposta(200, {
      success: true,
      status: 'ok',
      historico,
      eventoMaisRecente: historico[0],
      previsaoEntrega,
    });
  } catch (e) {
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
