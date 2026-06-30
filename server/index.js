require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(express.json());

const {
  APS_CLIENT_ID, APS_CLIENT_SECRET,
  APS_CALLBACK_URL = 'http://localhost:8080/api/auth/callback',
  ACC_PROJECT_ID, ACC_MODEL_URN, PORT = 8080,
} = process.env;

const ACC_FOLDER_URN = 'urn:adsk.wipprod:fs.folder:co.y57lR8imTbuJh37gU440fA';
const VERSION_URN = 'urn:adsk.wipprod:fs.file:vf.Fs-fmn5sROy4n6m4S5jokA?version=28';
const VIEWABLE_GUID  = '40d54ded-3c29-f5a3-ed21-dc3126f84375';

const DERIVATIVE_URN = Buffer.from(VERSION_URN).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

console.log('[Config] Derivative URN:', DERIVATIVE_URN);
console.log('=== CONFIG CHARGÉE ===');
console.log('CLIENT_ID:', APS_CLIENT_ID);
console.log('CLIENT_SECRET présent:', !!APS_CLIENT_SECRET);
console.log('CLIENT_SECRET longueur:', APS_CLIENT_SECRET?.length);
console.log('CALLBACK_URL:', APS_CALLBACK_URL);
console.log('======================');

let session = { token: null, refreshToken: null, expiresAt: 0 };

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/api/auth/login', (req, res) => {
  const url = new URL('https://developer.api.autodesk.com/authentication/v2/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id',     APS_CLIENT_ID);
  url.searchParams.set('redirect_uri',  APS_CALLBACK_URL);
  url.searchParams.set('scope',         'data:read data:write viewables:read');
  console.log('[Login] Redirection vers:', url.toString());
  res.redirect(url.toString());
});

app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Code manquant');

  console.log('=== DEBUG CALLBACK ===');
  console.log('Code reçu:', code?.slice(0, 10) + '...');
  console.log('CLIENT_ID:', APS_CLIENT_ID);
  console.log('CLIENT_SECRET présent:', !!APS_CLIENT_SECRET);
  console.log('CALLBACK_URL:', APS_CALLBACK_URL);

  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    client_id:     APS_CLIENT_ID,
    client_secret: APS_CLIENT_SECRET,
    redirect_uri:  APS_CALLBACK_URL,
  });
  console.log('Body envoyé:', params.toString().replace(APS_CLIENT_SECRET, '***'));
  console.log('======================');

  try {
    const resp = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params,
    });
    const text = await resp.text();
    console.log('[Callback] Réponse Autodesk:', resp.status, text);
    if (!resp.ok) throw new Error(`${resp.status} — ${text}`);
    const data = JSON.parse(text);
    session = {
      token:        data.access_token,
      refreshToken: data.refresh_token,
      expiresAt:    Date.now() + (data.expires_in - 60) * 1000,
    };
    console.log('[Auth] Connecté ✓');
    res.redirect('/');
  } catch (err) {
    console.error('[Auth] Erreur:', err.message);
    res.redirect('/?error=' + encodeURIComponent(err.message));
  }
});

async function getValidToken() {
  if (session.token && Date.now() < session.expiresAt) return session.token;
  if (session.refreshToken) {
    const resp = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: session.refreshToken,
        client_id:     APS_CLIENT_ID,
        client_secret: APS_CLIENT_SECRET,
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      session = {
        token:        data.access_token,
        refreshToken: data.refresh_token || session.refreshToken,
        expiresAt:    Date.now() + (data.expires_in - 60) * 1000,
      };
      return session.token;
    }
  }
  throw new Error('NON_AUTHENTIFIE');
}

app.get('/api/auth/status', (req, res) => {
  res.json({ connected: !!(session.token && Date.now() < session.expiresAt + 3600000) });
});

app.get('/api/token', async (req, res) => {
  try { res.json({ access_token: await getValidToken(), expires_in: 3600 }); }
  catch { res.status(401).json({ error: 'NON_AUTHENTIFIE' }); }
});

app.get('/api/config', (req, res) => {
  res.json({ modelUrn: DERIVATIVE_URN, viewableGuid: VIEWABLE_GUID, versionUrn: VERSION_URN });
});

// ── Vérifier / Déclencher la traduction SVF2 ──────────────────────────────────

