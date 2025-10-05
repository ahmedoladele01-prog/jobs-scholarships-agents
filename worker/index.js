import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import puppeteer from 'puppeteer';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

// Data dirs (inside container). On Render these are ephemeral unless you attach a disk.
const DATA_DIR = '/data';
const PROFILE_DIR = path.join(DATA_DIR, 'profile');
const CV_DIR = path.join(DATA_DIR, 'cv');
const PROOF_DIR = path.join(DATA_DIR, 'proofs');
const LOG_DIR = path.join(DATA_DIR, 'logs');
[PROFILE_DIR, CV_DIR, PROOF_DIR, LOG_DIR].forEach(p => fs.mkdirSync(p, { recursive: true }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'worker' }));

// --- Demo form so you can safely test end-to-end ---
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(path.join(PUBLIC_DIR, 'demo-form.html'))) {
  fs.writeFileSync(path.join(PUBLIC_DIR, 'demo-form.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>Demo Application Form</title>
<style>body{font-family:Arial;margin:2rem}label{display:block;margin:.5rem 0}.box{border:1px solid #ccc;padding:1rem;border-radius:8px}</style>
</head><body>
  <h1>Demo Application Form</h1>
  <form class="box" method="post" action="/public/ok.html" enctype="multipart/form-data">
    <label>Full Name <input type="text" name="name" aria-label="Full Name"></label>
    <label>Email <input type="email" name="email" aria-label="Email"></label>
    <label>Phone <input type="tel" name="phone" aria-label="Phone"></label>
    <label>CV <input type="file" name="cv"></label>
    <button type="submit">Submit</button>
  </form>
  <p>This page exists so you can safely test the agent end-to-end before trying a real site.</p>
</body></html>`);
}
if (!fs.existsSync(path.join(PUBLIC_DIR, 'ok.html'))) {
  fs.writeFileSync(path.join(PUBLIC_DIR, 'ok.html'), "<h1>Submitted ✔</h1>");
}
app.get('/demo-form', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'demo-form.html')));

// --- Profile loader with safe fallback ---
function loadProfile(profileId){
  try {
    const p = path.join(PROFILE_DIR, `${profileId}.json`);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  // Fallback default if no profile file mounted
  return {
    fullName: 'Ahmed Oladele, MBA',
    email: 'ahmed.oladele01@gmail.com',
    phone: '+2349035754422',
    location: 'Lagos, Nigeria',
    headline: 'Regional Sales & Operations | Digital Payments',
    experience: [
      {
        title: 'Regional Sales & Operations Manager',
        company: 'Sterling Bank',
        start: '2019',
        end: '2024',
        bullets: [
          'Spearheaded NQR merchant acquisition, increasing transaction volume by 40% and ₦500M+ monthly value.',
          'Ranked Sterling #1 nationwide in NQR sales by Q4 2024.'
        ]
      }
    ]
  };
}

// --- Render CV → PDF using Handlebars template file ---
async function renderCvToPdf(profile, targetRole='General Role'){
  const tplPath = path.join(__dirname, 'templates', 'cv', 'modern.hbs');
  const tplStr = fs.readFileSync(tplPath, 'utf8');
  const html = Handlebars.compile(tplStr)({ resume: profile, targetRole });

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const fname = `Ahmed_Oladele_${targetRole.replace(/\s+/g, '_')}_${Date.now()}.pdf`;
  const fpath = path.join(CV_DIR, fname);

  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }
  });
  fs.writeFileSync(fpath, pdf);
  await browser.close();
  return fpath;
}

// --- Generic form-fill + file upload with Playwright ---
async function fillForm(url, profile, pdfPath){
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const tryFill = async (locator, value) => {
    try { if (await locator.count()) await locator.first().fill(value); } catch {}
  };
  await tryFill(page.getByLabel(/full name|name/i), profile.fullName);
  await tryFill(page.getByLabel(/email/i), profile.email);
  await tryFill(page.getByLabel(/phone|mobile/i), profile.phone);

  // Upload CV file
  const input = page.locator('input[type=file]');
  if (await input.count()) {
    await input.setInputFiles(pdfPath);
  } else {
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 3000 }),
        page.getByText(/upload|choose file|browse/i).first().click()
      ]);
      await chooser.setFiles(pdfPath);
    } catch {}
  }

  // Try submit
  const submit = page.getByRole('button', { name: /submit|apply|send/i });
  if (await submit.count()) await submit.first().click();

  // Screenshot proof
  await page.waitForTimeout(1500);
  const proofPath = path.join(PROOF_DIR, `proof_${Date.now()}.png`);
  await page.screenshot({ path: proofPath, fullPage: true });
  const content = await page.content();
  await browser.close();
  return { proofPath, snippet: content.slice(0, 1000) };
}

// --- Public API used by the FastAPI backend ---
app.post('/apply', express.json(), async (req, res) => {
  try {
    const { url, profile_id='ahmed', target_role='General Role' } = req.body || {};
    const profile = loadProfile(profile_id);
    const pdfPath = await renderCvToPdf(profile, target_role);
    const result = await fillForm(url, profile, pdfPath);
    res.json({ ok: true, pdfPath, proof: result.proofPath, htmlSnippet: result.snippet });
  } catch (e) {
    console.error(e);
    fs.writeFileSync(path.join(LOG_DIR, 'error.log'), String(e)+"\n", { flag: 'a' });
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT_WORKER || process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker listening on ${PORT}`));
