const https = require('https');
const crypto = require('crypto');

const WEBHOOK_SECRET = 'fad76e6acf342ed76fa0fea2f1e4185b85418942a223b14ba8f5db37af318f2d';
const FIREBASE_PROJECT = 'matrix-eb42e';
const FIREBASE_KEY = 'AIzaSyAPwURZrZGNjZr2IV8Ba0vcp2-b4XkKZ_w';

function validateSignature(signature, body) {
  if (!signature) return false;
  const parts = {};
  signature.split(',').forEach(p => {
    const [k, v] = p.split('=');
    parts[k] = v;
  });
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(`${t}.${body}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const signature = event.headers['x-seurastreio-signature'] || event.headers['X-SeuRastreio-Signature'];
  if (!validateSignature(signature, event.body)) {
    console.log('Invalid signature!');
    return { statusCode: 401, body: 'Unauthorized' };
  }

  try {
    const payload = JSON.parse(event.body);
    console.log('Webhook received:', JSON.stringify(payload).substring(0, 300));

    const codigo = payload.codigo;
    const evento = payload.eventoMaisRecente || payload.evento;
    
    if (!codigo || !evento) {
      return { statusCode: 200, body: 'OK - no data' };
    }

    const trackStatus = evento.descricao || '—';
    const trackData = (evento.data ? evento.data.split('T')[0].split('-').reverse().join('/') : '') +
                      (evento.data && evento.data.includes('T') ? ' ' + evento.data.split('T')[1].substring(0,5) : '') +
                      (evento.local ? ' — ' + evento.local : '');
    const previsao = payload.previsaoEntrega || '';

    const queryBody = JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'dados' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'rastreamento' },
            op: 'EQUAL',
            value: { stringValue: codigo }
          }
        }
      }
    });

    const queryResult = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'firestore.googleapis.com',
        path: `/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${FIREBASE_KEY}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(queryBody) }
      }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
      req.on('error', reject);
      req.write(queryBody);
      req.end();
    });

    let updated = 0;
    for (const doc of queryResult) {
      if (doc.document) {
        const docPath = doc.document.name;
        const updateBody = JSON.stringify({
          fields: {
            trackStatus: { stringValue: trackStatus },
            trackData: { stringValue: trackData },
            previsaoEntrega: { stringValue: previsao }
          }
        });
        await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'firestore.googleapis.com',
            path: `/v1/${docPath}?updateMask.fieldPaths=trackStatus&updateMask.fieldPaths=trackData&updateMask.fieldPaths=previsaoEntrega&key=${FIREBASE_KEY}`,
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(updateBody) }
          }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
          req.on('error', reject);
          req.write(updateBody);
          req.end();
        });
        updated++;
      }
    }

    const padQueryBody = queryBody.replace('"dados"', '"pads"');
    const padResult = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'firestore.googleapis.com',
        path: `/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${FIREBASE_KEY}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(padQueryBody) }
      }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
      req.on('error', reject);
      req.write(padQueryBody);
      req.end();
    });

    for (const doc of padResult) {
      if (doc.document) {
        const docPath = doc.document.name;
        const updateBody = JSON.stringify({
          fields: {
            trackStatus: { stringValue: trackStatus },
            trackData: { stringValue: trackData },
            previsaoEntrega: { stringValue: previsao }
          }
        });
        await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'firestore.googleapis.com',
            path: `/v1/${docPath}?updateMask.fieldPaths=trackStatus&updateMask.fieldPaths=trackData&updateMask.fieldPaths=previsaoEntrega&key=${FIREBASE_KEY}`,
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(updateBody) }
          }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
          req.on('error', reject);
          req.write(updateBody);
          req.end();
        });
        updated++;
      }
    }

    console.log(`Updated ${updated} documents for ${codigo}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, updated }) };

  } catch (error) {
    console.log('Webhook error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
