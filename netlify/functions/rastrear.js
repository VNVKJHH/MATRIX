const https = require('https');

const agent = new https.Agent({ keepAlive: true, maxSockets: 5 });
const CACHE_TTL_MS = 5 * 60 * 1000;
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
    req.on('timeout', () => { req.destroy(new Error('Timeout')); });
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
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'SEU_RASTREIO_API_KEY não configurado.' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const codigo = (body.codigo || '').trim().toUpperCase();
    if (!codigo) return { statusCode: 400, body: JSON.stringify({ error: 'Código não informado' }) };

    const agora = Date.now();
    for (const [k, v] of cache) { if (agora - v.criadoEm > CACHE_TTL_MS) cache.delete(k); }
    const emCache = cache.get(codigo);
    if (emCache && (agora - emCache.criadoEm) < CACHE_TTL_MS) {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'X-Cache': 'HIT' }, body: emCache.body };
    }

    const result = await buscarComTimeout(codigo, apiKey, 10000);
    console.log('SeuRastreio Status:', result.status, 'Codigo:', codigo);

    // Rate limit ou Cloudflare: não marca como inválido, só avisa pra tentar depois
    if (result.status === 429 || result.status === 503) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, status: 'rate_limited' })
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(result.body);
    } catch(e) {
      // Resposta não é JSON (ex: página HTML de erro do Cloudflare com código 1015)
      console.log('Resposta nao JSON:', result.body.substring(0, 100));
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, status: 'rate_limited' })
      };
    }

    const respostaFinal = JSON.stringify(parsed);
    if (result.status === 200) cache.set(codigo, { body: respostaFinal, criadoEm: agora });

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
      body: respostaFinal
    };
  } catch (error) {
    console.log('Error:', error.message);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, status: 'error', message: error.message })
    };
  }
};