app.get('/api/check-model', async (req, res) => {
  try {
    const token = await getValidToken();
    const urn   = req.query.urn || DERIVATIVE_URN;
    const url   = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/metadata`;
    const resp  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text  = await resp.text();
    console.log(`[CheckModel] ${resp.status}: ${text.slice(0, 300)}`);
    res.json({ status: resp.status, urn, body: text.slice(0, 1000) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/translate', async (req, res) => {
  try {
    const token = await getValidToken();
    const body  = {
      input:  { urn: DERIVATIVE_URN, compressedUrn: false },
      output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] },
    };
    const resp = await fetch('https://developer.api.autodesk.com/modelderivative/v2/designdata/job', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ads-force': 'true' },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    console.log('[Translate]', resp.status, text.slice(0, 300));
    res.json({ status: resp.status, body: text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/manifest', async (req, res) => {
  try {
    const token = await getValidToken();
    const url   = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${DERIVATIVE_URN}/manifest`;
    const resp  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text  = await resp.text();
    console.log(`[Manifest] ${resp.status}: ${text.slice(0, 400)}`);
    res.json({ status: resp.status, body: text.slice(0, 2000) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/list-models', async (req, res) => {
  try {
    const token         = await getValidToken();
    const projectId     = 'eb5f9611-c334-411f-b5bd-5d555f107c74';
    const folderUrn     = 'urn:adsk.wipprod:fs.folder:co.y57lR8imTbuJh37gU440fA';
    const encodedFolder = encodeURIComponent(folderUrn);
    const url  = `https://developer.api.autodesk.com/data/v1/projects/b.${projectId}/folders/${encodedFolder}/contents`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();
    res.json((data.included || []).map(i => ({
      name:    i.attributes?.displayName,
      urn:     i.id,
      version: i.attributes?.versionNumber,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── OBJ : Extraction depuis APS ──────────────────────────────────────────────
// APS ne supporte pas glTF en sortie — on utilise OBJ (supporté par Three.js)

// ÉTAPE 1 — Lancer la conversion APS → OBJ
// POST /api/extract-gltf  (nom conservé pour compatibilité)
app.post('/api/extract-gltf', async (req, res) => {
  try {
    const token = await getValidToken();
    const body  = {
      input:  { urn: DERIVATIVE_URN, compressedUrn: false },
      output: {
        formats: [{
          type: 'obj',
          advanced: {
            exportFileStructure: 'single',
            unit: 'meter',
            modelGuid: VIEWABLE_GUID,
            objectIds: [-1],   // -1 = tous les objets
          },
        }],
      },
    };
    console.log('[OBJ] Lancement conversion APS → OBJ...');
    const resp = await fetch('https://developer.api.autodesk.com/modelderivative/v2/designdata/job', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ads-force': 'true' },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    console.log('[OBJ] Réponse APS:', resp.status, text.slice(0, 300));
    if (!resp.ok) return res.status(resp.status).json({ error: text });
    res.json({ message: 'Conversion OBJ lancée. Vérifiez avec GET /api/gltf-status', status: resp.status, body: JSON.parse(text) });
  } catch (err) { console.error('[OBJ] Erreur lancement:', err); res.status(500).json({ error: err.message }); }
});

// ÉTAPE 2 — Vérifier le statut
// GET /api/gltf-status
app.get('/api/gltf-status', async (req, res) => {
  try {
    const token = await getValidToken();
    const url   = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${DERIVATIVE_URN}/manifest`;
    const resp  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return res.status(resp.status).json({ error: await resp.text() });
    const manifest = await resp.json();

    const objDerivatives = [];
    function scanDerivatives(derivatives) {
      if (!derivatives) return;
      for (const d of derivatives) {
        if (d.urn?.endsWith('.obj') || d.role === 'obj') {
          objDerivatives.push({ urn: d.urn, mime: d.mime, role: d.role });
        }
        if (d.children) scanDerivatives(d.children);
      }
    }
    scanDerivatives(manifest.derivatives);

    const overallStatus = manifest.status || 'unknown';
    const progress      = manifest.progress || '0%';
    console.log(`[OBJ] Statut: ${overallStatus} (${progress}) — ${objDerivatives.length} fichier(s) OBJ`);
    res.json({ status: overallStatus, progress, gltfFiles: objDerivatives, ready: overallStatus === 'success' && objDerivatives.length > 0 });
  } catch (err) { console.error('[glTF] Erreur statut:', err); res.status(500).json({ error: err.message }); }
});

// ÉTAPE 3 — Télécharger le .obj dans /assets/model.obj
// GET /api/download-gltf  (nom conservé pour compatibilité)
app.get('/api/download-gltf', async (req, res) => {
  try {
    const token       = await getValidToken();
    const manifestUrl = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${DERIVATIVE_URN}/manifest`;
    const manifestResp = await fetch(manifestUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!manifestResp.ok) throw new Error('Impossible de récupérer le manifest');
    const manifest = await manifestResp.json();

    // Chercher le fichier .obj dans le manifest (scan récursif)
    let objUrn = null;
    function findObj(derivatives) {
      if (!derivatives) return;
      for (const d of derivatives) {
        if (d.urn?.endsWith('.obj') || d.role === 'obj') { objUrn = d.urn; return; }
        if (d.children) findObj(d.children);
      }
    }
    findObj(manifest.derivatives);

    // Si pas de .obj, afficher le manifest complet pour diagnostic
    if (!objUrn) {
      console.warn('[OBJ] Aucun .obj trouvé — manifest:', JSON.stringify(manifest).slice(0, 800));
      return res.status(404).json({
        error: 'Aucun fichier OBJ trouvé. Lancez POST /api/extract-gltf et attendez "ready: true".',
        manifest_status: manifest.status,
        manifest_progress: manifest.progress,
      });
    }

    console.log('[OBJ] Téléchargement:', objUrn);
    const dlUrl  = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${DERIVATIVE_URN}/manifest/${encodeURIComponent(objUrn)}`;
    const dlResp = await fetch(dlUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!dlResp.ok) throw new Error(`Erreur téléchargement: ${dlResp.status} — ${(await dlResp.text()).slice(0, 200)}`);

    const assetsDir  = path.join(__dirname, '../assets');
    const outputPath = path.join(assetsDir, 'model.obj');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    const buffer = await dlResp.arrayBuffer();
    fs.writeFileSync(outputPath, Buffer.from(buffer));

    const sizeMb = (buffer.byteLength / 1024 / 1024).toFixed(1);
    console.log(`[OBJ] Sauvegardé: ${outputPath} (${sizeMb} Mo)`);
    res.json({ success: true, path: '/assets/model.obj', sizeMb: parseFloat(sizeMb), message: `model.obj sauvegardé (${sizeMb} Mo). Générez le snapshot avec /api/export-snapshot` });
  } catch (err) { console.error('[OBJ] Erreur téléchargement:', err); res.status(500).json({ error: err.message }); }
});

// ── Snapshot HTML statique ────────────────────────────────────────────────────

// GET /api/export-snapshot          → télécharge le HTML
// GET /api/export-snapshot?mode=view → affiche dans le navigateur
app.get('/api/export-snapshot', async (req, res) => {
  try {
    const assetsDir    = path.join(__dirname, '../assets');
    const elementsPath = path.join(assetsDir, 'data.json');
    const leveesPath   = path.join(assetsDir, 'levees.json');

    let elements = [];
    let levees   = [];

    if (fs.existsSync(elementsPath)) {
      elements = JSON.parse(fs.readFileSync(elementsPath, 'utf8'));
    } else {
      console.warn('[Snapshot] data.json absent');
    }

    if (fs.existsSync(leveesPath)) {
      levees = JSON.parse(fs.readFileSync(leveesPath, 'utf8'));
    } else {
      levees = buildLeveesFromElementsNode(elements);
    }

    const stats    = computeStatsNode(levees);
    const date     = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
    const html     = generateSnapshotHTML(stats, levees, date);
    const filename = `SGTM_BIM_Snapshot_${new Date().toISOString().slice(0, 10)}.html`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if ((req.query.mode || 'download') === 'download') {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    res.send(html);
    console.log(`[Snapshot] Généré ✓ — ${levees.length} levées, ${stats.pctGlobal}% global`);
  } catch (err) {
    console.error('[Snapshot] Erreur:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers Node.js ───────────────────────────────────────────────────────────

function buildLeveesFromElementsNode(elements) {
  const dict = {};
  for (const el of elements) {
    if (el.reste) continue;
    if ((el.categorie || '') !== 'Revit Murs') continue;
    const leveeNum = el.levee && el.levee !== '0' ? el.levee : null;
    if (!leveeNum) continue;
    const phase = el.phase || '?';
    if (phase === 'Phase 0' || phase === '?') continue;
    const key = `${el.bloc}|${el.chambord}|${phase}|${leveeNum}`;
    if (!dict[key]) dict[key] = { bloc: el.bloc, chambord: el.chambord, phase: el.phase, levee: el.levee, statuts: [] };
    dict[key].statuts.push(el.statut);
  }
  return Object.values(dict).map(d => ({
    bloc: d.bloc, chambord: d.chambord, phase: d.phase, levee: d.levee,
    statut: d.statuts.every(s => s === 'realise') ? 'realise' : 'non_realise',
  }));
}

function computeStatsNode(levees) {
  const total    = levees.length;
  const byStatut = { realise: 0, non_realise: 0 };
  const byBloc   = {};
  const byChambord = {};
  for (const l of levees) {
    byStatut[l.statut] = (byStatut[l.statut] || 0) + 1;
    if (l.bloc) {
      if (!byBloc[l.bloc]) byBloc[l.bloc] = { total: 0, realise: 0, non_realise: 0 };
      byBloc[l.bloc].total++;
      byBloc[l.bloc][l.statut] = (byBloc[l.bloc][l.statut] || 0) + 1;
    }
    if (l.chambord) {
      if (!byChambord[l.chambord]) byChambord[l.chambord] = { total: 0, realise: 0, non_realise: 0 };
      byChambord[l.chambord].total++;
      byChambord[l.chambord][l.statut] = (byChambord[l.chambord][l.statut] || 0) + 1;
    }
  }
  return { total, byStatut, byBloc, byChambord, pctGlobal: total > 0 ? Math.round((byStatut.realise / total) * 100) : 0 };
}

// ── Générateur HTML snapshot avec Three.js ────────────────────────────────────

function generateSnapshotHTML(stats, levees, date) {
  const statsJSON  = JSON.stringify(stats);
  const leveesJSON = JSON.stringify(levees);

  const blocs = Object.keys(stats.byBloc).sort();
  const SGTM_BLOCS = new Set(['1', '2', '3']);
  const TGCC_BLOCS = new Set(['4']);
  let sgtmReal = 0, sgtmTot = 0, tgccReal = 0, tgccTot = 0;
  for (const [bloc, d] of Object.entries(stats.byBloc)) {
    if (SGTM_BLOCS.has(bloc)) { sgtmReal += d.realise || 0; sgtmTot += d.total || 0; }
    if (TGCC_BLOCS.has(bloc)) { tgccReal += d.realise || 0; tgccTot += d.total || 0; }
  }
  const sgtmPct = sgtmTot > 0 ? Math.round(sgtmReal / sgtmTot * 100) : 0;
  const tgccPct = tgccTot > 0 ? Math.round(tgccReal / tgccTot * 100) : 0;

  const chambordRowsData = JSON.stringify(
    Object.entries(stats.byChambord)
      .sort(([a], [b]) => (parseInt(a.replace(/\D/g, '')) || 0) - (parseInt(b.replace(/\D/g, '')) || 0) || a.localeCompare(b))
      .map(([name, d]) => {
        const pct = d.total > 0 ? Math.round(d.realise / d.total * 100) : 0;
        const col = pct >= 70 ? '#22b07d' : pct >= 40 ? '#E87722' : '#D93025';
        return { name, total: d.total, realise: d.realise || 0, pct, col };
      })
  );

  const chambordRowsHTML = JSON.parse(chambordRowsData).map(r => `
    <tr onclick="highlightChambord('${r.name}')" style="cursor:pointer">
      <td><strong>${r.name}</strong></td>
      <td class="tc">${r.total}</td>
      <td class="tc tg">${r.realise}</td>
      <td class="tc">
        <div class="pw"><div class="pb"><div class="pf" style="width:${r.pct}%;background:${r.col}"></div></div>
        <span style="color:${r.col};font-weight:600;font-size:10px;min-width:28px">${r.pct}%</span></div>
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>SGTM – Suivi Avancement BIM | ${date}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/three@0.158.0/build/three.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/three@0.158.0/examples/js/loaders/OBJLoader.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/three@0.158.0/examples/js/controls/OrbitControls.js"><\/script>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --org:#E87722;--grn:#22b07d;--red:#D93025;
  --dark:#1a1a1a;--muted:#6b6b6b;--border:#e8e5e0;
  --bg:#f5f3ef;--card:#fff;--accent:#fdf6ef;
}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--dark);min-height:100vh}

/* HEADER */
.hdr{background:var(--dark);padding:0 28px;display:flex;align-items:center;justify-content:space-between;height:60px;position:sticky;top:0;z-index:200;box-shadow:0 2px 12px rgba(0,0,0,.3)}
.hl{display:flex;align-items:center;gap:14px}
.hdiv{width:1px;height:28px;background:#444}
.bn{font-size:17px;font-weight:700;color:#fff;letter-spacing:2px}
.bs{font-size:9px;color:#999;letter-spacing:1px}
.hp{font-size:11px;color:#bbb;max-width:340px;line-height:1.4}
.hr2{display:flex;align-items:center;gap:12px}
.sbadge{background:var(--org);color:#fff;font-size:9px;font-weight:700;letter-spacing:1px;padding:3px 9px;border-radius:20px}
.hdate{font-size:10px;color:#888;font-family:'DM Mono',monospace}

/* BANNER */
.banner{background:linear-gradient(135deg,#fef3c7,#fde68a);border-bottom:2px solid #f59e0b;padding:9px 28px;display:flex;align-items:center;gap:8px;font-size:11px;color:#92400e}

/* LAYOUT */
.wrap{max-width:1440px;margin:0 auto;padding:20px 28px 40px}

/* SECTION TITLE */
.st{font-size:9px;font-weight:700;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.st::after{content:'';flex:1;height:1px;background:var(--border)}

/* KPI ROW */
.krow{display:grid;grid-template-columns:170px 1fr 200px 200px;gap:14px;margin-bottom:18px}

/* CARD */
.card{background:var(--card);border-radius:12px;border:1px solid var(--border);padding:18px;box-shadow:0 1px 4px rgba(0,0,0,.04)}
.clbl{font-size:9px;font-weight:700;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:12px}

/* DONUT */
.dw{position:relative;width:110px;height:110px;margin:0 auto 10px}
.dc{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column}
.dpct{font-size:24px;font-weight:700;color:var(--org);line-height:1}
.dlbl{font-size:8px;color:var(--muted);margin-top:1px}
.dstats{display:flex;flex-direction:column;gap:5px}
.dsl{display:flex;justify-content:space-between;font-size:10px}
.dsk{color:var(--muted)}.dsv{font-weight:600;font-family:'DM Mono',monospace}

/* ENT */
.ei{margin-bottom:14px}.ei:last-child{margin-bottom:0}
.eh{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
.en{font-size:12px;font-weight:700}.en.sg{color:var(--org)}.en.tg{color:#4a7dc8}
.ep{font-size:16px;font-weight:700;font-family:'DM Mono',monospace}
.eb{height:7px;background:var(--bg);border-radius:4px;overflow:hidden}
.ef{height:100%;border-radius:4px}
.sg-fill{background:linear-gradient(90deg,var(--org),#f5943a)}
.tg-fill{background:linear-gradient(90deg,#4a7dc8,#6b9de8)}
.enote{font-size:9px;color:var(--muted);margin-top:8px}

/* KPI STACK */
.ks{display:flex;flex-direction:column;gap:0;height:100%;justify-content:center}
.ki{display:flex;align-items:center;gap:12px;padding:11px 0}
.ki+.ki{border-top:1px solid var(--border)}
.kic{width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.kic.o{background:rgba(232,119,34,.1);color:var(--org)}.kic.g{background:rgba(34,176,125,.1);color:var(--grn)}
.ksub{font-size:8px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:1px}
.knum{font-size:20px;font-weight:700;font-family:'DM Mono',monospace}.knum.g{color:var(--grn)}

/* BOTTOM GRID */
.bgrid{display:grid;grid-template-columns:1fr 360px;gap:14px;margin-top:4px}

/* VIEWER */
.vp{display:flex;flex-direction:column;min-height:500px}
.vtb{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.vbtn{background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:5px 11px;font-size:10px;font-family:'DM Sans',sans-serif;color:var(--dark);cursor:pointer;display:flex;align-items:center;gap:5px;transition:all .15s}
.vbtn:hover{background:var(--accent);border-color:var(--org);color:var(--org)}
.vbtn.active{background:var(--org);color:#fff;border-color:var(--org)}
.vleg{display:flex;align-items:center;gap:12px;font-size:10px;color:var(--muted);margin-left:auto}
.ld{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:3px}
.vcw{flex:1;position:relative;border-radius:10px;overflow:hidden;background:#1e2330;min-height:420px}
#threeCanvas{display:block;width:100%!important;height:100%!important}

/* LOADER */
.vov{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1e2330;z-index:10}
.vsp{width:36px;height:36px;border:3px solid rgba(232,119,34,.2);border-top-color:var(--org);border-radius:50%;animation:spin .8s linear infinite;margin-bottom:12px}
@keyframes spin{to{transform:rotate(360deg)}}
.vtxt{font-size:12px;color:#aaa;margin-bottom:6px}
.vpbar{width:180px;height:4px;background:rgba(255,255,255,.1);border-radius:2px}
.vpfill{height:100%;border-radius:2px;background:var(--org);transition:width .3s}
.vpct{font-size:10px;color:#666;margin-top:5px;font-family:'DM Mono',monospace}

/* NO MODEL */
.vnm{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;background:#1e2330;z-index:10;text-align:center;padding:24px}
.vnmi{font-size:36px;margin-bottom:12px}
.vnmt{font-size:14px;font-weight:600;color:#ccc;margin-bottom:8px}
.vnmd{font-size:11px;color:#666;max-width:260px;line-height:1.6}
.vnmc{margin-top:14px;background:rgba(255,255,255,.05);border-radius:8px;padding:10px 14px}
.vnmc code{font-family:'DM Mono',monospace;font-size:10px;color:var(--org)}

/* TABLE */
.tp{display:flex;flex-direction:column}
.tsr{width:100%;border:1px solid var(--border);border-radius:8px;padding:6px 11px;font-size:11px;font-family:'DM Sans',sans-serif;outline:none;margin-bottom:10px;color:var(--dark);background:var(--bg)}
.tsr:focus{border-color:var(--org)}
.tw{overflow-y:auto;flex:1;max-height:420px}
.dt{width:100%;border-collapse:collapse;font-size:11px}
.dt th{text-align:left;padding:7px 9px;font-size:8px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:2px solid var(--border);position:sticky;top:0;background:var(--card)}
.dt td{padding:6px 9px;border-bottom:1px solid #f0eeeb;vertical-align:middle}
.dt tr:hover td{background:var(--accent)}
.dt tr.sel td{background:#fdf0e6}
.tc{text-align:center}.tg{color:var(--grn);font-weight:600}
.pw{display:flex;align-items:center;gap:6px;justify-content:center}
.pb{width:52px;height:5px;background:var(--bg);border-radius:3px;overflow:hidden;flex-shrink:0}
.pf{height:100%;border-radius:3px}
.tf{font-size:9px;color:var(--muted);margin-top:8px;text-align:right}

/* BLOC GRID */
.bgr{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:9px;margin-top:4px}
.bc{background:var(--bg);border-radius:9px;padding:12px;border:1px solid var(--border)}
.bcn{font-size:9px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;margin-bottom:6px}
.bcp{font-size:26px;font-weight:700;font-family:'DM Mono',monospace;line-height:1;margin-bottom:5px}
.bcb{height:4px;background:#e5e2dc;border-radius:2px;overflow:hidden;margin-bottom:5px}
.bcf{height:100%;border-radius:2px}
.bcd{font-size:9px;color:var(--muted);font-family:'DM Mono',monospace}

/* BLOC CHART */
.bchw{position:relative;min-height:130px}

/* FOOTER */
.foot{text-align:center;padding:16px 28px;font-size:9px;color:var(--muted);border-top:1px solid var(--border);margin-top:28px;letter-spacing:.5px}

@media print{.banner,.vtb{display:none}body{background:#fff}}
@media(max-width:1100px){.krow{grid-template-columns:1fr 1fr}.bgrid{grid-template-columns:1fr}}
@media(max-width:640px){.wrap{padding:12px}.krow{grid-template-columns:1fr}.hdr{padding:0 14px}.hp{display:none}}
</style>
</head>
<body>

<header class="hdr">
  <div class="hl">
    <svg viewBox="0 0 60 52" fill="none" width="40" height="34">
      <polygon points="30,2 58,50 2,50" fill="#E87722"/>
      <text x="7" y="48" font-family="Arial Black,Arial" font-weight="900" font-size="14" fill="white" letter-spacing="1">SGTM</text>
    </svg>
    <div class="hdiv"></div>
    <div><div class="bn">SGTM</div><div class="bs">Société Générale des Travaux du Maroc</div></div>
    <div class="hdiv"></div>
    <div class="hp">Grand Stade de Casablanca — Province de Benslimane<br>Lot n°2 · Suivi Avancement Calepinage BIM — Chambords</div>
  </div>
  <div class="hr2">
    <span class="sbadge">SNAPSHOT STATIQUE</span>
    <span class="hdate">${date}</span>
  </div>
</header>

<div class="banner">
  ⚠️&nbsp;
  <span><strong>Vue en lecture seule.</strong> Export statique généré le ${date}.
  Pour la maquette interactive, accédez au <strong>dashboard ACC</strong> avec votre compte Autodesk.</span>
</div>

<div class="wrap">

  <div class="st">Indicateurs clés d'avancement</div>
  <div class="krow">

    <!-- Donut -->
    <div class="card" style="display:flex;flex-direction:column;align-items:center">
      <div class="clbl">Avancement Global</div>
      <div class="dw">
        <canvas id="donutChart" width="110" height="110"></canvas>
        <div class="dc"><span class="dpct">${stats.pctGlobal}%</span><span class="dlbl">réalisé</span></div>
      </div>
      <div class="dstats" style="width:100%">
        <div class="dsl"><span class="dsk">Réalisées</span><span class="dsv">${(stats.byStatut.realise || 0).toLocaleString('fr-FR')} / ${stats.total.toLocaleString('fr-FR')}</span></div>
        <div class="dsl"><span class="dsk">Restantes</span><span class="dsv">${(stats.total - (stats.byStatut.realise || 0)).toLocaleString('fr-FR')}</span></div>
      </div>
    </div>

    <!-- Bloc chart -->
    <div class="card" style="display:flex;flex-direction:column">
      <div class="clbl">Avancement par Bloc</div>
      <div class="bchw"><canvas id="blocChart"></canvas></div>
    </div>

    <!-- Enterprise -->
    <div class="card">
      <div class="clbl">Avancement Entreprise</div>
      <div class="ei">
        <div class="eh"><span class="en sg">SGTM</span><span class="ep">${sgtmPct}%</span></div>
        <div class="eb"><div class="ef sg-fill" style="width:${sgtmPct}%"></div></div>
      </div>
      <div class="ei">
        <div class="eh"><span class="en tg">TGCC</span><span class="ep">${tgccPct}%</span></div>
        <div class="eb"><div class="ef tg-fill" style="width:${tgccPct}%"></div></div>
      </div>
      <div class="enote">Levées réalisées par entreprise</div>
    </div>

    <!-- KPI -->
    <div class="card">
      <div class="clbl">Levées</div>
      <div class="ks">
        <div class="ki">
          <div class="kic o"><svg viewBox="0 0 24 24" fill="currentColor" width="16"><path d="M3 7L12 2l9 5v10l-9 5-9-5V7z"/></svg></div>
          <div><div class="ksub">Total</div><div class="knum">${stats.total.toLocaleString('fr-FR')}</div></div>
        </div>
        <div class="ki">
          <div class="kic g"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16"><circle cx="12" cy="12" r="9"/><path d="M7 12l3 3 6-6"/></svg></div>
          <div><div class="ksub">Réalisées</div><div class="knum g">${(stats.byStatut.realise || 0).toLocaleString('fr-FR')}</div></div>
        </div>
      </div>
    </div>

  </div><!-- /krow -->

  <!-- Blocs -->
  <div class="st" style="margin-top:6px">Détail par bloc</div>
  <div class="card" style="margin-bottom:18px">
    <div class="bgr" id="blocGrid"></div>
  </div>

  <!-- Maquette + Table -->
  <div class="st">Maquette 3D & Avancement par chambord</div>
  <div class="bgrid">

    <!-- VIEWER -->
    <div class="card vp">
      <div class="clbl">Maquette 3D – Calepinage (statut réalisé / non réalisé)</div>
      <div class="vtb">
        <button class="vbtn" onclick="resetCamera()">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" width="11"><path d="M8 2v6l3 3"/><circle cx="8" cy="8" r="6"/></svg>
          Vue initiale
        </button>
        <button class="vbtn" onclick="toggleColoring()" id="btnColor">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" width="11"><circle cx="8" cy="8" r="5"/><path d="M5 8l2 2 4-4"/></svg>
          Couleurs statut
        </button>
        <button class="vbtn" onclick="showAll()">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" width="11"><circle cx="8" cy="8" r="3"/><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/></svg>
          Tout afficher
        </button>
        <div class="vleg">
          <span><span class="ld" style="background:#22b07d"></span>Réalisé</span>
          <span><span class="ld" style="background:#D93025"></span>Non réalisé</span>
        </div>
      </div>
      <div class="vcw" id="viewerWrap">
        <div class="vov" id="viewerOverlay">
          <div class="vsp"></div>
          <div class="vtxt" id="vloadText">Chargement de la maquette…</div>
          <div class="vpbar"><div class="vpfill" id="vloadFill" style="width:0%"></div></div>
          <div class="vpct" id="vloadPct">0%</div>
        </div>
        <div class="vnm" id="viewerNoModel">
          <div class="vnmi">🏗️</div>
          <div class="vnmt">Maquette non disponible</div>
          <div class="vnmd">Le fichier <code>model.obj</code> n'a pas été généré.<br>Exécutez les étapes suivantes :</div>
          <div class="vnmc">
            <code>1. POST /api/extract-gltf</code><br><br>
            <code>2. GET  /api/gltf-status</code><br><br>
            <code>3. GET  /api/download-gltf</code><br><br>
            <code>4. GET  /api/export-snapshot</code>
          </div>
        </div>
        <canvas id="threeCanvas"></canvas>
      </div>
    </div>

    <!-- TABLE -->
    <div class="card tp">
      <div class="clbl">Avancement par Chambord</div>
      <input type="text" class="tsr" placeholder="Filtrer par chambord…" oninput="filterTable(this.value)"/>
      <div class="tw">
        <table class="dt">
          <thead><tr><th>Chambord</th><th class="tc">Total</th><th class="tc">Réalisées</th><th class="tc">%</th></tr></thead>
          <tbody id="chambordBody">${chambordRowsHTML}</tbody>
        </table>
      </div>
      <div class="tf" id="tblFoot">${Object.keys(stats.byChambord).length} chambords</div>
    </div>

  </div>

</div><!-- /wrap -->

<footer class="foot">
  SGTM · Société Générale des Travaux du Maroc · Grand Stade de Casablanca · Snapshot BIM — ${date} · Document à usage interne
</footer>

<script>
const STATS  = ${statsJSON};
const LEVEES = ${leveesJSON};
const ALL_ROWS = ${chambordRowsData};

// Map chambord → statut pour colorisation Three.js
const CHAMBORD_STATUS = {};
for (const [name, d] of Object.entries(STATS.byChambord)) {
  CHAMBORD_STATUS[name] = d.total > 0 && d.realise / d.total >= 0.5 ? 'realise' : 'non_realise';
}

// ── Charts ────────────────────────────────────────────────────────────────────
new Chart(document.getElementById('donutChart'), {
  type: 'doughnut',
  data: { datasets: [{ data: [${stats.pctGlobal}, ${100 - stats.pctGlobal}], backgroundColor: ['#E87722','#E5E2DC'], borderWidth: 0 }] },
  options: { responsive: true, cutout: '80%', animation: { duration: 800 }, plugins: { legend: { display: false }, tooltip: { enabled: false } } },
});

const BLOCS = ${JSON.stringify(blocs)};
new Chart(document.getElementById('blocChart'), {
  type: 'bar',
  data: {
    labels: BLOCS.map(b => 'Bloc ' + b),
    datasets: [
      { label: 'Réalisé', data: BLOCS.map(b => STATS.byBloc[b]?.realise || 0), backgroundColor: '#E87722', borderRadius: 4, borderSkipped: false },
      { label: 'Total',   data: BLOCS.map(b => STATS.byBloc[b]?.total   || 0), backgroundColor: '#8A8480', borderRadius: 4, borderSkipped: false },
    ],
  },
  options: {
    responsive: true, maintainAspectRatio: false, animation: { duration: 500 },
    plugins: {
      legend: { display: true, position: 'bottom', labels: { font: { size: 9 }, boxWidth: 9, padding: 5, color: '#6B6B6B' } },
      tooltip: { callbacks: { label: c => ' ' + c.parsed.y.toLocaleString('fr-FR') + ' levées' } },
    },
    scales: { x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#888' } }, y: { grid: { color: '#F0EFED' }, ticks: { font: { size: 9 }, color: '#AAA' } } },
  },
});

// Bloc cards
document.getElementById('blocGrid').innerHTML = BLOCS.map(b => {
  const d = STATS.byBloc[b];
  const pct = d.total > 0 ? Math.round(d.realise / d.total * 100) : 0;
  const col = pct >= 70 ? '#22b07d' : pct >= 40 ? '#E87722' : '#D93025';
  return \`<div class="bc">
    <div class="bcn">Bloc \${b}</div>
    <div class="bcp" style="color:\${col}">\${pct}%</div>
    <div class="bcb"><div class="bcf" style="width:\${pct}%;background:\${col}"></div></div>
    <div class="bcd">\${(d.realise||0).toLocaleString('fr-FR')} / \${d.total.toLocaleString('fr-FR')}</div>
  </div>\`;
}).join('');

// ── Table filter ──────────────────────────────────────────────────────────────
function filterTable(q) {
  const rows = ALL_ROWS.filter(r => r.name.toLowerCase().includes(q.toLowerCase()));
  document.getElementById('chambordBody').innerHTML = rows.map(r => \`
    <tr onclick="highlightChambord('\${r.name}')" style="cursor:pointer">
      <td><strong>\${r.name}</strong></td>
      <td class="tc">\${r.total}</td>
      <td class="tc tg">\${r.realise}</td>
      <td class="tc">
        <div class="pw"><div class="pb"><div class="pf" style="width:\${r.pct}%;background:\${r.col}"></div></div>
        <span style="color:\${r.col};font-weight:600;font-size:10px;min-width:28px">\${r.pct}%</span></div>
      </td>
    </tr>\`).join('');
  document.getElementById('tblFoot').textContent = rows.length + ' / ' + ALL_ROWS.length + ' chambords';
}

// ── Three.js Viewer ───────────────────────────────────────────────────────────
let threeScene, threeCamera, threeRenderer, threeControls;
let threeModel = null;
let coloringOn = false;
const originalMats = new Map();

const C_GREEN  = new THREE.Color(0x22b07d);
const C_RED    = new THREE.Color(0xD93025);
const C_GREY   = new THREE.Color(0xaaaaaa);
const C_ORANGE = new THREE.Color(0xE87722);

function setProgress(pct, text) {
  const f = document.getElementById('vloadFill');
  const p = document.getElementById('vloadPct');
  const t = document.getElementById('vloadText');
  if (f) f.style.width = pct + '%';
  if (p) p.textContent = pct + '%';
  if (t && text) t.textContent = text;
}

function hideOverlay() {
  const ov = document.getElementById('viewerOverlay');
  if (!ov) return;
  ov.style.transition = 'opacity 0.5s';
  ov.style.opacity = '0';
  setTimeout(() => ov.style.display = 'none', 500);
}

function showNoModel() {
  document.getElementById('viewerOverlay').style.display = 'none';
  document.getElementById('viewerNoModel').style.display = 'flex';
}

async function initThreeViewer() {
  const wrap   = document.getElementById('viewerWrap');
  const canvas = document.getElementById('threeCanvas');
  const W = wrap.clientWidth  || 700;
  const H = wrap.clientHeight || 450;

  threeRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  threeRenderer.setSize(W, H);
  threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  threeRenderer.shadowMap.enabled = true;
  threeRenderer.outputEncoding = THREE.sRGBEncoding;
  threeRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  threeRenderer.toneMappingExposure = 1.2;

  threeScene = new THREE.Scene();
  threeScene.background = new THREE.Color(0x1e2330);
  threeScene.fog = new THREE.FogExp2(0x1e2330, 0.0012);

  threeCamera = new THREE.PerspectiveCamera(45, W / H, 0.1, 5000);
  threeCamera.position.set(200, -200, 150);

  threeScene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dl = new THREE.DirectionalLight(0xffffff, 1.2);
  dl.position.set(100, -100, 200); dl.castShadow = true;
  threeScene.add(dl);
  const fl = new THREE.DirectionalLight(0x88aaff, 0.4);
  fl.position.set(-100, 100, 50);
  threeScene.add(fl);

  threeControls = new THREE.OrbitControls(threeCamera, canvas);
  threeControls.enableDamping = true;
  threeControls.dampingFactor = 0.08;
  threeControls.minDistance = 5;
  threeControls.maxDistance = 3000;

  threeScene.add(new THREE.GridHelper(600, 60, 0x333344, 0x2a2a3a));

  (function animate() {
    requestAnimationFrame(animate);
    threeControls.update();
    threeRenderer.render(threeScene, threeCamera);
  })();

  window.addEventListener('resize', () => {
    const W2 = wrap.clientWidth, H2 = wrap.clientHeight;
    threeCamera.aspect = W2 / H2;
    threeCamera.updateProjectionMatrix();
    threeRenderer.setSize(W2, H2);
  });

  // Vérifier si model.obj est disponible
  setProgress(10, 'Vérification du modèle…');
  try {
    const check = await fetch('/assets/model.obj', { method: 'HEAD' });
    if (!check.ok) { showNoModel(); return; }
  } catch(e) { showNoModel(); return; }

  setProgress(20, 'Téléchargement de la maquette…');

  const loader = new THREE.OBJLoader();
  loader.load(
    '/assets/model.obj',
    (obj) => {
      setProgress(90, 'Application des couleurs statut…');
      threeModel = obj;

      const box    = new THREE.Box3().setFromObject(threeModel);
      const center = box.getCenter(new THREE.Vector3());
      const size   = box.getSize(new THREE.Vector3());
      threeModel.position.sub(center);

      const maxDim = Math.max(size.x, size.y, size.z);
      threeCamera.position.set(maxDim, -maxDim, maxDim * 0.8);
      threeControls.target.set(0, 0, 0);
      threeControls.update();

      threeScene.add(threeModel);

      // Sauvegarder les matériaux originaux
      threeModel.traverse(obj => {
        if (!obj.isMesh) return;
        originalMats.set(obj.uuid, Array.isArray(obj.material)
          ? obj.material.map(m => m.clone())
          : obj.material.clone());
      });

      applyStatusColors();
      setProgress(100, 'Maquette chargée ✓');
      hideOverlay();
    },
    (xhr) => {
      if (xhr.total > 0) setProgress(Math.round(20 + xhr.loaded / xhr.total * 65), 'Chargement… ' + Math.round(xhr.loaded / 1024 / 1024) + ' Mo');
    },
    () => showNoModel()
  );
}

function getColorForObject(obj) {
  const name = (obj.name || '').toUpperCase().replace(/\\s+/g, '');
  for (const [chambord, status] of Object.entries(CHAMBORD_STATUS)) {
    const key = chambord.toUpperCase().replace(/\\s+/g, '');
    if (name.includes(key)) return status === 'realise' ? C_GREEN : C_RED;
  }
  return C_GREY;
}

function applyStatusColors() {
  if (!threeModel) return;
  coloringOn = true;
  document.getElementById('btnColor')?.classList.add('active');
  threeModel.traverse(obj => {
    if (!obj.isMesh) return;
    obj.material = new THREE.MeshStandardMaterial({ color: getColorForObject(obj), roughness: 0.6, metalness: 0.1 });
  });
}

function restoreOriginalColors() {
  if (!threeModel) return;
  coloringOn = false;
  document.getElementById('btnColor')?.classList.remove('active');
  threeModel.traverse(obj => {
    if (!obj.isMesh) return;
    const orig = originalMats.get(obj.uuid);
    if (orig) obj.material = orig;
  });
}

window.toggleColoring = () => coloringOn ? restoreOriginalColors() : applyStatusColors();

window.highlightChambord = function(name) {
  if (!threeModel) return;
  document.querySelectorAll('#chambordBody tr').forEach(r => r.classList.remove('sel'));
  event?.currentTarget?.classList.add('sel');

  const key = name.toUpperCase().replace(/\\s+/g, '');
  const targets = [];

  threeModel.traverse(obj => {
    if (!obj.isMesh) return;
    const n = (obj.name || '').toUpperCase().replace(/\\s+/g, '');
    if (n.includes(key)) {
      obj.material = new THREE.MeshStandardMaterial({ color: C_ORANGE, roughness: 0.4, metalness: 0.2, emissive: C_ORANGE, emissiveIntensity: 0.15 });
      targets.push(obj);
    } else {
      obj.material = new THREE.MeshStandardMaterial({ color: 0x444455, roughness: 0.8, transparent: true, opacity: 0.15 });
    }
  });

  if (targets.length > 0) {
    const box    = new THREE.Box3();
    targets.forEach(o => box.expandByObject(o));
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const dist   = Math.max(size.x, size.y, size.z) * 2.2;
    threeCamera.position.set(center.x + dist, center.y - dist, center.z + dist * 0.6);
    threeControls.target.copy(center);
    threeControls.update();
  }
};

window.showAll = function() {
  document.querySelectorAll('#chambordBody tr').forEach(r => r.classList.remove('sel'));
  if (coloringOn) applyStatusColors();
  else restoreOriginalColors();
  resetCamera();
};

window.resetCamera = function() {
  if (!threeModel) return;
  const box    = new THREE.Box3().setFromObject(threeModel);
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  threeCamera.position.set(center.x + maxDim, center.y - maxDim, center.z + maxDim * 0.8);
  threeControls.target.copy(center);
  threeControls.update();
};

initThreeViewer();
<\/script>
</body>
</html>`;
}

// ── Fichiers statiques ────────────────────────────────────────────────────────

app.use('/assets', express.static(path.join(__dirname, '../assets')));
app.use(express.static(path.join(__dirname, '../public')));
app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  🏗️  BIM Dashboard APS → http://localhost:${PORT}\n`);
});