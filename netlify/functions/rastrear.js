const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body);
    const codigo = body.codigo;
    if (!codigo) return { statusCode: 400, body: JSON.stringify({ error: 'Código não informado' }) };

    // Busca token dos Correios primeiro
    const tokenResult = await new Promise((resolve, reject) => {
      const postData = 'numero=' + codigo;
      const req = https.request({
        hostname: 'proxyapp.correios.com.br',
        path: '/track/json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'CorreiosApp/5.5.2 CFNetwork/1485 Darwin/23.1.0',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => { let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data })); });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    console.log('Correios Status:', tokenResult.status);
    console.log('Correios Response:', tokenResult.body.substring(0, 500));

    if(tokenResult.status !== 200) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Correios retornou ' + tokenResult.status, raw: tokenResult.body.substring(0, 200) })
      };
    }

    const parsed = JSON.parse(tokenResult.body);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    };
  } catch (error) {
    console.log('Error:', error.message);
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: error.message }) };
  }
};
