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

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.seurastreio.com.br',
        path: '/v1/tracking/' + codigo,
        method: 'GET',
        headers: {
          'Authorization': 'Bearer sr_live_xM3NoEvU2NLqMrY7obQWubbWr-RLJS4b86RIsyt1iQo',
          'Accept': 'application/json',
          'User-Agent': 'MATRIX/1.0'
        }
      }, (res) => { let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data })); });
      req.on('error', reject);
      req.end();
    });

    console.log('SeuRastreio Status:', result.status);
    console.log('SeuRastreio Response:', result.body.substring(0, 500));

    const parsed = JSON.parse(result.body);
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
