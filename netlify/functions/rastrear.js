const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const ME_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiM2E5MDY0NDc3ODQ1NTk1MjljNzM5ODMxMTc0MDI0Y2FiM2M0YzBiNDg4ODE4YTc4OWUwZjQwYTVlMjQ1OWY4MGRiNTliZTg5ZjhiMjJkMDkiLCJpYXQiOjE3ODEzNjMxNDYuOTQwMDM0LCJuYmYiOjE3ODEzNjMxNDYuOTQwMDM3LCJleHAiOjE4MTI4OTkxNDYuOTI4ODQ4LCJzdWIiOiI5ZGMxNzhhZC05YWRkLTRjMTQtYTkzMS04OTNmM2RjN2RiZWMiLCJzY29wZXMiOlsic2hpcHBpbmctdHJhY2tpbmciXX0.prxIM-RerxTJnWqOs2n7ZjkfzNbAIPWeXt0pn6pSBQRbSx7U1bLkU0QNp1euon79tZzDe5PJ9KUWKsegdpILCpR7NuLJONxdMUSpVpVhvCAHqWkXbCt7e96ZWMvH5-XqDFGr7tnRhJHBgxKD3eVezkk-Oo5y-UDNa-39UEl-6QMQKOf0Xb04YHS92uBAa3_pqZxbSni32tx3tJocsfMNUzm5fRc91AjO2Plj_3ddFd_xj9AyDq4T9CQ6GZxhSh2APayMh8xDgdMDfkCcdDnxOUtYu9jOQaZHuw8LWi-z7r2cwoyhQoazNJMIGtc14fTMF6TVl85IehXvgJSrbgisKuHwQmPWjPaOaxtEYYBcXPynIN4KksP1MDqKoub0EU7utvu8cU70fyprzmT_0pRf_IpFaZUYNGWKPY-Khpa_WxsXo9Fpp9QT4vO1-ggkvd2XLLQLEdcNZ_YSInhdNy2D2_YrRWo07YhRr0SnxhLOzHoDA_gq-25UKtcEup1wy_9gn0Ft6imKWOG2ZGVHhKLCELp16eXTnQ5r-NRzdI20rodzK9lzJI_0DsuXMZSVS49MTumZdgU4r3CzdXyqANsH8EA98bMpLpWNnlQWdXCTiof-inI_7FfwfU6viq2KBXIlQPbQO-PdlTCIdzQMZiZv4IS6jHh_rkwJpsNiP7d1Ze8";

  try {
    const body = JSON.parse(event.body);
    const codigo = body.codigo;
    if (!codigo) return { statusCode: 400, body: JSON.stringify({ error: 'Código não informado' }) };

    const postData = JSON.stringify({ orders: [codigo] });
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'melhorenvio.com.br',
        path: '/api/v2/me/shipment/tracking',
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${ME_TOKEN}`, 'User-Agent': 'MATRIX/1.0 (euvicentee@gmail.com)', 'Content-Length': Buffer.byteLength(postData) }
      }, (res) => { let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data })); });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    console.log('ME Status:', result.status);
    console.log('ME Response:', result.body.substring(0, 500));

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: JSON.parse(result.body), codigo })
    };
  } catch (error) {
    console.log('Error:', error.message);
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: error.message }) };
  }
};
