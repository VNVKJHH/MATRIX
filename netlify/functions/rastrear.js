const https = require('https');

// Reaproveita a conexão HTTPS entre chamadas (evita refazer o handshake TLS toda
// vez que a função está "quente" — isso sozinho já tira ~100-300ms de cada busca).
const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });

// Cache simples em memória, válido enquanto a função estiver "quente" (mesmo
// container). Evita bater na API externa de novo se alguém clicar duas vezes
// seguidas, ou se o mesmo código for buscado de novo logo em seguida (ex: a
// sincronização automática rodando logo depois de uma busca manual).
const CACHE_TTL_MS = 90 * 1000; // 90 segundos
const cache = new Map();

function buscarComTimeout(codigo, apiKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'seurastreio.com.br',
      path: '/api/public/rastreio/' + codigo,
      method: 'GET',
      agent,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'application/json',
        'User-Agent': 'MATRIX/1.0',
        'Connection': 'keep-alive'
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(new Error('Timeout ao consultar a API de rastreio (mais de ' + (timeoutMs/1000) + 's sem resposta).')); });
    req.on('error', reject);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const apiKey = process.env.SEU_RASTREIO_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'SEU_RASTREIO_API_KEY não configurado no Netlify.' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const codigo = (body.codigo || '').trim().toUpperCase();
    if (!codigo) return { statusCode: 400, body: JSON.stringify({ error: 'Código não informado' }) };

    // Limpa entradas velhas do cache de vez em quando, sem precisar de cron.
    const agora = Date.now();
    for (const [k, v] of cache) { if (agora - v.criadoEm > CACHE_TTL_MS) cache.delete(k); }

    const emCache = cache.get(codigo);
    if (emCache && (agora - emCache.criadoEm) < CACHE_TTL_MS) {
      console.log('Cache HIT:', codigo);
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
        body: emCache.body
      };
    }

    const result = await buscarComTimeout(codigo, apiKey, 8000);

    console.log('SeuRastreio Status:', result.status);
    console.log('SeuRastreio Response:', result.body.substring(0, 500));

    const parsed = JSON.parse(result.body);
    const respostaFinal = JSON.stringify(parsed);

    // Só guarda no cache respostas que vieram com sucesso real (200), pra não
    // "congelar" um erro temporário da API externa por 90 segundos.
    if (result.status === 200) {
      cache.set(codigo, { body: respostaFinal, criadoEm: agora });
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
      body: respostaFinal
    };
  } catch (error) {
    console.log('Error:', error.message);
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: error.message }) };
  }
};
