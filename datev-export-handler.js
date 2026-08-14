// ── /datev-export Handler ─────────────────────────────────────────
// Exportiert Monatsabschlüsse als DATEV-CSV

async function handleDatevExport(body, env, cors = {}) {
  const { userId, jahr } = body;

  if (!userId || !jahr) {
    return new Response(JSON.stringify({ error: 'Missing userId or jahr' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  try {
    // Firebase Token besorgen
    const token = await getFirebaseToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);

    // Firestore Query: alle monatsabschluesse des Users
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents/users/${userId}/monatsabschluesse`;

    const res = await fetch(firestoreUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      return new Response('Firestore error', { status: res.status, headers: cors });
    }

    const data = await res.json();
    const documents = data.documents || [];

    // Parse Monatsabschlüsse
    const abschluesse = [];
    for (const doc of documents) {
      const fields = doc.fields || {};
      const docJahr = fields.jahr?.integerValue || fields.jahr?.stringValue;
      
      // Nur Dokumente des gewünschten Jahres
      if (String(docJahr) !== String(jahr)) continue;

      const monat = fields.monat?.stringValue || '';
      const einnahmen = parseFloat(fields.einnahmen?.integerValue || fields.einnahmen?.stringValue || 0);
      const ausgaben = parseFloat(fields.ausgaben?.integerValue || fields.ausgaben?.stringValue || 0);
      const gewinn = einnahmen - ausgaben;

      if (monat) {
        abschluesse.push({ monat, einnahmen, ausgaben, gewinn });
      }
    }

    // Sortieren nach Monat (chronologisch)
    const monatOrder = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    abschluesse.sort((a, b) => monatOrder.indexOf(a.monat) - monatOrder.indexOf(b.monat));

    // CSV generieren mit BOM (für Excel DE)
    const bom = '\uFEFF'; // UTF-8 BOM
    let csv = 'Datum,Einnahmen,Ausgaben,Gewinn\n';

    for (const abs of abschluesse) {
      const datum = `01.${monatOrder.indexOf(abs.monat) + 1}.${jahr}`;
      csv += `${datum},${abs.einnahmen.toFixed(2).replace('.', ',')},${abs.ausgaben.toFixed(2).replace('.', ',')},${abs.gewinn.toFixed(2).replace('.', ',')}\n`;
    }

    const csvContent = bom + csv;

    // Response mit Download-Header
    return new Response(csvContent, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="DATEV_KONTOLUX_${jahr}.csv"`,
        'Cache-Control': 'no-cache'
      }
    });

  } catch (err) {
    console.error('DATEV Export Error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
}

// Firebase Token (bereits vorhanden, aber hier für Referenz)
async function getFirebaseToken(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore'
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const pemKey = privateKeyPem.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\\n/g, '').replace(/\n/g, '').trim();
  const keyData = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const encodedSig = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${signingInput}.${encodedSig}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

// Exports für Worker
export { handleDatevExport, getFirebaseToken };
