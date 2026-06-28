// /.netlify/functions/payt-webhook
// Recebe os postbacks da Payt (formato "PayT V1 Flat") e grava direto no Firestore,
// usando o Firebase Admin SDK — funciona de forma autônoma, 24/7, sem depender de
// nenhum atendente estar com o MATRIX aberto no navegador no momento do evento.
//
// Eventos tratados:
//   status === "paid"  -> cria um lançamento de venda em "dados"
//   shipping.status     -> atualiza o rastreamento/status de entrega do pedido já existente
//
// Variáveis de ambiente necessárias:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ erro: 'Corpo inválido (esperado JSON).' }) };
  }

  try {
    const db = getDb();

    // Identifica o atendente pelo utm_content (link.sources.utm_content ou
    // origin.query_params.utm_content) e o atribui comparando com o "paytId"
    // cadastrado em cada atendente.
    const utmContent = payload['link.sources.utm_content'] || payload['origin.query_params.utm_content'] || '';
    const atendentesSnap = await db.collection('atendentes').get();
    let atendenteEncontrado = '';
    atendentesSnap.forEach(doc => {
      const a = doc.data();
      if (a.paytId && utmContent && utmContent.toLowerCase().includes(a.paytId.toLowerCase())) {
        atendenteEncontrado = a.nome;
      }
    });

    const cartId = payload.cart_id || payload.transaction_id || '';
    const fbId = 'payt_' + cartId;

    if (payload.status === 'paid') {
      const dataPagamento = payload['transaction.paid_at'] || payload.updated_at || payload.started_at;
      const dt = dataPagamento ? new Date(dataPagamento.replace(' ', 'T')) : new Date();

      const ofertaId = mapearOfertaPorNomeProduto(payload['product.name'] || '');
      const brutoCentavos = payload['transaction.total_price'] ?? payload['product.price'] ?? 0;

      const rec = {
        dia: dt.getDate(),
        mes: MESES[dt.getMonth()],
        ano: dt.getFullYear(),
        atendente: atendenteEncontrado, // fica vazio (Geral) se não identificado
        ofertaId: ofertaId,
        bruto: round2(brutoCentavos / 100),
        qtd_vendas: 1,
        nomeCliente: payload['customer.name'] || '',
        telefone: limparTelefone(payload['customer.phone'] || ''),
        recuperacao: false,
        origemPayt: true,
        paytCartId: cartId,
        paytStatus: payload['shipping.status'] || '',
        fbId,
      };

      await db.collection('dados').doc(fbId).set(rec, { merge: true });
      return resposta(200, { ok: true, acao: 'venda_criada', fbId });
    }

    // Atualização de status de entrega/rastreio: encontra o registro já existente
    // pelo mesmo fbId (criado quando a venda foi aprovada) e atualiza só o status.
    if (payload['shipping.status']) {
      const docRef = db.collection('dados').doc(fbId);
      const docSnap = await docRef.get();
      if (docSnap.exists) {
        await docRef.set({
          paytStatus: payload['shipping.status'],
          rastreamento: payload['shipping.tracking_code'] || docSnap.data().rastreamento || '',
        }, { merge: true });
        return resposta(200, { ok: true, acao: 'rastreio_atualizado', fbId });
      }
      return resposta(200, { ok: true, acao: 'pedido_nao_encontrado_ainda', fbId });
    }

    return resposta(200, { ok: true, acao: 'evento_ignorado' });
  } catch (err) {
    console.error('payt-webhook error:', err);
    return resposta(500, { erro: 'Erro interno.', detalhe: String(err.message || err) });
  }
};

// Mapeia o nome do produto da Payt (ex: "6 Frasco (Maximus V6)") para o ofertaId
// usado no MATRIX, pelo número de frascos extraído do nome.
function mapearOfertaPorNomeProduto(nomeProduto) {
  const match = nomeProduto.match(/(\d+)\s*Frascos?/i);
  if (!match) return 1;
  const qtd = parseInt(match[1], 10);
  const tabela = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 12: 7 };
  return tabela[qtd] || 1;
}

function limparTelefone(tel) {
  const digitos = String(tel).replace(/\D/g, '');
  if (digitos.length < 10) return tel;
  const ddd = digitos.slice(0, 2);
  const resto = digitos.slice(2);
  if (resto.length === 9) return `(${ddd}) ${resto.slice(0,5)}-${resto.slice(5)}`;
  return `(${ddd}) ${resto.slice(0,4)}-${resto.slice(4)}`;
}

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function resposta(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
