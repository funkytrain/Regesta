/**
 * Regesta - interface.
 *
 * No framework, on purpose: the application has four screens and a viewer.
 * Adding React would cost more to maintain in the long run than plain DOM.
 */

import { binarizeImage } from './threshold.js';
import {
  markInNodes,
  clearMarks,
  markOnPage,
  pagesWithTerm,
} from './find-in-document.js';
import {
  renderFolders,
  renderRecordTypes,
  renderTags,
  toggleBranch,
} from './browser.js';

const main = document.getElementById('main');
const viewer = document.getElementById('viewer');
const visorImg = document.getElementById('viewer-img');
const visorTitulo = document.getElementById('viewer-title');
const visorFicha = document.getElementById('viewer-record');
const visorZoom = document.getElementById('viewer-zoom');

/** How many documents are requested per page. 0 means all of them. */
const PER_PAGE_OPTIONS = [30, 60, 120, 240, 0];

function readPreference(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : Number(v);
  } catch {
    // In a private window storage can fail; that is no reason for the
    // application to stop working.
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* with no storage, the preference only lasts this session */
  }
}

const state = {
  section: 'home',
  query: '',
  page: 1,
  perPage: readPreference('regesta.perPage', 60),
  results: [],
  indiceAbierto: -1,
  zoom: 1,
  // Offset of the image within the canvas, in screen pixels.
  desplazado: { x: 0, y: 0 },
};

/**
 * Reading adjustments. They are applied over the image on screen through
 * browser filters: the file on the NAS is not modified or reprocessed on the
 * server.
 *
 * They reset each time a document is opened, so an extreme contrast is not
 * carried unnoticed from one folio to the next.
 */
const DEFAULT_ADJUSTMENTS = {
  contrast: 100,
  brightness: 100,
  saturation: 100,
  sepia: 0,
  sharpen: 0,
  threshold: 0,
  negative: false,
  greyscale: false,
  rotation: 0,
  mirror: false,
};
let adjustments = { ...DEFAULT_ADJUSTMENTS };

const RECORD_TYPES = {
  birth: 'Birth',
  baptism: 'Baptism',
  marriage: 'Marriage',
  burial: 'Burial',
  marriage_licence: 'Marriage licence',
  confirmation: 'Confirmation',
  nuptial_blessing: 'Nuptial blessing',
  index: 'Index',
  record: 'Record',
  unknown: 'Unclassified',
};

const WARNINGS = {
  no_year: 'no year',
  year_out_of_range: 'impossible year',
  unrecognised_type: 'record type not recognised',
  no_name: 'no name',
  typo_in_type: 'typo in the record type',
  flagged_by_user: 'flagged by you',
};

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  return r.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function formatNumber(n) {
  return new Intl.NumberFormat().format(n ?? 0);
}

/**
 * A year read from the file name is only presented as a date if it can be
 * one. Archives hold page numbers and bundle reference codes that the reader
 * picks up as years; showing those under "Year" would pass them off as good
 * data.
 */
function isDoubtfulYear(year) {
  return year !== null && year !== undefined && (year < 1400 || year > new Date().getFullYear());
}

function readableYear(year) {
  if (year === null || year === undefined) return '—';
  if (isDoubtfulYear(year)) {
    return `<span class="doubtful-value">${year}</span> <span class="tag">not a date</span>`;
  }
  return String(year);
}

function fileSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'kB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/* ---------- Pantallas ---------- */

async function showHome() {
  main.innerHTML = '<p class="loading">Loading…</p>';
  const r = await fetchJson('/api/summary');

  const tipos = r.byType
    .filter((t) => t.type && t.type !== 'unknown')
    .map(
      (t) =>
        `<button class="figure" data-search-type="${esc(t.type)}">
           <div class="n">${formatNumber(t.n)}</div>
           <div class="et">${esc(RECORD_TYPES[t.type] ?? t.type)}</div>
         </button>`,
    )
    .join('');

  const formatNames = {
    image: 'Images',
    pdf: 'PDF',
    text: 'Texto',
    documento: 'Word',
    otro: 'Otros',
  };
  const formatos = (r.byFormat ?? [])
    .filter((f) => f.format !== 'other' || f.n > 0)
    .map(
      (f) =>
        `<button class="figure" data-search-format="${esc(f.format)}">
           <div class="n">${formatNumber(f.n)}</div>
           <div class="et">${esc(formatNames[f.format] ?? f.format)}</div>
         </button>`,
    )
    .join('');

  main.innerHTML = `
    <h1>Your archive</h1>
    <div id="folder-panel"></div>
    <div id="watching"></div>
    <div id="gramps-state"></div>
    <div class="figures">
      <div class="figure">
        <div class="n">${formatNumber(r.documents)}</div>
        <div class="et">Documents</div>
      </div>
      <div class="figure">
        <div class="n">${r.range?.first_year ?? '—'}–${r.range?.last_year ?? '—'}</div>
        <div class="et">Years covered</div>
      </div>
      <button class="figure ${r.toReview ? 'warns' : ''}" data-go="review">
        <div class="n">${formatNumber(r.toReview)}</div>
        <div class="et">Records to review</div>
      </button>
      <button class="figure ${r.duplicates ? 'warns' : ''}" data-go="duplicates">
        <div class="n">${formatNumber(r.duplicates)}</div>
        <div class="et">Duplicate groups</div>
      </button>
    </div>

    <h2>By record type</h2>
    <div class="figures">${tipos}</div>

    <h2>By format</h2>
    <div class="figures">${formatos}</div>

    <div id="export-panel"></div>

    <h2>Latest documents</h2>
    <div class="grid" id="latest"></div>
  `;

  void renderWatching();

  // Well-read records are shown, not the earliest by year: the lowest years
  // in the archive are precisely the mistaken ones, and opening with them
  // would give a false impression of what is inside.
  void renderGrampsStatus();
  void renderFolder();
  void renderExport();

  const latest = await fetchJson('/api/search?perPage=24&orden=mejores');
  state.results = latest.results;
  document.getElementById('latest').innerHTML = latest.results.map(card).join('');
  watchPdfThumbnails();
}

/**
 * State of folder watching. It matters that this is visible: without knowing
 * whether it is active, the user cannot trust that what they copy in will
 * actually show up.
 */
async function renderWatching() {
  const slot = document.getElementById('watching');
  if (!slot) return;

  let v;
  try {
    v = await fetchJson('/api/watch');
  } catch {
    return;
  }
  if (!slot.isConnected) return;

  if (!v.available) {
    slot.innerHTML = `
      <p class="watching apagada">
        Folder watching is not active: new documents will
        be indexed by running <code>npm run index</code>.
      </p>`;
    return;
  }

  const desde = (iso) => {
    if (!iso) return null;
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  };

  const detail = v.sweeping
    ? 'sweeping the folders…'
    : v.pending > 0
      ? `${v.pending} new file${v.pending === 1 ? '' : 's'} queued`
      : v.lastChange
        ? `last change ${since(v.lastChange)}`
        : 'no changes since start-up';

  slot.innerHTML = `
    <p class="watching ${v.sweeping ? 'working' : ''}">
      <span class="dot"></span>
      Watching the folder - ${esc(detail)}
      <button id="btn-sweep" ${v.sweeping ? 'disabled' : ''}>Check for new documents</button>
    </p>`;
}

/* ---------- Side browser ---------- */

const brBody = document.getElementById('br-body');
let arbolActivo = readTextPreference('regesta.tree', 'folders');

function readTextPreference(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Which branch of the browser is selected, so it can be highlighted. */
function currentSelection() {
  if (state.unit) return { type: 'unit', id: Number(state.unit) };
  if (state.tag) return { type: 'tag', id: Number(state.tag) };
  if (state.type) return { type: 'record', id: state.type, century: state.century ?? null };
  return null;
}

async function renderBrowser() {
  for (const b of document.querySelectorAll('.br-tabs button')) {
    b.classList.toggle('active', b.dataset.tree === arbolActivo);
  }

  try {
    const sel = currentSelection();
    if (arbolActivo === 'folders') {
      brBody.innerHTML = renderFolders(await fetchJson('/api/tree/folders'), sel);
    } else if (arbolActivo === 'record-types') {
      brBody.innerHTML = renderRecordTypes(await fetchJson('/api/tree/record-types'), sel);
    } else {
      brBody.innerHTML = renderTags(await fetchJson('/api/tags'), sel);
    }
  } catch {
    brBody.innerHTML = '<p class="br-empty">The browser could not be loaded.</p>';
  }
}

/** Clears the filters before applying a new one from the browser. */
function clearFilters() {
  state.query = '';
  state.type = null;
  state.unit = null;
  state.unitTitle = '';
  state.tag = null;
  state.century = null;
  state.review = null;
  state.page = 1;
  document.getElementById('q').value = '';
}

/**
 * The indexed folder, and how to change it.
 *
 * The container only sees what has been mounted into it, so the available
 * folders are offered instead of asking the user to guess a path.
 */
async function renderFolder() {
  const slot = document.getElementById('folder-panel');
  if (!slot) return;

  let c;
  try {
    c = await fetchJson('/api/folder');
  } catch {
    return;
  }
  if (!slot.isConnected) return;

  const options = (c.candidates ?? [])
    .map(
      (x) =>
        `<option value="${esc(x.path)}"${x.path === c.root ? ' selected' : ''}>${esc(x.path)}</option>`,
    )
    .join('');

  slot.innerHTML = `
    <div class="gramps-panel">
      <p class="gramps-title">
        Indexed folder
        <button id="folder-change" class="gramps-mini">Change</button>
      </p>
      <p class="gramps-cifras"><code>${esc(c.root ?? 'not configured')}</code></p>
      <p class="gramps-pista">${formatNumber(c.documents)} documents indexed</p>

      <form class="gramps-form" id="form-folder" hidden>
        <select id="folder-path">
          ${options || '<option value="">(the container cannot see any folder)</option>'}
        </select>
        <button type="submit">Use this folder</button>
      </form>
      <p class="gramps-pista" id="folder-help" hidden>
        Only folders mounted into the container appear here. To add
        another, mount it in <code>docker-compose.yml</code> and restart the
        container. When you switch, what was indexed from the previous folder is
        marked as missing but <strong>is not deleted</strong>: its description
        stays there if you go back to it.
      </p>
      <p class="gramps-error" id="folder-error"></p>
    </div>`;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#folder-change')) return;
  const form = document.getElementById('form-folder');
  const ayuda = document.getElementById('folder-help');
  if (!form) return;
  form.hidden = !form.hidden;
  if (ayuda) ayuda.hidden = form.hidden;
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'form-folder') return;
  e.preventDefault();

  const sel = document.getElementById('folder-path');
  const error = document.getElementById('folder-error');
  const path = sel.value;
  if (!path) return;

  if (
    !confirm(
      `Index "${path}"?\n\n` +
        'What was indexed from the previous folder will be flagged missing, but its ' +
        'description is not deleted: if you switch back, it is still there.',
    )
  )
    return;

  error.textContent = 'Changing folder and sweeping it…';
  try {
    const r = await fetch('/api/folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await r.json();
    if (!r.ok) {
      error.textContent = data.error ?? 'Could not change it';
      return;
    }
    // A sweep over thousands of files takes minutes: it is awaited and only
    // then refreshed, rather than showing a half-finished count.
    error.textContent = 'Folder changed. Indexing its contents…';

    const esperar = setInterval(async () => {
      try {
        const v = await fetchJson('/api/watch');
        if (v.sweeping) return;
        clearInterval(esperar);
        if (state.section === 'home') void goTo('home');
      } catch {
        clearInterval(esperar);
      }
    }, 3000);
  } catch {
    error.textContent = 'Could not change it';
  }
});

/**
 * Open export.
 *
 * Its reason for existing: if in ten years this application no longer starts,
 * the description made by hand must still be readable. The documents are
 * still on disk; what is irreplaceable is the cataloguing work.
 */
async function renderExport() {
  const slot = document.getElementById('export-panel');
  if (!slot) return;

  let r;
  try {
    r = await fetchJson('/api/export/summary');
  } catch {
    return;
  }
  if (!slot.isConnected) return;

  const when = r.last
    ? `Last export: ${new Date(r.last).toLocaleString()}`
    : 'You have not exported anything yet';

  slot.innerHTML = `
    <div class="gramps-panel">
      <p class="gramps-title">
        Readable copy of your cataloguing
        <button id="export-now" class="gramps-mini">Export now</button>
      </p>
      <p class="gramps-nota">
        Dumps what you have described to CSV and plain text, in the data folder
        beside the database. Readable with any spreadsheet or editor, without
        Regesta. The original documents are not copied: they stay where they are.
      </p>
      <p class="gramps-cifras">
        ${formatNumber(r.described)} described / ${formatNumber(r.entries)} entries /
        ${formatNumber(r.tags)} tags / ${formatNumber(r.provenances)} provenances
      </p>
      <p class="gramps-pista">${esc(when)}</p>
      <p class="gramps-pista">
        Or download a single table:
        ${[
          ['documents', 'Documents'],
          ['entries', 'Entries'],
          ['tags', 'Tags'],
          ['provenances', 'Provenances'],
          ['classification', 'Scheme'],
        ]
          .map(([c, t]) => `<a href="/api/export/csv/${c}" download>${t}</a>`)
          .join(' · ')}
      </p>
      <p class="gramps-error" id="export-state"></p>
    </div>`;
}

document.addEventListener('click', async (e) => {
  if (!e.target.closest('#export-now')) return;

  const button = e.target.closest('#export-now');
  const notice = document.getElementById('export-state');
  button.disabled = true;
  button.textContent = 'Exporting…';
  if (notice) notice.textContent = '';

  try {
    const r = await fetch('/api/export', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'failed');

    if (notice) {
      notice.className = 'gramps-pista';
      notice.textContent = `Done: ${d.files} tables and ${formatNumber(d.texts)} text files in ${d.target}`;
    }
    setTimeout(() => void renderExport(), 2500);
  } catch (err) {
    if (notice) {
      notice.className = 'gramps-error';
      notice.textContent = String(err.message ?? err);
    }
    button.disabled = false;
    button.textContent = 'Export now';
  }
});

/** State of the Gramps tree on the home screen. */
async function renderGrampsStatus() {
  const slot = document.getElementById('gramps-state');
  if (!slot) return;

  let g;
  try {
    g = await fetchJson('/api/gramps/status');
  } catch {
    return;
  }
  if (!slot.isConnected) return;

  if (!g.configured) {
    slot.innerHTML = `
      <div class="gramps-panel">
        <p class="gramps-title">Gramps tree</p>
        <p class="gramps-nota">
          Connect it to see, beside each document, what Gramps knows: its
          identifiers, the events, who takes part and the citations already
          recorded. <strong>Read-only</strong>, and over a copy: it never
          writes to your tree.
        </p>
        <form class="gramps-form" id="form-gramps">
          <input id="gramps-path" placeholder="Path to the Gramps sqlite.db"
                 value="${esc(g.rutaSugerida ?? '')}" autocomplete="off">
          <button type="submit">Connect</button>
        </form>
        <p class="gramps-pista">
          It is usually at <code>%APPDATA%\\gramps\\grampsdb\\&lt;tree&gt;\\sqlite.db</code>
        </p>
        <p class="gramps-error" id="gramps-error"></p>
      </div>`;
    return;
  }

  const r = g.summary ?? {};
  slot.innerHTML = `
    <div class="gramps-panel">
      <p class="gramps-title">
        Gramps tree
        <button id="gramps-refresh" class="gramps-mini">Refresh the copy</button>
      </p>
      ${
        g.available
          ? `<p class="gramps-cifras">
               ${formatNumber(r.people)} people - ${formatNumber(r.families)} families -
               ${formatNumber(r.events)} events - ${formatNumber(r.citations)} citations
             </p>`
          : '<p class="gramps-error">The copy cannot be read. Connect it again.</p>'
      }
      <p class="gramps-pista">
        Copy made ${g.copied_at ? new Date(g.copied_at).toLocaleString() : '—'} ·
        read-only
      </p>
      <p class="gramps-error" id="gramps-error"></p>
    </div>`;
}

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'form-gramps') return;
  e.preventDefault();

  const field = document.getElementById('gramps-path');
  const error = document.getElementById('gramps-error');
  const path = field.value.trim();
  if (!path) return;

  error.textContent = 'Copying and checking…';
  try {
    const r = await fetch('/api/gramps/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await r.json();
    if (!r.ok) {
      error.textContent = data.error ?? 'Could not connect';
      return;
    }
    await renderGrampsStatus();
  } catch {
    error.textContent = 'Could not connect';
  }
});

document.addEventListener('click', async (e) => {
  if (!e.target.closest('#gramps-refresh')) return;
  const button = e.target.closest('#gramps-refresh');
  button.disabled = true;
  button.textContent = 'Copying…';
  try {
    await fetch('/api/gramps/refresh', { method: 'POST' });
  } catch {
    /* it is retried */
  }
  await renderGrampsStatus();
});

async function showSearch() {
  main.innerHTML = '<p class="loading">Searching…</p>';

  // 0 in the selector means 'all': a high cap is requested instead.
  const pedidos = state.perPage === 0 ? 50000 : state.perPage;
  const p = new URLSearchParams({ page: String(state.page), perPage: String(pedidos) });
  if (state.query) p.set('q', state.query);
  if (state.type) p.set('type', state.type);
  if (state.unit) p.set('unit', state.unit);
  if (state.format) p.set('format', state.format);
  if (state.tag) p.set('tag', state.tag);
  if (state.century) p.set('century', state.century);
  if (state.review) p.set('review', '1');

  const r = await fetchJson(`/api/search?${p}`);
  state.results = r.results;

  const pages = Math.max(1, Math.ceil(r.total / r.perPage));
  const desc = state.query
    ? `<strong>${formatNumber(r.total)}</strong> documents for "${esc(state.query)}"`
    : state.type
      ? `<strong>${formatNumber(r.total)}</strong> documents of type ${esc(RECORD_TYPES[state.type] ?? state.type)}`
      : state.unitTitle
        ? `<strong>${formatNumber(r.total)}</strong> documents in ${esc(state.unitTitle)}`
        : state.format
          ? `<strong>${formatNumber(r.total)}</strong> ${esc(
              (FORMATS.find(([v]) => v === state.format) ?? ['', ''])[1].toLowerCase(),
            )}`
          : `<strong>${formatNumber(r.total)}</strong> documents`;

  main.innerHTML = `
    <div class="results-bar">
      <p class="search-summary">${desc}</p>
      <div class="list-controls">
        ${formatFilter()}
        ${perPageSelector()}
      </div>
    </div>
    <div class="grid">${r.results.map(card).join('') || '<p>Nothing found.</p>'}</div>
    ${pagination(r.page, pages)}
  `;
  watchPdfThumbnails();
}

const FORMATS = [
  ['', 'All formats'],
  ['image', 'Images'],
  ['pdf', 'PDF'],
  ['text', 'Text'],
  ['document', 'Word'],
];

/** File-format filter, separate from the record-type filter. */
function formatFilter() {
  const options = FORMATS.map(
    ([v, tag]) =>
      `<option value="${v}"${v === (state.format ?? '') ? ' selected' : ''}>${tag}</option>`,
  ).join('');

  return `
    <label class="per-page">
      <select id="sel-formato" aria-label="File format">${options}</select>
    </label>`;
}

/** Dropdown with the number of documents per page. */
function perPageSelector() {
  const options = PER_PAGE_OPTIONS.map(
    (n) =>
      `<option value="${n}"${n === state.perPage ? ' selected' : ''}>${
        n === 0 ? 'all' : n
      }</option>`,
  ).join('');

  return `
    <label class="per-page">
      <span>Show</span>
      <select id="sel-per-page" aria-label="Documents per page">${options}</select>
      <span>per page</span>
    </label>`;
}

function pagination(current, pages) {
  if (pages <= 1) return '';
  return `
    <div class="pagination">
      <button ${current <= 1 ? 'disabled' : ''} data-page="${current - 1}">Previous</button>
      <span>Page ${current} of ${formatNumber(pages)}</span>
      <button ${current >= pages ? 'disabled' : ''} data-page="${current + 1}">Next</button>
    </div>`;
}

function card(d, i) {
  // Documents with no thumbnail (PDF, text, Word) show their format instead
  // of an empty slot, so they can be told apart at a glance.
  const img = d.thumbnail
    ? `<img src="/thumb/${esc(d.thumbnail)}" alt="" loading="lazy">`
    : `<div class="no-img no-img-${esc(familyOf(d))}"${
        familyOf(d) === 'pdf' ? ` data-mini-pdf="${d.id}"` : ''
      }>
         <span class="no-img-ext">${esc((d.extension ?? '').replace('.', '').toUpperCase() || '?')}</span>
       </div>`;

  const avisos = JSON.parse(d.warnings ?? '[]');
  const brand = avisos.length ? `<span class="tag">${esc(WARNINGS[avisos[0]] ?? avisos[0])}</span>` : '';

  const person = d.person ?? d.name;
  const withSpouse = d.person_2 ? `${esc(person)} <span style="opacity:.6">and</span> ${esc(d.person_2)}` : esc(person);

  return `
    <button class="doc" data-doc="${d.id}" data-i="${i}"${d.described ? ' data-described="1"' : ''}>
      <div class="doc-img">${img}</div>
      <div class="doc-foot">
        <div class="doc-person">${withSpouse}</div>
        <div class="doc-meta">
          <span class="doc-type">${esc(RECORD_TYPES[d.record_type] ?? '')}</span>
          <span class="doc-year${isDoubtfulYear(d.year) ? ' doubtful-value' : ''}">${d.year ?? ''}</span>
          ${d.page ? `<span>p. ${d.page}</span>` : ''}
          ${brand}
        </div>
        ${
          d.tags?.length
            ? `<div class="doc-tags">${d.tags
                .map((t) => `<span class="tag-chip">${esc(t.name)}</span>`)
                .join('')}</div>`
            : ''
        }
      </div>
      ${preview(d)}
    </button>`;
}

/**
 * Preview that appears on hover.
 *
 * It only shows what does NOT fit on the card: the full untruncated name, the
 * second spouse, which series the document comes from and whether there are
 * copies in other folders. Repeating what is already legible under the
 * thumbnail would get in the way without adding anything.
 */
function preview(d) {
  const lines = [];

  const nombreLargo = (d.person ?? '').length > 34 || d.person_2;
  if (nombreLargo) {
    lines.push(`<strong>${esc(d.person ?? d.name)}</strong>`);
    if (d.person_2) lines.push(`<span class="pv-spouse">and ${esc(d.person_2)}</span>`);
  }

  const recordType = [
    RECORD_TYPES[d.record_type] ?? null,
    d.year ?? null,
    d.page ? `page ${d.page}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (recordType) lines.push(`<span class="pv-record">${esc(recordType)}</span>`);

  if (d.unit_title) lines.push(`<span class="pv-series">${esc(d.unit_title)}</span>`);

  const tecnico = [
    d.width ? `${d.width}×${d.height}` : null,
    d.bytes ? fileSize(d.bytes) : null,
    (d.extension ?? '').replace('.', '') || null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (tecnico) lines.push(`<span class="pv-technical">${esc(tecnico)}</span>`);

  if (d.copies > 0) {
    lines.push(
      `<span class="pv-warning">${d.copies} identical cop${d.copies === 1 ? 'y' : 'ies'} in another folder</span>`,
    );
  }

  const avisos = JSON.parse(d.warnings ?? '[]');
  for (const a of avisos) {
    lines.push(`<span class="pv-warning">${esc(WARNINGS[a] ?? a)}</span>`);
  }

  // If the document turned up in the search by its content, the passage
  // where the term appears is shown: without it, the result does not explain
  // why it is there.
  if (d.snippet) {
    lines.push(`<span class="pv-taste pv-match">${highlight(d.snippet)}</span>`);
  } else {
    // For formats with no thumbnail, a taste of the content says more than
    // any metadata. It is fetched on hover, not when painting the list.
    const family = familyOf(d);
    if (family === 'text' || family === 'word') {
      lines.push(`<span class="pv-taste" data-preview="${d.id}">Loading the content…</span>`);
    }
  }

  // The file name goes last: it is the reference for finding it over SMB,
  // but not what matters first.
  lines.push(`<span class="pv-file">${esc(d.name)}</span>`);

  return `<span class="preview" role="tooltip">${lines.join('')}</span>`;
}

/**
 * Marks in bold the part of the snippet matching the search term.
 *
 * The server delimits the match with square brackets. The text is escaped
 * first and substituted afterwards, so the document content is never
 * interpreted as markup.
 */
function highlight(snippet) {
  return esc(snippet)
    .replaceAll('[', '<mark>')
    .replaceAll(']', '</mark>');
}

/** Tastes already fetched, so the request is not repeated on every pass. */
const adelantos = new Map();

/** PDFs whose thumbnail has already been attempted this session. */
const miniaturasPdf = new Set();

/**
 * Renders the first page of a PDF and stores it as a thumbnail.
 *
 * This happens here and not on the server because rendering a PDF there would
 * require a native module with system dependencies, complicating the
 * container. The viewer already ships PDF.js, so it is put to use: the first
 * time a PDF appears in the grid its thumbnail is generated and sent to the
 * server, which keeps it for every time after that.
 */
async function makePdfThumbnail(id, slot) {
  if (miniaturasPdf.has(id)) return;
  miniaturasPdf.add(id);

  try {
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ url: `/file/${id}` }).promise;
    const page = await pdf.getPage(1);

    const base = page.getViewport({ scale: 1 });
    const escala = Math.min(400 / base.width, 400 / base.height);
    const vista = page.getViewport({ scale: escala });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vista.width);
    canvas.height = Math.round(vista.height);
    const ctx = canvas.getContext('2d');
    // White background: a PDF with transparency would come out black as webp.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vista }).promise;

    const data = canvas.toDataURL('image/webp', 0.8);
    await pdf.destroy();

    const r = await fetch(`/api/pdf-thumbnail/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: data }),
    });
    if (!r.ok) return;

    const { path } = await r.json();
    if (path && slot?.isConnected) {
      slot.outerHTML = `<img src="/thumb/${path}" alt="" loading="lazy">`;
    }
  } catch {
    // A PDF that cannot be drawn keeps its format placeholder.
  }
}

/**
 * Generates thumbnails for the visible PDFs, one at a time and without
 * hurry: there are hundreds, and doing them all at once would make the
 * browser unusable.
 */
const colaMiniaturas = [];
let colaEnMarcha = false;

function queuePdfThumbnail(id, slot) {
  if (miniaturasPdf.has(id) || colaMiniaturas.some((t) => t.id === id)) return;
  colaMiniaturas.push({ id, slot });
  if (!colaEnMarcha) void processThumbnailQueue();
}

async function processThumbnailQueue() {
  colaEnMarcha = true;
  while (colaMiniaturas.length > 0) {
    const { id, slot } = colaMiniaturas.shift();
    // If the card has scrolled off screen, the work is not worth doing.
    if (slot?.isConnected) await makePdfThumbnail(id, slot);
  }
  colaEnMarcha = false;
}

/**
 * Fetches the first lines of a text or Word document when the pointer rests
 * on its card.
 */
async function loadPreview(slot) {
  const id = slot.dataset.preview;
  if (!id || slot.dataset.requested) return;
  slot.dataset.requested = '1';

  try {
    if (!adelantos.has(id)) {
      adelantos.set(id, fetchJson(`/api/preview/${id}`).then((r) => r.text));
    }
    const text = await adelantos.get(id);
    slot.textContent = text || '(the document is empty)';
  } catch {
    slot.remove();
  }
}

/* ---------- Classification scheme ---------- */

const NIVELES = [
  ['fonds', 'Fonds'],
  ['section', 'Section'],
  ['subsection', 'Subsection'],
  ['series', 'Series'],
  ['subseries', 'Subseries'],
  ['item', 'Item'],
  ['grouping', 'Grouping'],
];

const levelName = (n) => (NIVELES.find(([v]) => v === n) ?? [n, n])[1];

/** What the scheme has open and selected, across repaints. */
const scheme = { nodes: [], expanded: new Set(), chosen: null };

async function showClassification() {
  main.innerHTML = '<p class="loading">Loading…</p>';
  scheme.nodes = await fetchJson('/api/classification');

  // The roots are expanded the first time: a fully collapsed scheme looks
  // empty, and a fully expanded one cannot be read.
  if (scheme.expanded.size === 0) {
    for (const n of scheme.nodes.filter((x) => x.parent_id === null)) scheme.expanded.add(n.id);
  }

  main.innerHTML = `
    <div class="scheme-head">
      <h1>Classification scheme</h1>
      <button id="scheme-new-fonds" class="minor-button">+ New fonds</button>
    </div>
    <p class="search-summary">
      Seeded from your folders, but yours from here on: create the
      fonds and series your archive really has, and hang the documents off them.
    </p>
    <div class="scheme-two">
      <div class="scheme-tree" id="scheme-tree"></div>
      <aside class="scheme-record" id="scheme-record"></aside>
    </div>`;

  renderClassificationTree();
  if (scheme.chosen) void openUnit(scheme.chosen);
}

function renderClassificationTree() {
  const box = document.getElementById('scheme-tree');
  if (!box) return;

  const porPadre = new Map();
  for (const n of scheme.nodes) {
    const k = n.parent_id ?? 0;
    if (!porPadre.has(k)) porPadre.set(k, []);
    porPadre.get(k).push(n);
  }

  const render = (padre) => {
    const hijos = porPadre.get(padre) ?? [];
    if (!hijos.length) return '';

    return `<ul class="tree">${hijos
      .map((n) => {
        const tieneHijos = (porPadre.get(n.id) ?? []).length > 0;
        const open = scheme.expanded.has(n.id);
        return `<li>
          <div class="scheme-row${scheme.chosen === n.id ? ' elegida' : ''}">
            <button class="scheme-caret${tieneHijos ? '' : ' vacio'}"
                    data-collapse-unit="${n.id}"
                    aria-expanded="${open}"
                    ${tieneHijos ? '' : 'tabindex="-1" aria-hidden="true"'}>
              ${tieneHijos ? (open ? '▾' : '▸') : ''}
            </button>
            <button class="node" data-open-unit="${n.id}">
              <span class="nivel">${esc(levelName(n.level))}</span>
              <span>${esc(n.title)}</span>
              ${n.reference_code ? `<span class="scheme-ref">${esc(n.reference_code)}</span>` : ''}
              ${n.documents ? `<span class="count">${formatNumber(n.documents)}</span>` : ''}
            </button>
          </div>
          ${open ? render(n.id) : ''}
        </li>`;
      })
      .join('')}</ul>`;
  };

  box.innerHTML = render(0) || '<p class="loading">The scheme is empty. Create a fonds to begin.</p>';
}

/** ISAD(G) record of a unit, with whatever hangs from it. */
async function openUnit(id) {
  scheme.chosen = id;
  renderClassificationTree();

  const record = document.getElementById('scheme-record');
  if (!record) return;
  record.innerHTML = '<p class="loading">Loading…</p>';

  let u;
  try {
    u = await fetchJson(`/api/unit/${id}`);
  } catch {
    record.innerHTML = '<p>That unit could not be loaded.</p>';
    return;
  }

  const field = (k, tag, extra = '') => `
    <label class="field">
      <span>${esc(tag)}</span>
      <input data-unit-field="${k}" value="${esc(u[k] ?? '')}" ${extra}>
    </label>`;

  const area = (k, tag, lines = 3) => `
    <label class="field">
      <span>${esc(tag)}</span>
      <textarea data-unit-field="${k}" rows="${lines}">${esc(u[k] ?? '')}</textarea>
    </label>`;

  // Moving: any unit except itself and its own descendants, which would
  // leave a branch hanging off itself.
  const descendencia = new Set([id]);
  let crecio = true;
  while (crecio) {
    crecio = false;
    for (const n of scheme.nodes) {
      if (n.parent_id !== null && descendencia.has(n.parent_id) && !descendencia.has(n.id)) {
        descendencia.add(n.id);
        crecio = true;
      }
    }
  }
  const posiblesPadres = scheme.nodes.filter((n) => !descendencia.has(n.id));

  record.innerHTML = `
    <button type="button" class="scheme-close" id="scheme-close" aria-label="Close">✕</button>
    <div class="breadcrumbs">${(u.path_to_root ?? []).map((c) => esc(c.title)).join(' › ')}</div>
    <p class="form-status" id="unit-state"></p>

    <form class="record-form" id="form-unit" data-unit-record="${u.id}">
      ${field('title', 'Title')}

      <label class="field">
        <span>Level of description</span>
        <select data-unit-field="level">
          ${NIVELES.map(
            ([v, t]) => `<option value="${v}"${v === u.level ? ' selected' : ''}>${t}</option>`,
          ).join('')}
        </select>
      </label>

      ${field('reference_code', 'Reference code', 'placeholder="PR/StM/B"')}

      <div class="field-pair">
        ${field('start_date', 'Start date', 'placeholder="1552"')}
        ${field('end_date', 'End date', 'placeholder="1991"')}
      </div>

      ${field('extent', 'Extent', 'placeholder="1 volume, 240 fols."')}
      ${field('creator', 'Creator', 'placeholder="Parish of St Mary"')}
      ${area('scope_content', 'Scope and content', 3)}

      <details class="advanced-field">
        <summary>Context, access and condition</summary>
        ${area('admin_history', 'Administrative history', 3)}
        ${field('access', 'Conditions of access')}
        ${field('medium', 'Medium')}
        ${field('condition', 'Condition')}
      </details>

      ${area('notes', 'Notes', 2)}

      <label class="field">
        <span>Hangs from</span>
        <select id="unit-parent">
          <option value="">- root of the scheme -</option>
          ${posiblesPadres
            .map(
              (n) =>
                `<option value="${n.id}"${n.id === u.parent_id ? ' selected' : ''}>${esc(n.title)}</option>`,
            )
            .join('')}
        </select>
      </label>
    </form>

    <div class="scheme-actions">
      <button class="minor-button" data-create-child="${u.id}">+ Unit inside</button>
      <button class="minor-button" data-view-unit-docs="${u.id}">
        View its ${formatNumber(u.documents)} documents
      </button>
      <button class="minor-button peligro" data-remove-unit="${u.id}">Delete</button>
    </div>

    <p class="adjustments-note">
      Deleting a unit never deletes documents: whatever hangs from it moves up
      to the level above.
    </p>`;
}

/** Saves a unit field shortly after typing stops. */
const guardadoUnidad = new Map();

function saveUnitField(id, field, value) {
  clearTimeout(guardadoUnidad.get(field));
  guardadoUnidad.set(
    field,
    setTimeout(async () => {
      const notice = document.getElementById('unit-state');
      try {
        const r = await fetch(`/api/unit/${id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? 'not saved');

        if (notice) {
          notice.textContent = 'Saved';
          notice.className = 'form-status ok';
          setTimeout(() => {
            if (notice.isConnected && notice.textContent === 'Saved') notice.textContent = '';
          }, 1800);
        }

        // The tree shows title, level and reference code: it has to be
        // refreshed so it does not keep showing the old values while editing.
        if (['title', 'level', 'reference_code'].includes(field)) {
          const n = scheme.nodes.find((x) => x.id === id);
          if (n) {
            n[field] = value || null;
            renderClassificationTree();
          }
        }
      } catch (e) {
        if (notice) {
          notice.textContent = e.message;
          notice.className = 'form-status error';
        }
      }
    }, 600),
  );
}

/** Closes the side panel and clears the selection in the tree. */
function closeSchemeRecord() {
  scheme.chosen = null;
  const record = document.getElementById('scheme-record');
  if (record) record.innerHTML = '';
  renderClassificationTree();
}

/** Creation form inside the side panel, with no browser dialogs. */
function askUnitTitle(parentId) {
  const record = document.getElementById('scheme-record');
  if (!record) return;

  record.innerHTML = `
    <form class="record-form" id="form-new-unit">
      <label class="field">
        <span>${parentId ? 'Title of the new unit' : 'Title of the new fonds'}</span>
        <input id="new-unit-title" autocomplete="off" required>
      </label>
      <p class="form-status error" id="new-unit-error"></p>
      <div class="scheme-actions">
        <button type="submit" class="minor-button">Create</button>
        <button type="button" class="minor-button" id="new-unit-cancel">Cancel</button>
      </div>
    </form>`;

  const form = document.getElementById('form-new-unit');
  const input = document.getElementById('new-unit-title');
  const cancel = () => {
    if (parentId) void openUnit(parentId);
    else closeSchemeRecord();
  };

  input.focus();
  document.getElementById('new-unit-cancel').addEventListener('click', cancel);
  form.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') cancel();
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const title = input.value.trim();
    if (title) void createUnit(parentId, title);
  });
}

async function createUnit(parentId, title) {
  // The default level follows the parent's: inside a fonds usually comes a
  // section, and inside a section a series.
  const padre = scheme.nodes.find((n) => n.id === parentId);
  const fallback = !padre
    ? 'fonds'
    : padre.level === 'fonds'
      ? 'section'
      : padre.level === 'section'
        ? 'series'
        : padre.level === 'series'
          ? 'subseries'
          : 'item';

  try {
    const r = await fetch('/api/unit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), level: fallback, parent_id: parentId ?? null }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'it was not created');

    if (parentId) scheme.expanded.add(parentId);
    scheme.chosen = d.id;
    scheme.nodes = await fetchJson('/api/classification');
    renderClassificationTree();
    await openUnit(d.id);
    void renderBrowser();
  } catch (e) {
    const notice = document.getElementById('new-unit-error');
    if (notice) notice.textContent = `Could not create it: ${e.message}`;
    else alert(`Could not create it: ${e.message}`);
  }
}

// Scheme actions.
document.addEventListener('click', async (e) => {
  const plegar = e.target.closest('[data-collapse-unit]');
  if (plegar) {
    const id = Number(plegar.dataset.collapseUnit);
    if (scheme.expanded.has(id)) scheme.expanded.delete(id);
    else scheme.expanded.add(id);
    renderClassificationTree();
    return;
  }

  const open = e.target.closest('[data-open-unit]');
  if (open) {
    const id = Number(open.dataset.openUnit);
    // Clicking the open unit again closes the panel.
    if (scheme.chosen === id && document.querySelector('#form-unit')) closeSchemeRecord();
    else await openUnit(id);
    return;
  }

  if (e.target.closest('#scheme-close')) {
    closeSchemeRecord();
    return;
  }

  if (e.target.closest('#scheme-new-fonds')) {
    askUnitTitle(null);
    return;
  }

  const hija = e.target.closest('[data-create-child]');
  if (hija) {
    askUnitTitle(Number(hija.dataset.createChild));
    return;
  }

  const verDocs = e.target.closest('[data-view-unit-docs]');
  if (verDocs) {
    const id = Number(verDocs.dataset.viewUnitDocs);
    const n = scheme.nodes.find((x) => x.id === id);
    state.query = '';
    state.type = null;
    state.tag = null;
    state.century = null;
    state.unit = String(id);
    state.unitTitle = n?.title ?? '';
    state.page = 1;
    goTo('search');
    return;
  }

  const remove = e.target.closest('[data-remove-unit]');
  if (remove) {
    const id = Number(remove.dataset.removeUnit);
    const n = scheme.nodes.find((x) => x.id === id);
    if (
      !confirm(
        `Delete "${n?.title ?? 'this unit'}" from the scheme?\n\n` +
          'The documents and units hanging from it are not deleted:\n' +
          'they move up a level.',
      )
    ) {
      return;
    }

    try {
      const r = await fetch(`/api/unit/${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'it was not deleted');

      scheme.chosen = null;
      scheme.nodes = await fetchJson('/api/classification');
      renderClassificationTree();
      const record = document.getElementById('scheme-record');
      if (record) record.innerHTML = '';
      void renderBrowser();
    } catch (err) {
      alert(`Could not remove it: ${err.message}`);
    }
  }
});

// Automatic saving of the unit record.
document.addEventListener('input', (e) => {
  const field = e.target.closest('[data-unit-field]');
  const form = field?.closest('#form-unit');
  if (!form) return;
  saveUnitField(Number(form.dataset.unitRecord), field.dataset.unitField, field.value);
});

document.addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-unit-field]');
  if (sel) {
    const form = sel.closest('#form-unit');
    if (form) saveUnitField(Number(form.dataset.unitRecord), sel.dataset.unitField, sel.value);
    return;
  }

  // Move the unit to another point of the scheme.
  const padre = e.target.closest('#unit-parent');
  if (!padre) return;

  const form = padre.closest('.scheme-record')?.querySelector('#form-unit');
  if (!form) return;
  const id = Number(form.dataset.unitRecord);
  const notice = document.getElementById('unit-state');

  try {
    const r = await fetch(`/api/unit/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parent_id: padre.value === '' ? null : Number(padre.value) }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'it was not moved');

    if (padre.value) scheme.expanded.add(Number(padre.value));
    scheme.nodes = await fetchJson('/api/classification');
    renderClassificationTree();
    if (notice) {
      notice.textContent = 'Moved';
      notice.className = 'form-status ok';
    }
    void renderBrowser();
  } catch (err) {
    if (notice) {
      notice.textContent = err.message;
      notice.className = 'form-status error';
    }
  }
});


/* ---------- Quick review of the suggested records ---------- */

/**
 * The indexer reads each file name and proposes a record. Most are correct,
 * so reviewing them is mostly confirming: the document and its record are
 * shown, and it is accepted or corrected with a single key.
 */
// `correcting` holds the document taken to the viewer to be corrected, and
// `corrected` whether it actually got described: together they decide whether
// the record leaves the queue on return or stays pending.
// `decided` are the records accepted or dismissed in this session, oldest to
// newest: the last one is the one «Undo» reverts.
const review = {
  cola: [], idx: 0, total: 0, done: 0, corrigiendo: null, corregido: false, decided: [],
};

/** Puts the last decided record back in the queue. */
async function undoLastReview() {
  const d = review.decided[review.decided.length - 1];
  if (!d) return;
  try {
    const r = await fetch('/api/review/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documents: [d.id] }),
    });
    if (!r.ok) return;
  } catch {
    return;
  }
  review.decided.pop();
  review.cola.splice(review.idx, 0, d);
  review.done = Math.max(0, review.done - 1);
  review.total++;
  renderReview();
}

const undoButton = () =>
  review.decided.length
    ? '<button id="rev-undo" class="rev-batch">↶ Undo the last one <kbd>Z</kbd></button>'
    : '';

const recentLink =
  '<button id="rev-recent" class="rev-batch">See what was reviewed recently</button>';

async function showReview() {
  main.innerHTML = '<p class="loading">Loading…</p>';
  review.done = 0;
  review.corrigiendo = null;
  review.corregido = false;
  await fetchQueue(true);
  renderReview();
}

async function fetchQueue(reset = false) {
  const r = await fetchJson(`/api/review/queue?limit=25${reset ? '' : ''}`);
  review.cola = r.results;
  review.idx = 0;
  review.total = r.total;
}

function renderReview() {
  const d = review.cola[review.idx];

  if (!d) {
    main.innerHTML = `
      <div class="review-end">
        <h1>${review.total === 0 ? 'Nothing left to review' : 'Batch finished'}</h1>
        <p class="search-summary">
          ${review.done > 0 ? `You have reviewed ${formatNumber(review.done)} records. ` : ''}
          ${review.total > 0 ? `${formatNumber(review.total)} left to review.` : ''}
        </p>
        ${review.total > 0 ? '<button id="rev-seguir">Fetch the next batch</button>' : ''}
        <p>${undoButton()} ${recentLink}</p>
      </div>`;
    return;
  }

  const avisos = JSON.parse(d.warnings ?? '[]');
  const img = d.thumbnail
    ? `<img src="/thumb/${esc(d.thumbnail)}" alt="">`
    : `<div class="no-img"><span class="no-img-ext">${esc((d.extension ?? '').replace('.', '').toUpperCase())}</span></div>`;

  main.innerHTML = `
    <div class="review">
      <div class="rev-header">
        <span class="rev-progreso">
          ${formatNumber(review.total)} to review / ${review.idx + 1} of this batch
        </span>
        ${undoButton()}
        ${recentLink}
        ${
          (d.confidence ?? 0) >= 0.9
            ? '<button id="rev-batch" class="rev-batch">Accept all the reliable ones at once</button>'
            : ''
        }
        <span class="rev-confidence">Reading reliability: ${Math.round((d.confidence ?? 0) * 100)} %</span>
      </div>

      <div class="rev-body">
        <button class="rev-image" id="rev-open" title="Open in the viewer (V)">${img}</button>

        <div class="rev-record">
          <p class="rev-file">${esc(d.name)}</p>
          <p class="rev-path">${esc(d.unit_title ?? '')}</p>

          <dl class="rev-data">
            <dt>Record type</dt><dd>${esc(RECORD_TYPES[d.record_type] ?? 'not recognised')}</dd>
            <dt>People</dt>
            <dd>${esc(d.person ?? '—')}${d.person_2 ? ` <span style="opacity:.6">and</span> ${esc(d.person_2)}` : ''}</dd>
            <dt>Year</dt><dd>${readableYear(d.year)}</dd>
            ${d.page ? `<dt>Page</dt><dd>${d.page}</dd>` : ''}
          </dl>

          ${
            avisos.length
              ? `<p class="rev-warnings">${avisos
                  .map((a) => `<span class="tag">${esc(WARNINGS[a] ?? a)}</span>`)
                  .join(' ')}</p>`
              : ''
          }

          <div class="rev-actions">
            <button id="rev-accept" class="rev-yes">Accept <kbd>Enter</kbd></button>
            <button id="rev-correct">Correct <kbd>C</kbd></button>
            <button id="rev-dismiss">Not a record <kbd>N</kbd></button>
          </div>
          <p class="rev-help">
            <kbd>→</kbd> skip without deciding / <kbd>V</kbd> view the document
          </p>
        </div>
      </div>
    </div>`;
}

async function decideReview(action) {
  const d = review.cola[review.idx];
  if (!d) return;

  if (action === 'correct') {
    // Correcting means describing: the viewer opens with the form already
    // in place. Closing it resumes the queue, and the record counts as
    // settled if something was really described (the server decides on
    // save).
    review.corrigiendo = d.id;
    await openDocument(d.id, -1);
    document.querySelector('[data-tab="describe"]')?.click();
    return;
  }

  if (action !== 'skip') {
    const path = action === 'accept' ? '/api/review/accept' : '/api/review/dismiss';
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documents: [d.id] }),
      });
      if (!r.ok) return;
      review.done++;
      review.total = Math.max(0, review.total - 1);
      review.decided.push(d);
    } catch {
      return; // offline: do not advance, so the decision is not lost
    }
  }

  review.idx++;
  if (review.idx >= review.cola.length) {
    // The next batch is fetched automatically if there is work left.
    if (review.total > 0) await fetchQueue();
  }
  renderReview();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#rev-accept')) void decideReview('accept');
  else if (e.target.closest('#rev-dismiss')) void decideReview('dismiss');
  else if (e.target.closest('#rev-correct')) void decideReview('correct');
  else if (e.target.closest('#rev-open')) {
    const d = review.cola[review.idx];
    if (d) void openDocument(d.id, -1);
  } else if (e.target.closest('#rev-seguir')) void showReview();
  else if (e.target.closest('#rev-batch')) void acceptReliableBatch();
  else if (e.target.closest('#rev-undo')) void undoLastReview();
  else if (e.target.closest('#rev-recent')) void showRecentReview();
  else if (e.target.closest('#rev-back')) {
    // showReview resets the counter, but not what was decided in the session.
    void showReview();
  }
});

/* ---------- What was reviewed recently ---------- */

const ago = (stamp) => {
  const t = new Date(`${stamp.replace(' ', 'T')}Z`);
  const min = Math.round((Date.now() - t.getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${Math.round(min / 60)} h ago`;
  return t.toLocaleDateString();
};

async function showRecentReview() {
  main.innerHTML = '<p class="loading">Loading…</p>';
  let r;
  try {
    r = await fetchJson('/api/review/recent');
  } catch {
    main.innerHTML = '<p>Could not load what was reviewed.</p>';
    return;
  }

  const batches = r.batches
    .map(
      (b) => `<li class="rec-row">
        <div class="rec-text">
          <strong>Accepted in one go: ${formatNumber(b.n)} records</strong>
          <span class="rec-meta">${ago(b.decided_at)}</span>
        </div>
        <button class="minor-button" data-rec-batch="${esc(b.batch)}">Undo the batch</button>
      </li>`,
    )
    .join('');

  const rows = r.individual
    .map(
      (x) => `<li class="rec-row">
        <div class="rec-text">
          <strong>${esc(x.person ?? x.name)}</strong>
          <span class="rec-meta">
            ${esc(RECORD_TYPES[x.record_type] ?? 'not recognised')} · ${readableYear(x.year)} ·
            ${x.status === 'accepted' ? 'accepted' : 'dismissed'} ${ago(x.decided_at)}
          </span>
          <span class="rec-meta">${esc(x.name)}</span>
        </div>
        <button class="minor-button" data-rec-correct="${x.id}">Correct</button>
        <button class="minor-button" data-rec-undo="${x.id}">Back to the queue</button>
      </li>`,
    )
    .join('');

  main.innerHTML = `
    <div class="rev-recent">
      <div class="scheme-head">
        <h1>Recently reviewed</h1>
        <button id="rev-back" class="minor-button">← Back to the review</button>
      </div>
      <p class="search-summary">
        «Back to the queue» undoes the decision and the record reappears to be reviewed.
        «Correct» opens the document to describe it by hand.
      </p>
      ${batches || rows ? `<ul class="rec-list">${batches}${rows}</ul>` : '<p>Nothing yet.</p>'}
    </div>`;
}

document.addEventListener('click', async (e) => {
  const batch = e.target.closest('[data-rec-batch]');
  const one = e.target.closest('[data-rec-undo]');
  const correct = e.target.closest('[data-rec-correct]');

  if (correct) {
    await openDocument(Number(correct.dataset.recCorrect), -1);
    document.querySelector('[data-tab="describe"]')?.click();
    return;
  }
  if (!batch && !one) return;

  const body = batch
    ? { batch: batch.dataset.recBatch }
    : { documents: [Number(one.dataset.recUndo)] };
  try {
    const r = await fetch('/api/review/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error();
    // What is undone here is no longer «the last one» of the session.
    review.decided = [];
  } catch {
    alert('Could not undo it.');
    return;
  }
  void showRecentReview();
});

/**
 * Accepts in one go every record that was read well.
 *
 * The indexer gets the vast majority right; reviewing one by one what is
 * already correct is wasted work. The doubtful ones still go through review.
 */
async function acceptReliableBatch() {
  if (!confirm(
      'Every record read with high reliability will be accepted as good.\n\n' +
        'You can undo it later from «See what was reviewed recently».',
    )) return;

  main.innerHTML = '<p class="loading">Accepting records…</p>';
  const batch = `l${Date.now().toString(36)}`;

  try {
    let accepted = 0;
    // It is done in batches so thousands of ids are not sent at once.
    for (;;) {
      const r = await fetchJson('/api/review/queue?limit=50');
      const fiables = r.results.filter((x) => (x.confidence ?? 0) >= 0.9).map((x) => x.id);
      if (fiables.length === 0) break;

      const resp = await fetch('/api/review/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documents: fiables, batch }),
      });
      if (!resp.ok) break;
      accepted += fiables.length;
    }
    review.decided = []; // the batch is undone whole from the list

    review.done += accepted;
    await showReview();
  } catch {
    await showReview();
  }
}

// Review shortcuts, only while that screen is in front.
document.addEventListener('keydown', (e) => {
  if (state.section !== 'review' || !viewer.hidden) return;
  if (e.target.matches('input, textarea, select')) return;

  switch (e.key) {
    case 'Enter':
      void decideReview('accept');
      break;
    case 'c':
    case 'C':
      void decideReview('correct');
      break;
    case 'n':
    case 'N':
      void decideReview('dismiss');
      break;
    case 'ArrowRight':
      void decideReview('skip');
      break;
    case 'z':
    case 'Z':
      void undoLastReview();
      break;
    case 'v':
    case 'V': {
      const d = review.cola[review.idx];
      if (d) void openDocument(d.id, -1);
      break;
    }
    default:
      return;
  }
  e.preventDefault();
});

/* ---------- People: matching against the tree ---------- */

/**
 * Identifies in Gramps whoever gives each document its name.
 *
 * This is the sibling of the review, but one step further in: there you
 * confirm *what* the document says, here *who* it is about. What decides
 * between two namesakes is always the date, so each candidate is shown with
 * the year of the fact that supports it.
 */
const matches = { queue: [], idx: 0, done: 0, total: 0, certain_count: 0, reviewed: 0, chosen: new Map() };

async function showMatches() {
  main.innerHTML = '<p class="loading">Matching against the tree…</p>';
  matches.done = 0;
  matches.idx = 0;
  matches.chosen.clear();

  try {
    const r = await fetchJson('/api/matches/queue?limit=25');
    matches.queue = r.results ?? [];
    matches.total = r.total ?? matches.queue.length;
    matches.certain_count = r.certain_count ?? 0;
    matches.reviewed = r.reviewed ?? 0;
  } catch (e) {
    main.innerHTML = `<div class="review-end"><h1>Cannot match</h1>
      <p class="search-summary">${esc(e.message)}. Connect the Gramps tree from Home.</p></div>`;
    return;
  }
  renderMatch();
}

function renderMatch() {
  const s = matches.queue[matches.idx];

  if (!s) {
    const remaining = matches.total > matches.queue.length;

    // Only reviewed records are offered here. With none reviewed, "nothing
    // left" would read as if the work were done when it has not started.
    if (!remaining && matches.done === 0) {
      main.innerHTML = `
        <div class="review-end">
          <h1>${matches.reviewed ? 'No matches in the tree' : 'Nothing to match yet'}</h1>
          <p class="search-summary">
            ${
              matches.reviewed
                ? `None of your ${formatNumber(matches.reviewed)} reviewed records matches a
                   person in your Gramps tree by name and date, or they are already linked.`
                : `This screen proposes people from your Gramps tree for the records
                   you have reviewed, and you have not reviewed any yet.`
            }
            Review more records in <strong>Review</strong> and the ones the tree can
            identify will appear here.
          </p>
          <button id="sug-go-review">Go to Review</button>
        </div>`;
      return;
    }

    main.innerHTML = `
      <div class="review-end">
        <h1>${remaining ? 'Batch finished' : 'Nothing left to identify'}</h1>
        <p class="search-summary">
          ${matches.done > 0 ? `You have identified ${formatNumber(matches.done)} people. ` : ''}
          ${remaining
            ? `${formatNumber(matches.total - matches.queue.length)} left to match.`
            : 'As you review more records, the ones the tree can identify will appear here.'}
        </p>
        ${remaining ? '<button id="sug-next">Fetch the next batch</button>' : ''}
      </div>`;
    return;
  }

  const img = s.thumbnail
    ? `<img src="/thumb/${esc(s.thumbnail)}" alt="">`
    : `<div class="no-img"><span class="no-img-ext">${esc((s.extension ?? '').replace('.', '').toUpperCase())}</span></div>`;

  main.innerHTML = `
    <div class="review">
      <div class="rev-header">
        <span class="rev-progreso">
          ${formatNumber(matches.total)} to identify / ${matches.idx + 1} of this batch
        </span>
        ${matches.certain_count > 1 ? `<button id="sug-lote" class="rev-batch">Link the ${formatNumber(matches.certain_count)} certain ones</button>` : ''}
        ${s.couple ? '<span class="rev-confidence">Both spouses match</span>' : ''}
      </div>

      <div class="rev-body">
        <button class="rev-image" id="sug-open" title="Open in the viewer (V)">${img}</button>

        <div class="rev-record">
          <p class="rev-file">${esc(s.file)}</p>
          <p class="rev-path">${esc(s.unit_title ?? '')}</p>

          <dl class="rev-data">
            <dt>Record type</dt><dd>${esc(RECORD_TYPES[s.record_type] ?? 'not recognised')}</dd>
            <dt>Year</dt><dd>${readableYear(s.year)}</dd>
            <dt>Role</dt><dd>${esc(s.role)}</dd>
          </dl>

          ${s.people.map((p, i) => personBlock(p, i)).join('')}

          <div class="rev-actions">
            <button id="sug-accept" class="rev-yes">Link <kbd>Enter</kbd></button>
            <button id="sug-skip">Not now <kbd>→</kbd></button>
          </div>
          <p class="rev-help">
            What you link can be changed later, from the entry.
          </p>
        </div>
      </div>
    </div>`;
}

/** A spouse or the subject, with their candidates from the tree. */
function personBlock(p, idx) {
  if (p.candidates.length === 0) {
    return `<div class="sug-person">
      <p class="sug-read">${esc(p.name)}</p>
      <p class="sug-empty">Not in the tree, or recorded under another spelling</p>
    </div>`;
  }

  const key = String(idx);
  if (!matches.chosen.has(key)) {
    // An uncertain candidate comes unticked: if it did not, pressing Enter
    // would be enough to accept an identification the matching itself does
    // not support.
    const first = p.candidates[0];
    matches.chosen.set(key, first.certainty === 'uncertain' ? '' : first.gramps_id);
  }
  const chosen = matches.chosen.get(key);

  const options = p.candidates
    .map(
      (c) => `
      <label class="sug-option ${c.gramps_id === chosen ? 'elegida' : ''}">
        <input type="radio" name="sug-${idx}" value="${esc(c.gramps_id)}"
               data-person="${idx}" ${c.gramps_id === chosen ? 'checked' : ''}>
        <span class="sug-name">${esc(c.name)}</span>
        <span class="tag cert-${esc(c.certainty)}">${esc(c.certainty)}</span>
        <span class="sug-reason">${esc(c.event_type)} of ${c.year} · ${esc(c.reason)}</span>
      </label>`,
    )
    .join('');

  return `<div class="sug-person">
    <p class="sug-read">${esc(p.name)}</p>
    <div class="sug-options">${options}</div>
    <label class="sug-none">
      <input type="radio" name="sug-${idx}" value="" data-person="${idx}"
             ${chosen === '' ? 'checked' : ''}>
      None of these
    </label>
  </div>`;
}

/** Saves the chosen links and moves on to the next document. */
async function decideMatch(action) {
  const s = matches.queue[matches.idx];
  if (!s) return;

  if (action === 'link') {
    const links = [];
    s.people.forEach((p, i) => {
      const grampsId = matches.chosen.get(String(i));
      if (!grampsId) return;
      const c = p.candidates.find((x) => x.gramps_id === grampsId);
      if (!c) return;
      links.push({
        document: s.document,
        gramps_id: c.gramps_id,
        name: c.name,
        role: s.role,
        certainty: c.certainty,
      });
    });

    if (links.length > 0) {
      try {
        const r = await fetch('/api/matches/accept', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ links }),
        });
        if (!r.ok) throw new Error('not saved');
        matches.done += links.length;
      } catch {
        return; // offline: do not advance, so the decision is not lost
      }
    }
  }

  matches.chosen.clear();
  matches.idx++;
  renderMatch();
}

/**
 * Links in one stroke everything about which no doubt is possible.
 *
 * The server resolves it over the whole archive, not over the batch on
 * screen: pressing the button once per batch would be exactly the repetitive
 * work this screen exists to save.
 */
async function acceptCertainMatches() {
  if (matches.certain_count === 0) return;
  if (
    !confirm(
      `${formatNumber(matches.certain_count)} documents whose identification admits no doubt will be linked:\n` +
        'a unique name in the tree and a matching date.\n\n' +
        'You can undo any of them from its entry.',
    )
  ) {
    return;
  }

  main.innerHTML = '<p class="loading">Linking…</p>';
  try {
    const r = await fetch('/api/matches/accept-certain', { method: 'POST' });
    if (!r.ok) throw new Error('it could not be linked');
    matches.done += (await r.json()).saved ?? 0;
  } catch {
    /* it reloads either way: what was saved will show, what was not stays queued */
  }
  await showMatches();
}

document.addEventListener('change', (e) => {
  const option = e.target.closest('[data-person]');
  if (!option) return;
  matches.chosen.set(option.dataset.person, option.value);
  for (const l of document.querySelectorAll(`[name="sug-${option.dataset.person}"]`)) {
    l.closest('.sug-option')?.classList.toggle('elegida', l.checked);
  }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('#sug-accept')) void decideMatch('link');
  else if (e.target.closest('#sug-skip')) void decideMatch('skip');
  else if (e.target.closest('#sug-next')) void showMatches();
  else if (e.target.closest('#sug-go-review')) void goTo('review');
  else if (e.target.closest('#sug-lote')) void acceptCertainMatches();
  else if (e.target.closest('#sug-open')) {
    const s = matches.queue[matches.idx];
    if (s) void openDocument(s.document, -1);
  }
});

// Matching shortcuts, only while that screen is in front.
document.addEventListener('keydown', (e) => {
  if (state.section !== 'people' || !viewer.hidden) return;
  if (e.target.matches('input, textarea, select')) return;

  switch (e.key) {
    case 'Enter':
      void decideMatch('link');
      break;
    case 'ArrowRight':
      void decideMatch('skip');
      break;
    case 'v':
    case 'V': {
      const s = matches.queue[matches.idx];
      if (s) void openDocument(s.document, -1);
      break;
    }
    default:
      return;
  }
  e.preventDefault();
});

/* ---------- Lagunas documentales ---------- */

/**
 * Which facts in the tree have no document backing them up.
 *
 * This is the one screen that looks not at what is held but at what is
 * missing: it turns the archive into a work plan for the next visit.
 */
async function showGaps() {
  main.innerHTML = '<p class="loading">Crossing the tree with the archive…</p>';

  let r;
  try {
    r = await fetchJson('/api/gaps');
  } catch {
    main.innerHTML = `
      <div class="review-end">
        <h1>The Gramps tree is needed</h1>
        <p class="search-summary">
          This screen crosses the facts in your tree with the documents you
          hold. Connect it from <strong>Home</strong>.
        </p>
      </div>`;
    return;
  }

  if (r.total === 0) {
    main.innerHTML = `
      <div class="review-end">
        <h1>Nothing to cross yet</h1>
        <p class="search-summary">
          Link documents to people in the tree from each document's record,
          and what is left to find will appear here.
        </p>
      </div>`;
    return;
  }

  const pct = r.total > 0 ? Math.round((r.covered / r.total) * 100) : 0;

  main.innerHTML = `
    <h1>What is left to find</h1>
    <p class="search-summary">
      Of ${formatNumber(r.total)} documentable facts in your tree, you have a record for
      <strong>${formatNumber(r.covered)}</strong> (${pct} %).
      <strong>${formatNumber(r.gaps.length)}</strong>${r.truncated ? ' or more' : ''} are missing.
    </p>

    <div class="coverage-bar" role="img"
         aria-label="${pct} per cent of the facts documented">
      <div class="bc-fill" style="width:${pct}%"></div>
    </div>

    <div class="figures" style="margin-top:1.2rem">
      ${r.byType
        .map(
          (t) => `
        <button class="figure" data-gap-type="${esc(t.type)}">
          <div class="n">${formatNumber(t.n)}</div>
          <div class="et">${esc(RECORD_TYPES[t.type] ?? t.type)} with no document</div>
        </button>`,
        )
        .join('')}
    </div>

    <h2 style="margin-top:2rem">Still to find</h2>
    <p class="search-summary" style="margin-bottom:.8rem">
      Facts from the last 25 years are not listed: archives apply
      closure periods and those entries cannot be requested yet.
    </p>
    <div class="list" id="lista-gaps">
      ${r.gaps.slice(0, 200).map(gapRow).join('')}
    </div>
    ${
      r.gaps.length > 200
        ? `<p class="search-summary" style="margin-top:1rem">
             Showing the 200 most recent of ${formatNumber(r.gaps.length)}.
           </p>`
        : ''
    }`;
}

function gapRow(l) {
  return `
    <div class="row row-laguna">
      <div class="gap-record">${esc(RECORD_TYPES[l.expected_record] ?? l.expected_record)}</div>
      <div>
        <div class="gap-person">${esc(l.person)}</div>
        <div class="path">
          ${l.date ? esc(l.date) : 'no date'}
          ${l.place ? ` · ${esc(l.place)}` : ''}
          ${l.citations > 0 ? ` · <span class="gap-citations">${l.citations} citation(s) in Gramps</span>` : ''}
        </div>
      </div>
      <button data-search-gap="${esc(l.person)}" title="Search the archive">Search</button>
    </div>`;
}

// Clicking a gap searches for that person in the archive: the document may
// be indexed but not yet linked.
document.addEventListener('click', (e) => {
  const search = e.target.closest('[data-search-gap]');
  if (search) {
    clearFilters();
    state.query = search.dataset.searchGap;
    document.getElementById('q').value = state.query;
    goTo('search');
    return;
  }

  const byType = e.target.closest('[data-gap-type]');
  if (byType) {
    const lines = document.querySelectorAll('.row-laguna');
    const buscado = RECORD_TYPES[byType.dataset.gapType] ?? byType.dataset.gapType;
    for (const f of lines) {
      const recordType = f.querySelector('.gap-record')?.textContent.trim();
      f.hidden = recordType !== buscado;
    }
  }
});

async function showDuplicates() {
  main.innerHTML = '<p class="loading">Loading…</p>';
  const groups = await fetchJson('/api/duplicates');

  if (!groups.length) {
    main.innerHTML = `
      <h1>Duplicates</h1>
      <p class="search-summary">
        No repeated files: every document in the archive has unique content.
      </p>`;
    return;
  }

  main.innerHTML = `
    <h1>Duplicates</h1>
    <p class="search-summary">${formatNumber(groups.length)} groups of files with identical content.</p>
    ${groups
      .map(
        (g) => `<div class="dup-group">
          <h3>${g.copies} copies of the same content</h3>
          <div class="list">
            ${g.files
              .map(
                (f) => `<div class="row">
                  ${f.thumbnail ? `<img src="/thumb/${esc(f.thumbnail)}" alt="">` : '<div></div>'}
                  <div><div>${esc(f.name)}</div><div class="path">${esc(f.path)}</div></div>
                  <button data-doc="${f.id}">View</button>
                </div>`,
              )
              .join('')}
          </div>
        </div>`,
      )
      .join('')}`;
}

/* ---------- Visor ---------- */

/**
 * Documents passed through inside the viewer.
 *
 * Jumping from one document to another following a person is the natural way
 * to go through an archive, and without a way back the thread is lost.
 */
const viewerHistory = [];

async function openDocument(id, idx, options = {}) {
  // Where we came from is noted, except when going back (which pops it).
  if (!options.goingBack && !viewer.hidden && state.documentoAbierto &&
      state.documentoAbierto !== id) {
    viewerHistory.push(state.documentoAbierto);
  }
  state.documentoAbierto = id;

  const atras = document.getElementById('viewer-back');
  if (atras) atras.hidden = viewerHistory.length === 0;

  const d = await fetchJson(`/api/document/${id}`);
  state.indiceAbierto = idx ?? -1;
  state.zoom = 1;
  state.desplazado = { x: 0, y: 0 };
  // Every document opens clean: an extreme contrast that helps on one folio
  // ruins the reading of the next.
  adjustments = { ...DEFAULT_ADJUSTMENTS };
  applyFilters();

  visorTitulo.textContent = d.name;
  docFinder.family = familyOf(d);
  closeDocFinder();

  await showByFormat(d);

  // If we got here searching for something, the viewer opens straight at the
  // first match: landing at the start of the document would mean hunting by
  // eye for what the results list already knew the position of.
  if (
    state.section === 'search' &&
    state.query &&
    docFinder.family !== 'image' &&
    docFinder.family !== 'other'
  ) {
    const term = state.query.replace(/^"|"$/g, '');
    openDocFinder(term);
  }

  const avisos = JSON.parse(d.warnings ?? '[]');
  const breadcrumbs = (d.path_to_root ?? []).map((c) => esc(c.title)).join(' › ');

  visorFicha.innerHTML = `
    <nav class="record-pestanas">
      <button class="active" data-tab="data">Data</button>
      <button data-tab="describe">
        Describe${d.description ? ' <span class="described-dot"></span>' : ''}
      </button>
    </nav>

    <div data-panel-record="data">
    ${breadcrumbs ? `<div class="breadcrumbs">${breadcrumbs}</div>` : ''}
    <h3>${esc(d.person ?? d.name)}</h3>
    ${d.person_2 ? `<p style="margin-top:-.4rem;color:var(--ink-soft)">and ${esc(d.person_2)}</p>` : ''}
    <dl>
      <dt>Record type</dt><dd>${esc(RECORD_TYPES[d.record_type] ?? '—')}</dd>
      <dt>Year</dt><dd>${readableYear(d.year)}</dd>
      ${d.page ? `<dt>Page</dt><dd>${d.page}</dd>` : ''}
      <dt>File</dt><dd>${esc(d.name)}</dd>
      <dt>Size</dt><dd>${fileSize(d.bytes)}${d.width ? ` / ${d.width}x${d.height}` : ''}</dd>
      <dt>Path</dt><dd style="font-size:.8rem;color:var(--ink-faint)">${esc(d.path)}</dd>
    </dl>
    ${
      avisos.length
        ? `<p style="margin-top:.9rem">${avisos
            .map((a) => `<span class="tag">${esc(WARNINGS[a] ?? a)}</span>`)
            .join(' ')}</p>`
        : ''
    }
    ${
      d.duplicates?.length
        ? `<p style="margin-top:.9rem;font-size:.85rem">
             <strong>${d.duplicates.length}</strong> identical copy/copies in other folders.</p>`
        : ''
    }
    <div class="record-tags" id="record-tags" data-document="${d.id}"></div>
    <p style="margin-top:1.2rem">
      <a class="original-link" href="/file/${d.id}" target="_blank" rel="noopener">Open the original in a new tab</a>
    </p>
    <details style="margin-top:1rem">
      <summary style="cursor:pointer;font-size:.85rem;color:var(--ink-soft)">Keyboard shortcuts</summary>
      <dl style="margin-top:.5rem;grid-template-columns:62px 1fr;font-size:.8rem">
        <dt>← →</dt><dd>previous and next document</dd>
        <dt>+ −</dt><dd>zoom in and out</dd>
        <dt>0</dt><dd>fit to the window</dd>
        <dt>F</dt><dd>search inside the document</dd>
        <dt>Enter</dt><dd>next match (Shift: previous)</dd>
        <dt>L</dt><dd>reading mode</dd>
        <dt>I</dt><dd>invert</dd>
        <dt>A</dt><dd>adjustments panel</dd>
        <dt>R</dt><dd>reset</dd>
        <dt>Esc</dt><dd>close</dd>
      </dl>
    </details>
    </div>

    <div data-panel-record="describe" hidden>${descriptionForm(d)}</div>`;

  void renderRecordTags(d.id, d.tags ?? []);

  viewer.hidden = false;
  document.body.style.overflow = 'hidden';
}

/* ---------- Description record ---------- */

const SELECTABLE_RECORD_TYPES = [
  ['', '—'],
  ['birth', 'Birth'],
  ['baptism', 'Baptism'],
  ['marriage', 'Marriage'],
  ['burial', 'Burial'],
  ['marriage_licence', 'Marriage licence'],
  ['confirmation', 'Confirmation'],
  ['nuptial_blessing', 'Nuptial blessing'],
  ['record', 'Register entry'],
  ['index', 'Index'],
  ['census', 'Census or roll'],
  ['notarial', 'Notarial record'],
  ['lawsuit', 'Lawsuit'],
  ['other', 'Other'],
];

/**
 * Archival description form.
 *
 * Describing happens while looking at the document, so it lives in the side
 * record and not on a separate screen. What is written here overrides what
 * the indexer deduced from the file name.
 */
function descriptionForm(d) {
  const v = d.description ?? {};
  // With no description yet, what was read from the name is the starting
  // point: correcting is far faster than typing from scratch.
  const suggested = {
    record_type: v.record_type ?? d.record_type ?? '',
    people: v.people ?? [d.person, d.person_2].filter(Boolean).join(' · '),
    date: v.date ?? (isDoubtfulYear(d.year) ? '' : (d.year ?? '')),
  };

  const field = (id, tag, value, extra = '') => `
    <label class="field">
      <span>${esc(tag)}</span>
      <input id="des-${id}" data-field="${id}" value="${esc(value ?? '')}" ${extra}>
    </label>`;

  const area = (id, tag, value, rows = 3) => `
    <label class="field">
      <span>${esc(tag)}</span>
      <textarea id="des-${id}" data-field="${id}" rows="${rows}">${esc(value ?? '')}</textarea>
    </label>`;

  return `
    <form class="record-form" id="form-descripcion" data-document="${d.id}">
      <p class="form-status" id="form-status"></p>

      <label class="field">
        <span>Record type</span>
        <select id="des-record_type" data-field="record_type">
          ${SELECTABLE_RECORD_TYPES.map(
            ([value, text]) =>
              `<option value="${value}"${value === suggested.record_type ? ' selected' : ''}>${text}</option>`,
          ).join('')}
        </select>
      </label>

      ${field('people', 'People', suggested.people, 'placeholder="Separated by ·"')}
      ${field('date', 'Date', suggested.date, 'placeholder="1802 · 1802-05 · 1802-05-14"')}
      ${field('place', 'Place', v.place, 'placeholder="Parish or town"')}
      ${field('folio', 'Folio', v.folio, 'placeholder="45v"')}
      ${area('abstract', 'Abstract', v.abstract, 2)}
      ${area('transcription', 'Transcription', v.transcription, 5)}

      <details class="advanced-field">
        <summary>Context and condition</summary>
        ${field('creator', 'Creator', v.creator, 'placeholder="Parish of St Mary"')}
        ${field('reference_code', 'Original reference', v.reference_code, 'placeholder="PR/StM/B/3"')}
        ${field('medium', 'Medium', v.medium, 'placeholder="Paper"')}
        ${field('condition', 'Condition', v.condition, 'placeholder="Good / faded ink"')}
      </details>

      <div class="field" id="field-provenance">
        <span>Provenance</span>
        <select id="des-provenance" data-procedencia="${d.id}"></select>
      </div>

      <div class="field" id="field-gramps" data-gramps-doc="${d.id}"></div>

      ${area('notes', 'Notes', v.notes, 2)}
    </form>`;
}

/** Saves a field shortly after typing stops. */
const guardadoPendiente = new Map();

function saveField(docId, field, value) {
  clearTimeout(guardadoPendiente.get(field));
  guardadoPendiente.set(
    field,
    setTimeout(async () => {
      const notice = document.getElementById('form-status');
      try {
        const r = await fetch(`/api/description/${docId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        if (!r.ok) throw new Error('not saved');
        if (notice) {
          notice.textContent = 'Saved';
          notice.className = 'form-status ok';
          setTimeout(() => {
            if (notice.isConnected && notice.textContent === 'Saved') notice.textContent = '';
          }, 1800);
        }
        markAsDescribed(docId);
      } catch {
        if (notice) {
          notice.textContent = 'Could not save';
          notice.className = 'form-status error';
        }
      }
    }, 600),
  );
}

/** Reflects in the list and the tab that the document is now described. */
function markAsDescribed(docId) {
  const tab = document.querySelector('[data-tab="describe"]');
  if (tab && !tab.querySelector('.described-dot')) {
    tab.insertAdjacentHTML('beforeend', ' <span class="described-dot"></span>');
  }
  const card = document.querySelector(`.doc[data-doc="${docId}"]`);
  card?.classList.add('descrito');
}

// Automatic saving of each form field.
document.addEventListener('input', (e) => {
  const field = e.target.closest('[data-field]');
  if (!field) return;
  const form = field.closest('#form-descripcion');
  if (!form) return;
  saveField(Number(form.dataset.document), field.dataset.field, field.value);
});
document.addEventListener('change', (e) => {
  const field = e.target.closest('select[data-field]');
  if (!field) return;
  const form = field.closest('#form-descripcion');
  if (!form) return;
  saveField(Number(form.dataset.document), field.dataset.field, field.value);
});

// Tabs of the record panel.
document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  const which = tab.dataset.tab;

  for (const b of document.querySelectorAll('[data-tab]')) {
    b.classList.toggle('active', b === tab);
  }
  for (const p of document.querySelectorAll('[data-panel-record]')) {
    p.hidden = p.dataset.panelRecord !== which;
  }
  if (which === 'describe') {
    void loadProvenances();
    const slot = document.getElementById('field-gramps');
    // It always repaints: the slot is new for each document, and marking it
    // as painted left the section empty when the viewer was reopened.
    if (slot) {
      const docId = Number(slot.dataset.grampsDoc);
      void fetchJson(`/api/document/${docId}`).then((d) =>
        renderGramps(docId, d.description?.gramps_id ?? null),
      );
    }
  }
});

/* ---------- Link with the Gramps tree ---------- */

/**
 * Gramps section of the record panel.
 *
 * Gramps is the authority on people; here the document is merely linked to
 * one of them and what Gramps says is displayed: their events, who else takes
 * part, the notes and the citations already recorded. Nothing is written to
 * Gramps.
 */
async function renderGramps(docId, grampsId) {
  const slot = document.getElementById('field-gramps');
  if (!slot) return;

  let estadoG;
  try {
    estadoG = await fetchJson('/api/gramps/status');
  } catch {
    return;
  }
  if (!slot.isConnected) return;

  if (!estadoG.configured || !estadoG.available) {
    slot.innerHTML = `
      <span>Gramps tree</span>
      <p class="gramps-none">
        Not connected. Set it up in <strong>Home</strong>, pointing at your
        <code>sqlite.db</code>. Regesta only reads it, and over a copy.
      </p>`;
    return;
  }

  if (!grampsId) {
    slot.innerHTML = `
      <span>Person in Gramps</span>
      <div class="gramps-search">
        <input id="gramps-q" placeholder="Search the tree…" autocomplete="off"
               data-gramps-doc="${docId}">
        <div class="gramps-results" id="gramps-results"></div>
      </div>`;
    return;
  }

  slot.innerHTML = '<span>Person in Gramps</span><p class="gramps-none">Loading…</p>';

  try {
    const p = await fetchJson(`/api/gramps/person/${encodeURIComponent(grampsId)}`);
    if (!slot.isConnected) return;

    const eventos = (p.events ?? [])
      .slice(0, 8)
      .map(
        (e) => `
        <li class="gramps-evento">
          <strong>${esc(e.type)}</strong>
          ${e.date ? `<span class="ge-fecha">${esc(e.date)}</span>` : ''}
          ${e.place ? `<div class="ge-lugar">${esc(e.place)}</div>` : ''}
          ${
            e.participants?.length
              ? `<div class="ge-gente">${e.participants
                  .map((x) => `${esc(x.name)} <span class="ge-papel">${esc(x.role)}</span>`)
                  .join(' · ')}</div>`
              : ''
          }
          ${e.notes?.length ? `<div class="ge-nota">${esc(e.notes[0].slice(0, 220))}</div>` : ''}
          ${
            e.citations?.length
              ? `<div class="ge-cita">Cited in: ${e.citations
                  .map((c) => esc(c.source) + (c.page ? ` (${esc(c.page)})` : ''))
                  .join(' · ')}</div>`
              : ''
          }
        </li>`,
      )
      .join('');

    // Documents already linked to this person: their documentary trail
    // gathered, without having to search for it by name.
    let otros = [];
    try {
      otros = await fetchJson(`/api/gramps/documents/${encodeURIComponent(grampsId)}`);
    } catch {
      /* if it fails, the rest is shown */
    }

    const listaDocs = otros
      .map(
        (o) => `
        <button type="button" class="gp-doc ${o.id === docId ? 'current' : ''}" data-doc="${o.id}">
          ${
            o.thumbnail
              ? `<img src="/thumb/${esc(o.thumbnail)}" alt="" loading="lazy">`
              : `<span class="gp-doc-ext">${esc((o.extension ?? '').replace('.', '').toUpperCase())}</span>`
          }
          <span class="gp-doc-txt">
            <span class="gp-doc-type">${esc(RECORD_TYPES[o.record_type] ?? 'Document')}</span>
            ${o.year ? `<span class="gp-doc-year">${o.year}</span>` : ''}
          </span>
          ${o.id === docId ? '<span class="gp-doc-here">you are here</span>' : ''}
        </button>`,
      )
      .join('');

    slot.innerHTML = `
      <span>Person in Gramps</span>
      <div class="gramps-person">
        <div class="gp-cabecera">
          <strong>${esc([p.name, p.surname].filter(Boolean).join(' ')) || esc(grampsId)}</strong>
          ${p.dates ? `<span class="gp-fechas">${esc(p.dates)}</span>` : ''}
          <code>${esc(p.gramps_id)}</code>
          <button type="button" class="gp-remove" data-unlink="${docId}" title="Remove the link">✕</button>
        </div>

        ${
          otros.length > 1
            ? `<div class="gp-docs">
                 <p class="gp-docs-title">${otros.length} documents for this person</p>
                 <div class="gp-docs-lista">${listaDocs}</div>
               </div>`
            : ''
        }

        ${
          eventos
            ? `<ul class="gramps-eventos">${eventos}</ul>`
            : '<p class="gramps-none">No events recorded in the tree.</p>'
        }
      </div>`;
  } catch {
    slot.innerHTML = `
      <span>Person in Gramps</span>
      <p class="gramps-none">
        <code>${esc(grampsId)}</code> is no longer in the tree.
        <button type="button" class="gp-remove" data-unlink="${docId}">Remove the link</button>
      </p>`;
  }
}

// Searching for people in the tree.
let esperaGramps = null;
document.addEventListener('input', (e) => {
  const field = e.target.closest('#gramps-q');
  if (!field) return;

  clearTimeout(esperaGramps);
  const text = field.value.trim();
  const docId = Number(field.dataset.grampsDoc);

  esperaGramps = setTimeout(async () => {
    const box = document.getElementById('gramps-results');
    if (!box) return;
    if (text.length < 2) {
      box.innerHTML = '';
      return;
    }

    try {
      const list = await fetchJson(`/api/gramps/people?q=${encodeURIComponent(text)}`);
      box.innerHTML = list.length
        ? list
            .map(
              (p) => `
            <button type="button" class="gramps-op" data-link-to="${esc(p.gramps_id)}" data-document="${docId}">
              <span class="go-name">
                ${esc([p.name, p.surname].filter(Boolean).join(' ')) || esc(p.gramps_id)}
              </span>
              <span class="go-data">
                ${p.dates ? `<span class="go-fechas">${esc(p.dates)}</span>` : ''}
                <code>${esc(p.gramps_id)}</code>
              </span>
            </button>`,
            )
            .join('')
        : '<p class="gramps-none">Nobody by that name in the tree.</p>';
    } catch {
      box.innerHTML = '';
    }
  }, 300);
});

// Enlazar y unlink.
document.addEventListener('click', async (e) => {
  const enlazar = e.target.closest('[data-link-to]');
  if (enlazar) {
    // Propagation is stopped: without this the click reaches the handler
    // that opens documents and the whole viewer reloads.
    e.stopPropagation();
    const docId = Number(enlazar.dataset.document);
    const grampsId = enlazar.dataset.linkTo;
    try {
      await fetch('/api/gramps/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documento: docId, gramps_id: grampsId }),
      });
      await renderGramps(docId, grampsId);
      markAsDescribed(docId);
    } catch {
      /* it is retried */
    }
    return;
  }

  const remove = e.target.closest('[data-unlink]');
  if (remove) {
    const docId = Number(remove.dataset.unlink);
    try {
      await fetch('/api/gramps/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documento: docId, gramps_id: null }),
      });
      await renderGramps(docId, null);
    } catch {
      /* it is retried */
    }
  }
});

/** Fills in the provenance dropdown of the form. */
async function loadProvenances() {
  // The dropdown is new for each document, so it is always refilled.
  const sel = document.getElementById('des-provenance');
  if (!sel) return;

  try {
    const list = await fetchJson('/api/provenances');
    const docId = Number(sel.dataset.procedencia);
    const doc = await fetchJson(`/api/document/${docId}`);
    const current = doc.description?.provenance_id ?? '';

    sel.innerHTML = [
      '<option value="">— not given —</option>',
      ...list.map(
        (p) =>
          `<option value="${p.id}"${String(p.id) === String(current) ? ' selected' : ''}>${esc(p.name)}</option>`,
      ),
      '<option value="__new">+ New provenance…</option>',
    ].join('');
  } catch {
    /* no provenances if it fails */
  }
}

// Choose or create a provenance.
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-procedencia]');
  if (!sel) return;

  const docId = Number(sel.dataset.procedencia);

  if (sel.value === '__new') {
    const name = prompt(
      'Name of the provenance\n\nFor example: "Diocesan Archive, visit July 2024"',
    );
    sel.value = '';
    if (!name?.trim()) return;

    try {
      const r = await fetch('/api/provenances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const { id } = await r.json();

      await loadProvenances();
      sel.value = String(id);
      await assignProvenance(docId, id);
    } catch {
      /* nothing to do if it fails */
    }
    return;
  }

  await assignProvenance(docId, sel.value ? Number(sel.value) : null);
});

async function assignProvenance(docId, procedenciaId) {
  const notice = document.getElementById('form-status');
  try {
    await fetch('/api/provenances/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documents: [docId], provenance: procedenciaId }),
    });
    if (notice) {
      notice.textContent = 'Saved';
      notice.className = 'form-status ok';
    }
    markAsDescribed(docId);
  } catch {
    /* it is retried on the next choose */
  }
}

/**
 * Tags of the open document: they can be added and removed from the
 * record, which is where it is decided when looking at the document.
 */
async function renderRecordTags(docId, alreadySet = []) {
  const slot = document.getElementById('record-tags');
  if (!slot) return;

  try {
    // The document's tags already come with its record: there is no need
    // to ask for them again.
    const todas = await fetchJson('/api/tags');
    if (!slot.isConnected) return;

    const puestas = new Set(alreadySet.map((e) => e.id));
    if (todas.length === 0) {
      slot.innerHTML =
        '<p class="record-lbl-vacio">Create tags in the browser to mark documents.</p>';
      return;
    }

    slot.innerHTML = `
      <p class="record-lbl-title">Tags</p>
      <div class="record-lbl-lista">
        ${todas
          .map(
            (e) => `
            <button type="button" class="tag-button ${puestas.has(e.id) ? 'puesta' : ''}"
                    data-poner="${e.id}" data-document="${docId}"
                    aria-pressed="${puestas.has(e.id)}">
              ${esc(e.name)}
            </button>`,
          )
          .join('')}
        <button type="button" class="tag-button tag-new" id="tag-open-new" title="Create a tag">+</button>
      </div>
      <!-- It has no data-doc: that attribute is used by the handler that opens
           documents from the grid, and a click here would reopen the viewer,
           replacing the record and closing this form. -->
      <form class="record-lbl-nueva" id="form-tag-viewer" data-document="${docId}" hidden>
        <input id="tag-name-viewer" placeholder="Tag name" maxlength="60"
               autocomplete="off" aria-label="Name of the new tag">
        <button type="submit">Create and apply</button>
      </form>`;
  } catch {
    /* no tags shown if it fails; not critical */
  }
}

// The '+' button opens the field for creating a tag without leaving the
// viewer. closest is used rather than e.target.id because the click may land
// on a child element.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#tag-open-new')) return;
  e.preventDefault();
  const form = document.getElementById('form-tag-viewer');
  if (!form) return;
  form.hidden = !form.hidden;
  if (!form.hidden) document.getElementById('tag-name-viewer')?.focus();
});

/**
 * Creates a tag and applies it to the open document in one step: if it is
 * created from here, it is because it is wanted for this document.
 */
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'form-tag-viewer') return;
  e.preventDefault();

  const form = e.target;
  const field = document.getElementById('tag-name-viewer');
  const name = field.value.trim();
  if (!name) return;

  const docId = Number(form.dataset.document);

  try {
    let r = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });

    let tagId;
    if (r.ok) {
      ({ id: tagId } = await r.json());
    } else if (r.status === 409) {
      // It already existed: it is reused rather than raising an error,
      // which is what the user expects on typing a name they already use.
      const todas = await fetchJson('/api/tags');
      tagId = todas.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id;
      if (!tagId) throw new Error('tag not found');
    } else {
      throw new Error('it could not be created');
    }

    await fetch('/api/tag', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documents: [docId], tag: tagId, apply: true }),
    });

    field.value = '';
    form.hidden = true;

    const doc = await fetchJson(`/api/document/${docId}`);
    await renderRecordTags(docId, doc.tags ?? []);
    if (arbolActivo === 'tags') void renderBrowser();
  } catch {
    field.setCustomValidity('The tag could not be created');
    field.reportValidity();
    setTimeout(() => field.setCustomValidity(''), 2500);
  }
});

document.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-poner]');
  if (!button) return;

  const poner = !button.classList.contains('puesta');
  button.classList.toggle('puesta', poner);
  button.setAttribute('aria-pressed', String(poner));

  try {
    await fetch('/api/tag', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documents: [Number(button.dataset.document)],
        tag: Number(button.dataset.poner),
        apply: poner,
      }),
    });
    if (arbolActivo === 'tags') void renderBrowser();
  } catch {
    // The visual change is undone if it did not reach the server.
    button.classList.toggle('puesta', !poner);
  }
});

/* ---------- One viewer per format family ---------- */

const FAMILIES = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image',
  '.bmp': 'image', '.tif': 'image', '.tiff': 'image', '.webp': 'image',
  '.pdf': 'pdf',
  '.txt': 'text', '.md': 'text',
  // Only .docx can be converted: the old .doc is a different binary format,
  // and there are none in the archive.
  '.docx': 'word',
  '.doc': 'other', '.odt': 'other', '.rtf': 'other',
};

function familyOf(d) {
  const ext = (d.extension ?? '').toLowerCase();
  return FAMILIES[ext] ?? (d.mime?.startsWith('image/') ? 'image' : 'other');
}

/**
 * Shows the document in the viewer that suits it. Everything used to go
 * through an image element, so a PDF or a text file opened blank.
 */
async function showByFormat(d) {
  const family = familyOf(d);
  const canvas = document.getElementById('viewer-canvas');
  canvas.hidden = family !== 'image';
  document.getElementById('viewer-pdf').hidden = family !== 'pdf';
  document.getElementById('viewer-text').hidden = family !== 'text';
  document.getElementById('viewer-word').hidden = family !== 'word';
  document.getElementById('viewer-other').hidden = family !== 'other';

  viewer.classList.toggle('es-imagen', family === 'image');
  viewer.classList.toggle('es-pdf', family === 'pdf');
  // The find button appears on anything that carries text.
  viewer.classList.toggle(
    'es-text',
    family === 'text' || family === 'word' || family === 'pdf',
  );

  // Image adjustments do not apply outside the image viewer.
  if (family !== 'image') togglePanel(false);

  // The viewer is made visible before rendering: a hidden panel measures
  // zero, and the PDF would be drawn at a minuscule scale.
  if (viewer.hidden) {
    viewer.hidden = false;
    document.body.style.overflow = 'hidden';
    await new Promise((listo) => requestAnimationFrame(listo));
  }

  // The content is awaited, so it can be searched as soon as it opens.
  await ({
    image: showImage,
    pdf: showPdf,
    text: showText,
    word: showWord,
    other: showOther,
  })[family](d);
}

function showImage(d) {
  toggleCropMode(false);
  closeEntry();
  void loadCrops(d.id);

  fuenteOriginal = `/file/${d.id}`;
  visorImg.src = fuenteOriginal;
  visorImg.alt = d.person ?? d.name;
  // An archive scan is around 2000 px wide: at 100 % it would overflow the
  // window and the document would open showing a corner. Only the first load
  // is fitted: binarising changes the src, and refitting then would lose
  // whatever zoom the user had chosen.
  visorImg.onload = () => {
    visorImg.onload = null;
    fitToWindow();
  };
  applyZoom();
}

/** Identifier of the load in progress, to discard the ones abandoned. */
let currentLoad = 0;

/**
 * State of the PDF viewer. A null `scale` means 'fitted to width', which is
 * how it opens; a number is a zoom level chosen by the user.
 */
const pdfEstado = { documento: null, escala: null, paginasHechas: 0, observador: null };

async function showPdf(d) {
  const sheets = document.getElementById('pdf-sheets');
  const counter = document.getElementById('pdf-pages');
  const mine = ++currentLoad;

  sheets.innerHTML = '<p class="pdf-loading">Opening the document…</p>';
  counter.hidden = true;
  pdfEstado.documento = null;
  pdfEstado.escala = null;
  pdfEstado.observador?.disconnect();

  try {
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ url: `/file/${d.id}` }).promise;
    if (mine !== currentLoad) return; // another document was opened meanwhile

    pdfEstado.documento = pdf;
    counter.textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`;
    counter.hidden = false;

    await renderPdf(mine);
  } catch {
    if (mine !== currentLoad) return;
    sheets.innerHTML = `<p class="pdf-loading">The PDF could not be opened.
      <a href="/file/${d.id}" target="_blank" rel="noopener">Open the original</a></p>`;
  }
}

/** Renders the first pages and prepares the rest for when they come near. */
async function renderPdf(mine) {
  const pdf = pdfEstado.documento;
  if (!pdf) return;

  const sheets = document.getElementById('pdf-sheets');
  sheets.innerHTML = '';
  pdfEstado.observador?.disconnect();

  // The first are rendered and the rest as scrolling approaches them: a
  // forty-folio file would take too long all at once.
  const primeras = Math.min(pdf.numPages, 3);
  for (let n = 1; n <= primeras; n++) {
    if (mine !== currentLoad) return;
    sheets.appendChild(await drawPage(pdf, n));
  }
  pdfEstado.paginasHechas = primeras;

  if (pdf.numPages > primeras) prepareRestOfPdf(pdf, primeras, mine, sheets);
  refreshPdfZoom();
}

/** Scale at which it is drawn: the chosen one, or the one that fits the width. */
function pdfScale(base) {
  if (pdfEstado.escala !== null) return pdfEstado.escala;

  // The panel may still be unmeasured when the first page is rendered, and a
  // width of zero would produce tiny pages. In that case it is estimated from
  // the window, discounting the side record panel.
  const medido = document.getElementById('viewer-pdf').clientWidth;
  const wide = medido > 100 ? medido : Math.max(320, window.innerWidth - 380);

  const disponible = Math.min(900, wide - 48);
  return Math.max(0.2, disponible / base.width);
}

/** Renders a PDF page onto a canvas at screen resolution. */
async function drawPage(pdf, formatNumber) {
  const page = await pdf.getPage(formatNumber);
  const base = page.getViewport({ scale: 1 });

  // The scale is multiplied by the screen density so the text does not come
  // out blurry on high-resolution monitors.
  const escala = pdfScale(base);
  const densidad = Math.min(2, window.devicePixelRatio || 1);
  const vista = page.getViewport({ scale: escala * densidad });

  const canvas = document.createElement('canvas');
  canvas.width = vista.width;
  canvas.height = vista.height;
  canvas.style.width = `${vista.width / densidad}px`;

  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vista }).promise;

  const hoja = document.createElement('div');
  hoja.className = 'pdf-sheet';
  hoja.appendChild(canvas);
  if (pdf.numPages > 1) {
    const tag = document.createElement('span');
    tag.className = 'pdf-formatNumber';
    tag.textContent = `${formatNumber} / ${pdf.numPages}`;
    hoja.appendChild(tag);
  }
  return hoja;
}

/** Changes the magnification and redraws what is on screen. */
async function zoomPdf(action) {
  const pdf = pdfEstado.documento;
  if (!pdf) return;

  if (action === 'wide') {
    pdfEstado.escala = null;
  } else {
    // On touching the zoom for the first time, the current on-screen scale
    // is the starting point, not 1: otherwise the first press would jump.
    if (pdfEstado.escala === null) {
      const base = (await pdf.getPage(1)).getViewport({ scale: 1 });
      pdfEstado.escala = pdfScale(base);
    }
    const factor = action === 'mas' ? 1.25 : 1 / 1.25;
    pdfEstado.escala = Math.max(0.2, Math.min(5, pdfEstado.escala * factor));
  }

  await renderPdf(currentLoad);
  document.getElementById('viewer-pdf').scrollTop = 0;

  // Search marks are positioned in pixels over the pages: redrawing at
  // another scale means recalculating them.
  if (docFinder.term && docFinder.family === 'pdf') {
    const guardado = docFinder.current;
    await findInDocument(docFinder.term);
    if (guardado >= 0 && docFinder.marks.length > 0) goToMatch(guardado);
  }
}

function refreshPdfZoom() {
  const salida = document.getElementById('pdf-zoom');
  salida.textContent =
    pdfEstado.escala === null ? 'Fitted' : `${Math.round(pdfEstado.escala * 100)} %`;
}

/** Renders the remaining pages as the user scrolls towards them. */
function prepareRestOfPdf(pdf, done, mine, sheets) {
  let siguiente = done + 1;
  let ocupado = false;

  const centinela = document.createElement('div');
  centinela.style.height = '1px';
  sheets.appendChild(centinela);

  const observador = new IntersectionObserver(async (entradas) => {
    if (!entradas[0].isIntersecting || ocupado) return;
    if (mine !== currentLoad) return observador.disconnect();

    ocupado = true;
    const hasta = Math.min(pdf.numPages, siguiente + 2);
    for (; siguiente <= hasta; siguiente++) {
      if (mine !== currentLoad) return observador.disconnect();
      sheets.insertBefore(await drawPage(pdf, siguiente), centinela);
    }
    pdfEstado.paginasHechas = siguiente - 1;
    ocupado = false;

    if (siguiente > pdf.numPages) {
      observador.disconnect();
      centinela.remove();
    }
  });
  observador.observe(centinela);
  pdfEstado.observador = observador;
}

/**
 * Shows a .docx converted to HTML. The server does the conversion and
 * sanitises the result; here it is merely inserted, with a warning if Mammoth
 * could not translate part of the original document.
 */
async function showWord(d) {
  const body = document.getElementById('word-body');
  const panel = document.getElementById('viewer-word');
  const mine = ++currentLoad;

  body.innerHTML = '<p class="pdf-loading">Converting the document…</p>';
  panel.querySelector('.word-warning')?.remove();

  try {
    const r = await fetchJson(`/api/docx/${d.id}`);
    if (mine !== currentLoad) return;

    body.innerHTML = r.html || '<p>The document is empty.</p>';

    if (r.warnings?.length) {
      const notice = document.createElement('p');
      notice.className = 'word-warning';
      notice.textContent = `Some details of the original formatting could not be reproduced (${r.warnings.length}).`;
      panel.appendChild(notice);
    }
  } catch {
    if (mine !== currentLoad) return;
    body.innerHTML = `<p>The document could not be converted.
      <a href="/file/${d.id}" target="_blank" rel="noopener">Open the original</a></p>`;
  }
}

/** PDF.js is loaded only the first time it is needed. */
let pdfjsCargado = null;
function loadPdfJs() {
  pdfjsCargado ??= import('/vendor/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    return m;
  });
  return pdfjsCargado;
}

async function showText(d) {
  const body = document.getElementById('text-body');
  const panel = document.getElementById('viewer-text');
  const mine = ++currentLoad;

  body.textContent = 'Loading…';
  panel.querySelector('.truncated-text')?.remove();

  try {
    const r = await fetchJson(`/api/text/${d.id}`);
    if (mine !== currentLoad) return;

    body.textContent = r.text;
    if (r.truncated) {
      const notice = document.createElement('p');
      notice.className = 'truncated-text';
      notice.textContent = 'The file is very long: only the beginning is shown.';
      panel.appendChild(notice);
    }
  } catch {
    if (mine !== currentLoad) return;
    body.textContent = 'The file could not be read.';
  }
}

function showOther(d) {
  const ext = (d.extension ?? '').replace('.', '').toUpperCase();
  document.getElementById('other-icon').textContent = ext || 'DOC';
  document.getElementById('other-name').textContent = d.name;
  document.getElementById('other-link').href = `/file/${d.id}`;
}

/* ---------- Search inside the open document ---------- */

/**
 * State of the in-document finder. `marks` are the highlighted elements in
 * the order they appear, and `current` which of them is selected.
 */
const docFinder = { term: '', marks: [], current: -1, family: null };

const panelBuscador = document.getElementById('doc-finder');
const campoBuscador = document.getElementById('df-term');
const cuentaBuscador = document.getElementById('df-count');

function openDocFinder(term) {
  // An image has no text to search.
  if (docFinder.family === 'image' || docFinder.family === 'other') return;

  panelBuscador.hidden = false;
  if (term !== undefined) campoBuscador.value = term;
  campoBuscador.focus();
  campoBuscador.select();
  if (campoBuscador.value) void findInDocument(campoBuscador.value);
}

function closeDocFinder() {
  panelBuscador.hidden = true;
  clearHighlights();
  docFinder.term = '';
  docFinder.marks = [];
  docFinder.current = -1;
  cuentaBuscador.textContent = '';
}

function clearHighlights() {
  for (const id of ['text-body', 'word-body']) {
    const el = document.getElementById(id);
    if (el) clearMarks(el);
  }
  for (const brand of document.querySelectorAll('.pdf-mark')) brand.remove();
}

/** Searches for the term and scrolls the view to the first match. */
async function findInDocument(term) {
  docFinder.term = term;
  docFinder.marks = [];
  docFinder.current = -1;

  if (!term.trim()) {
    clearHighlights();
    cuentaBuscador.textContent = '';
    cuentaBuscador.classList.remove('no-results');
    return;
  }

  if (docFinder.family === 'text') {
    docFinder.marks = markInNodes(document.getElementById('text-body'), term);
  } else if (docFinder.family === 'word') {
    docFinder.marks = markInNodes(document.getElementById('word-body'), term);
  } else if (docFinder.family === 'pdf') {
    await findInPdf(term);
  }

  updateCount();
  if (docFinder.marks.length > 0) goToMatch(0);
}

/**
 * Searches a PDF. The pages containing the term are rendered first, because
 * the match may be on page twenty and waiting for scrolling to reach it would
 * be no use at all.
 */
async function findInPdf(term) {
  const pdf = pdfEstado.documento;
  if (!pdf) return;

  cuentaBuscador.textContent = 'buscando…';
  const pages = await pagesWithTerm(pdf, term);
  if (docFinder.term !== term) return; // the user kept typing

  if (pages.length === 0) {
    clearHighlights();
    return;
  }

  // Every page holding a match is guaranteed to be rendered.
  await ensurePages(pages);
  if (docFinder.term !== term) return;

  const sheets = [...document.querySelectorAll('.pdf-sheet')];

  for (const n of pages) {
    const hoja = sheets[n - 1];
    if (!hoja) continue;

    // The scale that matters is the one the page REALLY occupies on screen,
    // not the one it was rendered at: the container's maximum width may have
    // shrunk it, and a mark computed from the other ends up misplaced.
    const canvas = hoja.querySelector('canvas');
    if (!canvas) continue;
    const base = (await pdf.getPage(n)).getViewport({ scale: 1 });
    const escalaReal = canvas.getBoundingClientRect().width / base.width;

    const marks = await markOnPage(pdf, n, hoja, term, escalaReal);
    docFinder.marks.push(...marks);
  }
}

/** Renders whatever pages are missing to cover the ones requested. */
async function ensurePages(numbers) {
  const pdf = pdfEstado.documento;
  const maxima = Math.max(...numbers);
  if (pdfEstado.paginasHechas >= maxima) return;

  const sheets = document.getElementById('pdf-sheets');
  const centinela = sheets.querySelector('div[style*="height: 1px"]');

  for (let n = pdfEstado.paginasHechas + 1; n <= maxima; n++) {
    const hoja = await drawPage(pdf, n);
    if (centinela) sheets.insertBefore(hoja, centinela);
    else sheets.appendChild(hoja);
  }
  pdfEstado.paginasHechas = maxima;
}

function updateCount() {
  const n = docFinder.marks.length;
  cuentaBuscador.classList.toggle('no-results', n === 0);
  if (n === 0) {
    cuentaBuscador.textContent = docFinder.term ? 'no results' : '';
  } else {
    cuentaBuscador.textContent = `${docFinder.current + 1} of ${n}`;
  }
}

/** Selects a match and brings it into view. */
function goToMatch(idx) {
  const { marks } = docFinder;
  if (marks.length === 0) return;

  // It wraps around at the ends: that is what one expects from pressing
  // 'next' repeatedly.
  const i = ((idx % marks.length) + marks.length) % marks.length;
  docFinder.current = i;

  for (const [j, m] of marks.entries()) m.classList.toggle('active', j === i);

  // The next frame is awaited: the marks have just been inserted and the
  // browser has not yet recalculated where each one sits, so scrolling right
  // now would move nothing.
  requestAnimationFrame(() => {
    marks[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  updateCount();
}

/** Goes back to the previous document of the trail. */
function viewerBack() {
  const previous = viewerHistory.pop();
  if (previous === undefined) return;
  void openDocument(previous, -1, { goingBack: true });
}

document.getElementById('viewer-back').addEventListener('click', viewerBack);

function closeViewer() {
  viewer.hidden = true;
  visorImg.src = '';
  viewerHistory.length = 0;
  state.documentoAbierto = null;
  document.getElementById('viewer-back').hidden = true;
  currentLoad++; // discards any load in progress
  closeDocFinder();
  closeEntry();
  toggleCropMode(false);
  document.getElementById('pdf-sheets').innerHTML = '';
  document.getElementById('text-body').textContent = '';
  document.getElementById('word-body').innerHTML = '';
  document.body.style.overflow = '';

  if (review.corrigiendo !== null) void backFromCorrecting();
}

/**
 * Resumes the queue after correcting a record in the viewer.
 *
 * The server is asked again rather than inferring it from what was typed: the
 * document may have been described in an earlier session, in which case there
 * is no change to detect but the record is settled all the same.
 */
async function backFromCorrecting() {
  const documento = review.corrigiendo;
  review.corrigiendo = null;
  review.corregido = false;
  if (documento === null) return;

  await fetchQueue(true);
  // The batch has been rebuilt: if the record is gone, it was settled.
  const sigue = review.cola.findIndex((d) => d.id === documento);
  if (sigue >= 0) {
    review.idx = sigue;
  } else {
    review.done++;
    review.idx = 0;
  }
  renderReview();
}

function applyZoom() {
  const { x, y } = state.desplazado;
  const rotation = adjustments.rotation ? ` rotate(${adjustments.rotation}deg)` : '';
  const mirror = adjustments.mirror ? ' scaleX(-1)' : '';
  // The frame is transformed, not the image: that way the boxes of the
  // marked entries move and scale along with it.
  const marco = document.getElementById('image-frame') ?? visorImg;
  marco.style.transform = `translate(${x}px, ${y}px) scale(${state.zoom})${rotation}${mirror}`;
  // The mark bars travel with the image but do not scale with it: at low
  // zoom they became an illegible ten-pixel strip, and at high zoom they
  // covered the folio. The frame scale is compensated for.
  marco.style.setProperty('--counter-zoom', String(1 / state.zoom));
  visorZoom.textContent = `${Math.round(state.zoom * 100)} %`;
}

/**
 * Translates the adjustments into a browser filter string.
 *
 * Order matters: colour is corrected first (greyscale, sepia, saturation),
 * then tone (brightness, contrast) and inversion comes last, so the negative
 * acts on the already enhanced image.
 */
function applyFilters() {
  const f = [];

  if (adjustments.greyscale) f.push('grayscale(1)');
  if (adjustments.sepia > 0) f.push(`sepia(${adjustments.sepia / 100})`);
  if (adjustments.saturation !== 100) f.push(`saturate(${adjustments.saturation / 100})`);
  if (adjustments.brightness !== 100) f.push(`brightness(${adjustments.brightness / 100})`);
  if (adjustments.contrast !== 100) f.push(`contrast(${adjustments.contrast / 100})`);

  // Sharpening does not exist in CSS: it uses the SVG filter the page
  // declares. The threshold is separate, because it replaces the whole
  // image.
  if (adjustments.sharpen > 0) {
    tuneSharpenKernel(adjustments.sharpen);
    f.push('url(#f-sharpen)');
  }

  if (adjustments.negative) f.push('invert(1)');

  visorImg.style.filter = f.join(' ');
  refreshControls();
}

/* ---------- Crops: the entry within the folio ---------- */

/**
 * A folio holds five or six entries. Marking the one of interest saves having
 * to find it again every time the document is opened.
 *
 * The coordinates are stored as proportions (0..1), not pixels, so they stay
 * valid even if the zoom changes or the image is regenerated.
 */
const crops = { active: false, list: [], docId: null, carga: 0 };

function toggleCropMode(on) {
  const quiere = on ?? !crops.active;
  crops.active = quiere;

  const button = document.getElementById('viewer-crop');
  button?.setAttribute('aria-pressed', String(quiere));
  document.getElementById('image-frame')?.classList.toggle('recortando', quiere);
}

/** Fetches and draws the entries already marked in the document. */
async function loadCrops(docId) {
  crops.docId = docId;
  crops.list = [];
  // Each load carries its own number. If another document is opened while
  // the request is in flight -- or a new entry is marked -- the late response
  // is no longer valid, and applying it would wipe the freshly made mark off
  // the screen.
  const suPeticion = ++crops.carga;

  const capa = document.getElementById('crop-layer');
  if (capa) capa.innerHTML = '';

  try {
    const list = await fetchJson(`/api/entries/${docId}`);
    if (suPeticion !== crops.carga) return;
    crops.list = list;
    renderCrops();
  } catch {
    /* no crops if it fails */
  }
}

function renderCrops() {
  const capa = document.getElementById('crop-layer');
  if (!capa) return;

  capa.innerHTML = crops.list
    .filter((a) => a.crop_x !== null)
    .map(
      (a) => {
        const gente = a.people?.length ?? 0;
        // Near the top edge the bar does not fit above the box, so it is
        // drawn inside. 6 % is what it takes at the usual on-screen height of
        // a folio.
        const arriba = a.crop_y < 0.06 ? ' arriba' : '';
        // The whole rectangle opens the entry: the tag alone was a tiny
        // target, and while marking there was no sign anything was
        // clickable.
        return `
      <div class="crop${entry.id === a.id ? ' chosen' : ''}${arriba}" data-entry="${a.id}"
           style="left:${a.crop_x * 100}%; top:${a.crop_y * 100}%;
                  width:${a.crop_w * 100}%; height:${a.crop_h * 100}%">
        <button class="crop-open" data-open-entry="${a.id}"
                title="Describe this entry: record type, date and who appears in it"
                aria-label="Describe this entry"></button>
        <span class="crop-tag">
          <button class="crop-name" data-open-entry="${a.id}"
                  title="Describe this entry">
            ${esc(RECORD_TYPES[a.record_type] ?? 'Not described')}${a.folio ? ` · ${esc(a.folio)}` : ''}
            ${gente ? `<span class="crop-people" title="${gente} recorded person(s)">${gente}</span>` : ''}
          </button>
          <button class="crop-remove" data-remove-entry="${a.id}"
                  title="Remove this mark from the folio"
                  aria-label="Remove this mark">✕ Remove</button>
        </span>
      </div>`;
      },
    )
    .join('');
}

/** Draws a rectangle over the image and stores the marked entry. */
function enableCropDrawing() {
  const marco = document.getElementById('image-frame');
  const capa = document.getElementById('crop-layer');
  if (!marco || !capa) return;

  let dibujando = false;
  let inicio = { x: 0, y: 0 };
  let provisional = null;

  const proporcion = (e) => {
    const box = visorImg.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)),
    };
  };

  marco.addEventListener('pointerdown', (e) => {
    if (!crops.active || e.button !== 0) return;

    // The buttons of an existing mark -- open it, remove it -- stay its
    // own: without this they went dead while the mode was active and there
    // was no way to undo a mark. The rest of the rectangle does allow drawing
    // on top, because on a crowded folio the entries overlap.
    if (e.target.closest('.crop-open, .crop-remove, .crop-tag')) return;

    // In crop mode, dragging draws instead of moving the image.
    e.stopPropagation();
    e.preventDefault();

    dibujando = true;
    inicio = proporcion(e);
    provisional = document.createElement('div');
    provisional.className = 'crop provisional';
    capa.appendChild(provisional);
    marco.setPointerCapture(e.pointerId);
  });

  marco.addEventListener('pointermove', (e) => {
    if (!dibujando || !provisional) return;
    const ahora = proporcion(e);
    const x = Math.min(inicio.x, ahora.x);
    const y = Math.min(inicio.y, ahora.y);
    provisional.style.left = `${x * 100}%`;
    provisional.style.top = `${y * 100}%`;
    provisional.style.width = `${Math.abs(ahora.x - inicio.x) * 100}%`;
    provisional.style.height = `${Math.abs(ahora.y - inicio.y) * 100}%`;
  });

  const terminar = async (e) => {
    if (!dibujando) return;
    dibujando = false;
    if (marco.hasPointerCapture?.(e.pointerId)) marco.releasePointerCapture(e.pointerId);

    const fin = proporcion(e);
    const rect = {
      x: Math.min(inicio.x, fin.x),
      y: Math.min(inicio.y, fin.y),
      w: Math.abs(fin.x - inicio.x),
      h: Math.abs(fin.y - inicio.y),
    };
    provisional?.remove();
    provisional = null;

    // A tiny rectangle is an accidental click, not an entry.
    if (rect.w < 0.02 || rect.h < 0.01) return;

    // The entry is created empty and described in its panel: asking for
    // record type and folio in two consecutive dialogs forced every decision
    // at once, before the box just marked could even be read properly.
    try {
      const r = await fetch(`/api/entries/${crops.docId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ crop: rect }),
      });
      if (!r.ok) return;

      const nueva = await r.json();
      nueva.people = [];
      // Invalidates any load still in flight: its response predates this
      // mark and would wipe it from the list.
      crops.carga++;
      crops.list.push(nueva);

      // Drawing mode is left: what comes next is describing the entry just
      // marked, not marking another. It is re-entered with the button or the
      // M key.
      toggleCropMode(false);
      renderCrops();
      openEntry(nueva.id);
    } catch {
      /* it is retried by drawing again */
    }
  };

  marco.addEventListener('pointerup', terminar);
  marco.addEventListener('pointercancel', () => {
    dibujando = false;
    provisional?.remove();
    provisional = null;
  });
}

// Removing a mark.
document.addEventListener('click', async (e) => {
  const remove = e.target.closest('[data-remove-entry]');
  if (!remove) return;
  e.stopPropagation();

  const id = Number(remove.dataset.removeEntry);
  const a = crops.list.find((x) => x.id === id);

  // A freshly drawn mark is removed without asking: there is nothing to
  // lose. If something has already been written in it, the user is asked,
  // because a transcription cannot be recovered.
  const escrito = a && (a.abstract || a.transcription || a.notes || a.people?.length);
  if (escrito) {
    const what = [
      a.abstract && 'an abstract',
      a.transcription && 'a transcription',
      a.people?.length && `${a.people.length} recorded person(s)`,
    ].filter(Boolean);
    if (!confirm(`This entry has ${what.join(', ')}.\n\nRemove it from the folio anyway?`)) {
      return;
    }
  }

  try {
    await fetch(`/api/entry/${id}`, { method: 'DELETE' });
    crops.list = crops.list.filter((x) => x.id !== id);
    if (entry.id === id) closeEntry();
    else renderCrops();
  } catch {
    /* it is retried */
  }
});

/* ---------- The entry: what it says and who appears in it ---------- */

/**
 * The roles someone can have in an entry.
 *
 * Ordered by real frequency in a parish archive, not alphabetically: the
 * subject and their parents are written on almost every record, a celebrant
 * on very few.
 */
// The roles the profile declares, most frequent first. The values are the
// ones the API validates against; the labels are what the user reads.
const ROLES = [
  ['subject', 'Subject'],
  ['father', 'Father'],
  ['mother', 'Mother'],
  ['godfather', 'Godfather'],
  ['godmother', 'Godmother'],
  ['spouse', 'Spouse'],
  ['deceased', 'Deceased'],
  ['witness', 'Witness'],
  ['paternal_grandfather', 'Paternal grandfather'],
  ['paternal_grandmother', 'Paternal grandmother'],
  ['maternal_grandfather', 'Maternal grandfather'],
  ['maternal_grandmother', 'Maternal grandmother'],
  ['celebrant', 'Celebrant'],
  ['grantor', 'Grantor'],
  ['informant', 'Informant'],
  ['other', 'Other'],
];

const CERTAINTIES = [
  ['certain', 'Certain'],
  ['probable', 'Probable'],
  ['uncertain', 'Uncertain'],
];

const LINK_HINT =
  'If the person is in your Gramps tree, pick them from the list: that way ' +
  'they are linked. If they are not -- a godparent, a witness -- type their ' +
  'name and it is stored here only.';

/** Which entry is being described. */
const entry = { id: null };

const panelPartida = document.getElementById('entry');
const cuerpoPartida = document.getElementById('entry-body');

function closeEntry() {
  entry.id = null;
  if (panelPartida) panelPartida.hidden = true;
  viewer.classList.remove('with-entry');
  renderCrops();
}

function openEntry(id) {
  entry.id = id;
  if (!panelPartida || !cuerpoPartida) return;

  const a = crops.list.find((x) => x.id === id);
  if (!a) return;

  panelPartida.hidden = false;
  viewer.classList.add('with-entry');
  document.getElementById('entry-title').textContent =
    `Entry ${crops.list.indexOf(a) + 1} of ${crops.list.length}`;

  const field = (k, tag, value, extra = '') => `
    <label class="field">
      <span>${esc(tag)}</span>
      <input data-entry-field="${k}" value="${esc(value ?? '')}" ${extra}>
    </label>`;

  cuerpoPartida.innerHTML = `
    <p class="form-status" id="entry-state"></p>

    <form class="record-form" id="form-entry" data-entry="${a.id}">
      <label class="field">
        <span>Record type</span>
        <select data-entry-field="record_type">
          ${SELECTABLE_RECORD_TYPES.map(
            ([v, t]) => `<option value="${v}"${v === (a.record_type ?? '') ? ' selected' : ''}>${t}</option>`,
          ).join('')}
        </select>
      </label>

      <div class="field-pair">
        ${field('date', 'Date', a.date, 'placeholder="1802-05-14"')}
        ${field('folio', 'Folio', a.folio, 'placeholder="45v"')}
      </div>

      <label class="field">
        <span>Place</span>
        <input data-entry-field="place" list="places-suggested"
               value="${esc(a.place_name ?? '')}"
               placeholder="Parish or town" autocomplete="off">
        <datalist id="places-suggested"></datalist>
      </label>

      <label class="field">
        <span>Abstract</span>
        <textarea data-entry-field="abstract" rows="2">${esc(a.abstract ?? '')}</textarea>
      </label>

      <label class="field">
        <span>Transcription</span>
        <textarea data-entry-field="transcription" rows="4">${esc(a.transcription ?? '')}</textarea>
      </label>
    </form>

    <div class="entry-people">
      <h4>Who appears here</h4>
      <div id="entry-people"></div>

      <form class="link-new" id="form-link" data-entry="${a.id}">
        <input id="vin-name" list="people-suggested" placeholder="Person name"
               autocomplete="off" aria-label="Person name">
        <datalist id="people-suggested"></datalist>
        <div class="link-row">
          <select id="link-role" aria-label="Role">
            ${ROLES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
          </select>
          <select id="link-certainty" aria-label="Certainty">
            ${CERTAINTIES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
          </select>
          <button type="submit">Add</button>
        </div>
        <p class="adjustments-note" id="link-hint">${esc(LINK_HINT)}</p>
      </form>
    </div>

    <div class="entry-foot">
      <button class="minor-button peligro" data-remove-entry="${a.id}">
        Remove this entry from the folio
      </button>
    </div>`;

  renderEntryPeople();
}

function renderEntryPeople() {
  const box = document.getElementById('entry-people');
  if (!box) return;

  const a = crops.list.find((x) => x.id === entry.id);
  const gente = a?.people ?? [];

  if (!gente.length) {
    box.innerHTML = '<p class="br-empty">You have not recorded anyone yet.</p>';
    return;
  }

  box.innerHTML = gente
    .map(
      (v) => `
      <div class="link${v.certainty !== 'certain' ? ` certainty-${esc(v.certainty)}` : ''}"
           data-link="${v.id}">
        <div class="link-who">
          <strong>${esc(v.name)}</strong>
          ${v.gramps_id ? `<span class="link-gramps" title="In your tree">${esc(v.gramps_id)}</span>` : ''}
        </div>
        <div class="link-row">
          <select data-link-field="role" aria-label="Role of ${esc(v.name)}">
            ${ROLES.map(
              ([val, t]) => `<option value="${val}"${val === v.role ? ' selected' : ''}>${t}</option>`,
            ).join('')}
          </select>
          <select data-link-field="certainty" aria-label="Certainty">
            ${CERTAINTIES.map(
              ([val, t]) => `<option value="${val}"${val === v.certainty ? ' selected' : ''}>${t}</option>`,
            ).join('')}
          </select>
          <button class="link-remove" data-remove-link="${v.id}" title="Remove">✕</button>
        </div>
      </div>`,
    )
    .join('');
}

/** Saves an entry field shortly after typing stops. */
const guardadoPartida = new Map();

function saveEntryField(id, field, value) {
  clearTimeout(guardadoPartida.get(field));
  guardadoPartida.set(
    field,
    setTimeout(async () => {
      const notice = document.getElementById('entry-state');
      try {
        const r = await fetch(`/api/entry/${id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? 'not saved');

        // The in-memory list takes precedence over what is drawn over the folio.
        const a = crops.list.find((x) => x.id === id);
        if (a) {
          Object.assign(a, d);
          renderCrops();
        }

        if (notice) {
          notice.textContent = 'Saved';
          notice.className = 'form-status ok';
          setTimeout(() => {
            if (notice.isConnected && notice.textContent === 'Saved') notice.textContent = '';
          }, 1800);
        }
      } catch (e) {
        if (notice) {
          notice.textContent = e.message;
          notice.className = 'form-status error';
        }
      }
    }, 600),
  );
}

/**
 * Person suggestions while typing.
 *
 * Both the Gramps tree and the people already recorded here are asked: the
 * tree is the authoritative source, but witnesses and godparents exist only
 * in the archive and must not be lost sight of.
 */
const grampsPorNombre = new Map();

async function suggestPeople(text) {
  const list = document.getElementById('people-suggested');
  if (!list || text.trim().length < 2) return;

  try {
    const [delArbol, deAqui] = await Promise.all([
      fetchJson(`/api/gramps/people?q=${encodeURIComponent(text)}`).catch(() => []),
      fetchJson(`/api/people?q=${encodeURIComponent(text)}`).catch(() => []),
    ]);

    grampsPorNombre.clear();
    const vistos = new Set();
    const options = [];

    for (const p of delArbol) {
      const name = [p.name, p.surname].filter(Boolean).join(' ').trim();
      if (!name || vistos.has(name)) continue;
      vistos.add(name);
      grampsPorNombre.set(name, p.gramps_id);
      options.push(`<option value="${esc(name)}">In your tree - ${esc(p.gramps_id)}</option>`);
    }

    for (const p of deAqui) {
      if (vistos.has(p.name)) continue;
      vistos.add(p.name);
      if (p.gramps_id) grampsPorNombre.set(p.name, p.gramps_id);
      options.push(
        `<option value="${esc(p.name)}">${p.uses ? `${p.uses} entry(s)` : 'Already recorded'}</option>`,
      );
    }

    list.innerHTML = options.join('');
  } catch {
    /* without matches you can still type */
  }
}

/** Suggestions of places already used, to avoid ending up with twenty spellings. */
async function suggestPlaces(text) {
  const list = document.getElementById('places-suggested');
  if (!list || text.trim().length < 2) return;

  try {
    const lugares = await fetchJson(`/api/places?q=${encodeURIComponent(text)}`);
    list.innerHTML = lugares
      .map(
        (l) =>
          `<option value="${esc(l.name)}">${
            l.uses ? `${l.uses} entry(s)` : ''
          }${l.province ? ` · ${esc(l.province)}` : ''}</option>`,
      )
      .join('');
  } catch {
    /* without matches you can still type */
  }
}

// Open the panel of an entry already marked.
document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open-entry]');
  if (open) {
    e.stopPropagation();
    openEntry(Number(open.dataset.openEntry));
    return;
  }
  if (e.target.closest('#entry-close')) closeEntry();
});

// Entry fields: they save themselves.
document.addEventListener('input', (e) => {
  const field = e.target.closest('[data-entry-field]');
  const form = field?.closest('#form-entry');
  if (form) {
    if (field.dataset.entryField === 'place') void suggestPlaces(field.value);
    saveEntryField(Number(form.dataset.entry), field.dataset.entryField, field.value);
    return;
  }

  if (e.target.id === 'vin-name') void suggestPeople(e.target.value);
});

document.addEventListener('change', (e) => {
  const field = e.target.closest('select[data-entry-field]');
  const form = field?.closest('#form-entry');
  if (form) {
    saveEntryField(Number(form.dataset.entry), field.dataset.entryField, field.value);
  }
});

// Adding a person to the entry.
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('#form-link');
  if (!form) return;
  e.preventDefault();

  const entrada = document.getElementById('vin-name');
  const name = entrada.value.trim();
  const pista = document.getElementById('link-hint');
  if (!name) return;

  try {
    const r = await fetch(`/api/entry/${form.dataset.entry}/people`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        gramps_id: grampsPorNombre.get(name) ?? null,
        rol: document.getElementById('link-role').value,
        certainty: document.getElementById('link-certainty').value,
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'could not be added');

    const a = crops.list.find((x) => x.id === entry.id);
    if (a) {
      a.people = (a.people ?? []).filter((v) => v.id !== d.id);
      a.people.push(d);
    }

    entrada.value = '';
    renderEntryPeople();
    renderCrops();

    if (pista) {
      // If matching recognised someone already recorded under a different
      // spelling, it is said out loud: seeing a name on screen other than the
      // one typed, with no explanation, looks like a bug.
      if (d.matched_from) {
        pista.textContent =
          `"${d.matched_from}" was merged into "${d.name}", which was already in your archive. ` +
          'The document spelling is kept as a variant.';
        pista.className = 'form-status';
      } else {
        pista.textContent = LINK_HINT;
        pista.className = 'adjustments-note';
      }
    }
  } catch (err) {
    if (pista) {
      pista.textContent = err.message;
      pista.className = 'form-status error';
    }
  }
});

// Change the role or certainty of someone already noted.
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-link-field]');
  if (!sel) return;

  const fila = sel.closest('[data-link]');
  const id = Number(fila.dataset.link);

  try {
    const r = await fetch(`/api/link/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [sel.dataset.linkField]: sel.value }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'not saved');

    const a = crops.list.find((x) => x.id === entry.id);
    const v = a?.people?.find((x) => x.id === id);
    if (v) Object.assign(v, d);
    renderEntryPeople();
  } catch {
    // The control is reverted to what it held: leaving an unsaved value on
    // screen would suggest it had been saved.
    renderEntryPeople();
  }
});

// Removing someone from the entry.
document.addEventListener('click', async (e) => {
  const remove = e.target.closest('[data-remove-link]');
  if (!remove) return;

  const id = Number(remove.dataset.removeLink);
  try {
    await fetch(`/api/link/${id}`, { method: 'DELETE' });
    const a = crops.list.find((x) => x.id === entry.id);
    if (a) a.people = (a.people ?? []).filter((v) => v.id !== id);
    renderEntryPeople();
    renderCrops();
  } catch {
    /* it is retried */
  }
});

/* ---------- Umbral adaptativo ---------- */

// The original image, to be able to return to it when the threshold is switched off.
let fuenteOriginal = null;
let temporizadorUmbral = null;

/**
 * Binarises the image with a cut computed area by area. Unlike a global
 * threshold, it works on archive photographs with half the page in shadow,
 * where no single cut serves the whole folio.
 *
 * It is pixel computation, so the slider is allowed to settle before it
 * runs.
 */
function scheduleThreshold() {
  clearTimeout(temporizadorUmbral);
  temporizadorUmbral = setTimeout(applyThreshold, 180);
}

async function applyThreshold() {
  if (!fuenteOriginal) return;

  const salida = document.getElementById('v-threshold');

  if (adjustments.threshold === 0) {
    if (visorImg.src !== fuenteOriginal) visorImg.src = fuenteOriginal;
    return;
  }

  // The slider moves k: low keeps the faintest strokes (and some paper
  // noise), high keeps only the most definite ink.
  const k = 0.06 + (1 - adjustments.threshold / 100) * 0.42;

  // Computing over two million pixels takes a couple of seconds: better to
  // say so than to leave the image sitting still with no explanation.
  if (salida) salida.textContent = 'calculando…';

  const base = new Image();
  base.decoding = 'async';
  base.src = fuenteOriginal;
  try {
    await base.decode();
    visorImg.src = binarizeImage(base, { k });
  } catch {
    // If the image cannot be processed (unsupported format, memory), the
    // original is kept: the viewer remains usable.
    visorImg.src = fuenteOriginal;
  } finally {
    refreshControls();
  }
}

/**
 * Convolution kernel for sharpening strokes. It is the classic edge
 * enhancement: the centre adds and the neighbours subtract, so a stroke of
 * ink on paper gains definition against the background.
 */
function tuneSharpenKernel(strength) {
  const k = (strength / 100) * 1.6;
  const centro = 1 + 4 * k;
  document
    .getElementById('m-sharpen')
    .setAttribute('kernelMatrix', `0 ${-k} 0  ${-k} ${centro} ${-k}  0 ${-k} 0`);
}

/** Sets the panel controls to match the adjustments in force. */
function refreshControls() {
  const n = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = String(v);
  };
  const t = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  const p = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('aria-pressed', String(v));
  };

  n('c-contrast', adjustments.contrast);
  n('c-brightness', adjustments.brightness);
  n('c-saturation', adjustments.saturation);
  n('c-sepia', adjustments.sepia);
  n('c-sharpen', adjustments.sharpen);
  n('c-threshold', adjustments.threshold);

  t('v-contrast', `${adjustments.contrast} %`);
  t('v-brightness', `${adjustments.brightness} %`);
  t('v-saturation', `${adjustments.saturation} %`);
  t('v-sepia', `${adjustments.sepia} %`);
  t('v-sharpen', adjustments.sharpen === 0 ? 'none' : String(adjustments.sharpen));
  t(
    'v-threshold',
    adjustments.threshold === 0
      ? 'off'
      : adjustments.threshold < 35
        ? 'soft'
        : adjustments.threshold < 70
          ? 'balanced'
          : 'aggressive',
  );

  p('b-negative', adjustments.negative);
  p('b-greyscale', adjustments.greyscale);
  p('b-mirror', adjustments.mirror);

  // The 'Reading' button stays pressed while that combination lasts.
  const enLectura = adjustments.negative && adjustments.contrast >= 150 && adjustments.greyscale;
  document.getElementById('viewer-lens').setAttribute('aria-pressed', String(enLectura));
}

function resetAdjustments() {
  adjustments = { ...DEFAULT_ADJUSTMENTS };
  applyFilters();
  applyZoom();
  // Returns the image unbinarised if the threshold was on.
  if (fuenteOriginal && visorImg.src !== fuenteOriginal) visorImg.src = fuenteOriginal;
}

/**
 * The combination that most often rescues illegible ink: greyscale to remove
 * the paper colour, high contrast and negative. Light ink on a dark
 * background reads better than the other way round.
 */
function readingMode() {
  const yaEstaba = adjustments.negative && adjustments.contrast >= 150 && adjustments.greyscale;
  if (yaEstaba) {
    adjustments.negative = false;
    adjustments.greyscale = false;
    adjustments.contrast = 100;
  } else {
    adjustments.negative = true;
    adjustments.greyscale = true;
    adjustments.contrast = 175;
  }
  applyFilters();
}

/** Fits the whole image into the available space. */
function fitToWindow() {
  const canvas = document.getElementById('viewer-canvas');
  const anchoNat = visorImg.naturalWidth;
  const altoNat = visorImg.naturalHeight;
  if (!anchoNat || !altoNat) return;

  // With the image rotated a quarter turn, height and width swap roles.
  const girada = adjustments.rotation % 180 !== 0;
  const anchoVisible = girada ? altoNat : anchoNat;
  const altoVisible = girada ? anchoNat : altoNat;

  const margen = 32;
  const escala = Math.min(
    (canvas.clientWidth - margen) / anchoVisible,
    (canvas.clientHeight - margen) / altoVisible,
  );
  // It never enlarges beyond the original size: blowing up a scan adds no
  // detail, it only blurs it.
  state.zoom = Math.min(1, escala);
  state.desplazado = { x: 0, y: 0 };
  visorImg.style.width = `${anchoNat}px`;
  visorImg.style.height = 'auto';
  applyZoom();
}

/**
 * Zooms in or out keeping the point under the cursor fixed, which is the
 * behaviour one expects when examining a particular area of a folio.
 */
function zoomAtPoint(factor, clientX, clientY) {
  const canvas = document.getElementById('viewer-canvas');
  const box = canvas.getBoundingClientRect();
  const centroX = box.left + box.width / 2;
  const centroY = box.top + box.height / 2;

  // Cursor position relative to the image centre, before scaling.
  const relX = clientX - centroX - state.desplazado.x;
  const relY = clientY - centroY - state.desplazado.y;

  const previous = state.zoom;
  state.zoom = Math.max(0.05, Math.min(8, state.zoom * factor));
  const cambio = state.zoom / previous;

  // The offset is corrected so that same point stays under the cursor.
  state.desplazado.x -= relX * (cambio - 1);
  state.desplazado.y -= relY * (cambio - 1);
  applyZoom();
}

/** Mouse dragging to move around the enlarged image. */
function enableDrag() {
  const canvas = document.getElementById('viewer-canvas');
  let arrastrando = false;
  let desde = { x: 0, y: 0 };
  let inicial = { x: 0, y: 0 };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // In crop mode dragging draws the rectangle, it does not pan the image.
    if (crops.active) return;

    // Over a mark the pointer belongs to it. The canvas captures the
    // pointer in order to pan the image, and that capture swallowed the
    // click: pressing a marked entry opened nothing.
    if (e.target.closest('.crop')) return;

    arrastrando = true;
    desde = { x: e.clientX, y: e.clientY };
    inicial = { ...state.desplazado };
    canvas.classList.add('arrastrando');
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!arrastrando) return;
    state.desplazado = {
      x: inicial.x + (e.clientX - desde.x),
      y: inicial.y + (e.clientY - desde.y),
    };
    applyZoom();
  });

  const soltar = (e) => {
    if (!arrastrando) return;
    arrastrando = false;
    canvas.classList.remove('arrastrando');
    if (e.pointerId !== undefined && canvas.hasPointerCapture?.(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', soltar);
  canvas.addEventListener('pointercancel', soltar);

  // Double click: toggles between the whole folio and the original size.
  canvas.addEventListener('dblclick', (e) => {
    if (state.zoom < 1) {
      zoomAtPoint(1 / state.zoom, e.clientX, e.clientY);
    } else {
      fitToWindow();
    }
  });
}

/**
 * Dragging in the PDF viewer.
 *
 * Here it is not a transform that moves as with the image, but the
 * container's scroll: the pages are real stacked elements and the natural
 * thing is to move through them like a list.
 */
function enablePdfDrag() {
  const panel = document.getElementById('viewer-pdf');
  let arrastrando = false;
  let desde = { x: 0, y: 0 };
  let inicial = { x: 0, y: 0 };
  let movido = 0;

  panel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    arrastrando = true;
    movido = 0;
    desde = { x: e.clientX, y: e.clientY };
    inicial = { x: panel.scrollLeft, y: panel.scrollTop };
    panel.classList.add('arrastrando');
    panel.setPointerCapture(e.pointerId);
  });

  panel.addEventListener('pointermove', (e) => {
    if (!arrastrando) return;
    const dx = e.clientX - desde.x;
    const dy = e.clientY - desde.y;
    movido = Math.max(movido, Math.abs(dx) + Math.abs(dy));
    panel.scrollLeft = inicial.x - dx;
    panel.scrollTop = inicial.y - dy;
  });

  const soltar = (e) => {
    if (!arrastrando) return;
    arrastrando = false;
    panel.classList.remove('arrastrando');
    if (e.pointerId !== undefined && panel.hasPointerCapture?.(e.pointerId)) {
      panel.releasePointerCapture(e.pointerId);
    }
  };
  panel.addEventListener('pointerup', soltar);
  panel.addEventListener('pointercancel', soltar);

  // A drag must not count as a click: otherwise it would select text
  // unintentionally on release.
  panel.addEventListener(
    'click',
    (e) => {
      if (movido > 6) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}

function moveInList(step) {
  const i = state.indiceAbierto + step;
  if (i < 0 || i >= state.results.length) return;
  openDocument(state.results[i].id, i);
}

/* ---------- Navigation ---------- */

function goTo(section) {
  state.section = section;
  state.page = 1;
  for (const b of document.querySelectorAll('.sections button')) {
    b.classList.toggle('active', b.dataset.go === section);
  }
  ({
    home: showHome,
    search: showSearch,
    classification: showClassification,
    review: showReview,
    people: showMatches,
    gaps: showGaps,
    duplicates: showDuplicates,
  })[section]?.().catch((e) => {
    main.innerHTML = `<p>Could not load: ${esc(e.message)}</p>`;
  });
}

document.getElementById('form-search').addEventListener('submit', (e) => {
  e.preventDefault();
  state.query = document.getElementById('q').value.trim();
  state.type = null;
  state.unit = null;
  state.unitTitle = '';
  state.page = 1;
  goTo('search');
});

document.addEventListener('click', (e) => {
  const goEl = e.target.closest('[data-go]');
  if (goEl) {
    e.preventDefault();
    goTo(goEl.dataset.go);
    return;
  }

  const byType = e.target.closest('[data-search-type]');
  if (byType) {
    state.type = byType.dataset.searchType;
    state.format = null;
    state.query = '';
    state.unit = null;
    state.unitTitle = '';
    document.getElementById('q').value = '';
    goTo('search');
    return;
  }

  const byFormat = e.target.closest('[data-search-format]');
  if (byFormat) {
    state.format = byFormat.dataset.searchFormat;
    state.type = null;
    state.query = '';
    state.unit = null;
    state.unitTitle = '';
    document.getElementById('q').value = '';
    goTo('search');
    return;
  }

  const doc = e.target.closest('[data-doc]');
  if (doc) {
    openDocument(Number(doc.dataset.doc), doc.dataset.i ? Number(doc.dataset.i) : -1);
    return;
  }

  const pageBtn = e.target.closest('[data-page]');
  if (pageBtn && !pageBtn.disabled) {
    state.page = Number(pageBtn.dataset.page);
    showSearch();
    main.scrollTo({ top: 0 });
    return;
  }

  if (e.target.id === 'btn-sweep') {
    e.target.disabled = true;
    e.target.textContent = 'Searching…';
    fetch('/api/watch/sweep', { method: 'POST' })
      .then(() => watchState())
      .catch(() => {});
    return;
  }

});

/* ---------- Clicks inside the browser ---------- */

document.getElementById('collapse-panel').addEventListener('click', toggleBrowser);
document.getElementById('expand-panel').addEventListener('click', toggleBrowser);
document.getElementById('mobile-panel').addEventListener('click', toggleBrowser);

for (const tab of document.querySelectorAll('.br-tabs button')) {
  tab.addEventListener('click', () => {
    arbolActivo = tab.dataset.tree;
    writePreference('regesta.tree', arbolActivo);
    void renderBrowser();
  });
}

brBody.addEventListener('click', (e) => {
  // The arrow opens and closes the branch without changing the search.
  const arrow = e.target.closest('.arrow');
  if (arrow && !arrow.classList.contains('hollow')) {
    const key = arrow.closest('[data-key]')?.dataset.key;
    if (key && toggleBranch(key)) {
      e.stopPropagation();
      return;
    }
  }

  const folder = e.target.closest('[data-unit-exp]');
  if (folder) {
    clearFilters();
    state.unit = folder.dataset.unitExp;
    state.unitTitle = folder.dataset.title ?? '';
    goTo('search');
    void renderBrowser();
    return;
  }

  const recordType = e.target.closest('[data-record-exp]');
  if (recordType) {
    clearFilters();
    state.type = recordType.dataset.recordExp;
    state.century = recordType.dataset.century ?? null;
    state.unitTitle = recordType.dataset.title ?? '';
    goTo('search');
    void renderBrowser();
    return;
  }

  // Deleting a tag: confirmed because it affects every document carrying
  // it, although the documents themselves are untouched.
  const remove = e.target.closest('[data-remove-tag]');
  if (remove) {
    e.stopPropagation();
    const name = remove.dataset.name;
    const count = Number(remove.dataset.count ?? 0);
    const notice =
      count > 0
        ? `Delete the tag "${name}"?\n\nIt will be removed from ${count} ${
            count === 1 ? 'document' : 'documents'
          }. The documents are not deleted.`
        : `Delete the tag "${name}"?`;
    if (!confirm(notice)) return;

    void (async () => {
      try {
        await fetch(`/api/tags/${remove.dataset.removeTag}`, { method: 'DELETE' });
        // If it was being filtered by it, return to the full view.
        if (String(state.tag) === remove.dataset.removeTag) {
          clearFilters();
          goTo('search');
        }
        await renderBrowser();
      } catch {
        /* offline: retried whenever the user wants */
      }
    })();
    return;
  }

  const tag = e.target.closest('[data-tag-exp]');
  if (tag) {
    clearFilters();
    state.tag = tag.dataset.tagExp;
    state.unitTitle = tag.dataset.title ?? '';
    goTo('search');
    void renderBrowser();
  }
});

// Create a new tag.
brBody.addEventListener('submit', async (e) => {
  if (e.target.id !== 'form-tag') return;
  e.preventDefault();

  const field = document.getElementById('new-tag');
  const name = field.value.trim();
  if (!name) return;

  try {
    const r = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) {
      const { error } = await r.json();
      field.setCustomValidity(error ?? 'Could not create it');
      field.reportValidity();
      setTimeout(() => field.setCustomValidity(''), 2500);
      return;
    }
    field.value = '';
    await renderBrowser();
  } catch {
    /* offline: retried whenever the user wants */
  }
});

/**
 * Browser width, adjustable by dragging the handle.
 *
 * Archive folder names tend to be long, so being able to widen the panel
 * saves having to read them in pieces.
 */
const ANCHO_MIN = 180;
const ANCHO_MAX = 560;

function setPanelWidth(px) {
  const wide = Math.max(ANCHO_MIN, Math.min(ANCHO_MAX, Math.round(px)));
  document.getElementById('body').style.setProperty('--panel-width', `${wide}px`);
  writePreference('regesta.panelWidth', wide);
  return wide;
}

function enableHandle() {
  const tirador = document.getElementById('handle');
  const body = document.getElementById('body');
  let arrastrando = false;

  tirador.addEventListener('pointerdown', (e) => {
    arrastrando = true;
    tirador.classList.add('arrastrando');
    tirador.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  tirador.addEventListener('pointermove', (e) => {
    if (!arrastrando) return;
    setPanelWidth(e.clientX - body.getBoundingClientRect().left);
  });

  const soltar = (e) => {
    if (!arrastrando) return;
    arrastrando = false;
    tirador.classList.remove('arrastrando');
    if (e.pointerId !== undefined && tirador.hasPointerCapture?.(e.pointerId)) {
      tirador.releasePointerCapture(e.pointerId);
    }
  };
  tirador.addEventListener('pointerup', soltar);
  tirador.addEventListener('pointercancel', soltar);

  // With the keyboard too, for those who do not use a mouse.
  tirador.addEventListener('keydown', (e) => {
    const current = Number.parseInt(
      getComputedStyle(body).getPropertyValue('--panel-width'),
      10,
    ) || 268;
    if (e.key === 'ArrowLeft') setPanelWidth(current - 20);
    else if (e.key === 'ArrowRight') setPanelWidth(current + 20);
    else return;
    e.preventDefault();
  });

  // Double click: back to the default width.
  tirador.addEventListener('dblclick', () => setPanelWidth(268));
}

/** Width of the viewer's side sheet, adjustable from its left edge. */
function setSheetWidth(px) {
  const max = Math.max(260, Math.min(760, window.innerWidth - 360));
  const width = Math.max(240, Math.min(max, Math.round(px)));
  document.getElementById('viewer').style.setProperty('--sheet-width', `${width}px`);
  writePreference('regesta.sheetWidth', width);
  return width;
}

function enableSheetHandle() {
  const handle = document.getElementById('viewer-handle');
  const viewerEl = document.getElementById('viewer');
  let dragging = false;

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.classList.add('arrastrando');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (dragging) setSheetWidth(window.innerWidth - e.clientX);
  });
  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('arrastrando');
    if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    // The canvas has changed size: the document refits into the space left.
    if (viewerEl.classList.contains('es-imagen')) fitToWindow();
    else if (viewerEl.classList.contains('es-pdf') && pdfEstado.escala === null) void zoomPdf('wide');
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);

  handle.addEventListener('keydown', (e) => {
    const current = Number.parseInt(getComputedStyle(viewerEl).getPropertyValue('--sheet-width'), 10) || 330;
    if (e.key === 'ArrowLeft') setSheetWidth(current + 20);
    else if (e.key === 'ArrowRight') setSheetWidth(current - 20);
    else return;
    e.preventDefault();
  });
  handle.addEventListener('dblclick', () => setSheetWidth(330));
}

function toggleBrowser() {
  const body = document.getElementById('body');
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  if (narrow) body.classList.toggle('with-mobile-panel');
  else {
    body.classList.toggle('no-panel');
    writePreference('regesta.panel', body.classList.contains('no-panel') ? '0' : '1');
  }
}


/**
 * Orients the preview according to the space above the card.
 * The number of columns depends on the window width, so it cannot be decided
 * in CSS: one has to look at where each card landed.
 */
document.addEventListener(
  'pointerover',
  (e) => {
    const doc = e.target.closest?.('.doc');
    if (!doc) return;
    const box = doc.getBoundingClientRect();
    // 210 px is what the tallest preview takes with its margin.
    doc.classList.toggle('previa-abajo', box.top < 210);

    // The preview is 290 px wide and centred: if its 145 px do not fit on one
    // side, it aligns with the edge of the card.
    // The left edge is that of the main area, not of the window: the side
    // panel sits on top and would cover the preview.
    const centro = box.left + box.width / 2;
    const leftLimit = main?.getBoundingClientRect().left ?? 0;
    doc.classList.toggle('previa-izq', centro - leftLimit < 160);
    doc.classList.toggle('previa-der', centro > window.innerWidth - 160);

    const slot = doc.querySelector('[data-preview]');
    if (slot) loadPreview(slot);
  },
  { passive: true },
);

/**
 * Generates PDF thumbnails as they appear on screen. They are not all made
 * at once: there are hundreds and each one means downloading and drawing the
 * document.
 */
const vigilanteMiniaturas = new IntersectionObserver(
  (entradas) => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue;
      vigilanteMiniaturas.unobserve(e.target);
      queuePdfThumbnail(Number(e.target.dataset.miniPdf), e.target);
    }
  },
  { rootMargin: '200px' },
);

/** Puts the PDFs of the freshly painted grid under observation. */
function watchPdfThumbnails() {
  for (const slot of document.querySelectorAll('[data-mini-pdf]')) {
    vigilanteMiniaturas.observe(slot);
  }
}

// The dropdowns of the results bar.
document.addEventListener('change', (e) => {
  if (e.target.id === 'sel-per-page') {
    state.perPage = Number(e.target.value);
    writePreference('regesta.perPage', state.perPage);
  } else if (e.target.id === 'sel-formato') {
    state.format = e.target.value || null;
  } else {
    return;
  }
  state.page = 1;
  showSearch();
  main.scrollTo({ top: 0 });
});

document.getElementById('viewer-close').addEventListener('click', closeViewer);
document.getElementById('viewer-in').addEventListener('click', () => {
  state.zoom = Math.min(8, state.zoom * 1.25);
  applyZoom();
});
document.getElementById('viewer-out').addEventListener('click', () => {
  state.zoom = Math.max(0.05, state.zoom / 1.25);
  applyZoom();
});
document.getElementById('viewer-fit').addEventListener('click', fitToWindow);
document.getElementById('viewer-lens').addEventListener('click', readingMode);
document.getElementById('viewer-crop').addEventListener('click', () => toggleCropMode());
enableCropDrawing();

/* ---------- Controls of the in-document search box ---------- */

document.getElementById('viewer-find').addEventListener('click', () => {
  if (panelBuscador.hidden) openDocFinder();
  else closeDocFinder();
});
document.getElementById('df-close').addEventListener('click', closeDocFinder);
document.getElementById('df-next').addEventListener('click', () =>
  goToMatch(docFinder.current + 1),
);
document.getElementById('df-previous').addEventListener('click', () =>
  goToMatch(docFinder.current - 1),
);

// Typing is allowed to settle: in a PDF each search walks every page, and
// doing that on each keystroke would be needlessly slow.
let searchDelay = null;
campoBuscador.addEventListener('input', (e) => {
  clearTimeout(searchDelay);
  const value = e.target.value;
  searchDelay = setTimeout(() => void findInDocument(value), 250);
});

campoBuscador.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (docFinder.marks.length === 0) return;
    goToMatch(docFinder.current + (e.shiftKey ? -1 : 1));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeDocFinder();
  }
});

document.getElementById('pdf-in').addEventListener('click', () => zoomPdf('mas'));
document.getElementById('pdf-out').addEventListener('click', () => zoomPdf('menos'));
document.getElementById('pdf-width').addEventListener('click', () => zoomPdf('wide'));

/* ---------- Panel de adjustments ---------- */

const panel = document.getElementById('adjustments');
const botonPanel = document.getElementById('viewer-panel');

function togglePanel(show) {
  const visible = show ?? panel.hidden;
  panel.hidden = !visible;
  viewer.classList.toggle('with-adjustments', visible);
  botonPanel.setAttribute('aria-expanded', String(visible));
  botonPanel.setAttribute('aria-pressed', String(visible));
  // The canvas changes width when the panel opens or closes; if the image
  // was fitted, it is refitted to the new size.
  if (state.zoom < 1) requestAnimationFrame(fitToWindow);
}

botonPanel.addEventListener('click', () => togglePanel());
document.getElementById('adjustments-close').addEventListener('click', () => togglePanel(false));

// The sliders share a handler: each carries its key in the id.
for (const [id, key] of [
  ['c-contrast', 'contrast'],
  ['c-brightness', 'brightness'],
  ['c-saturation', 'saturation'],
  ['c-sepia', 'sepia'],
  ['c-sharpen', 'sharpen'],
]) {
  document.getElementById(id).addEventListener('input', (e) => {
    adjustments[key] = Number(e.target.value);
    applyFilters();
  });
}

// The threshold recomputes the whole image, so it is handled separately.
document.getElementById('c-threshold').addEventListener('input', (e) => {
  adjustments.threshold = Number(e.target.value);
  refreshControls();
  scheduleThreshold();
});

document.getElementById('b-negative').addEventListener('click', () => {
  adjustments.negative = !adjustments.negative;
  applyFilters();
});
document.getElementById('b-greyscale').addEventListener('click', () => {
  adjustments.greyscale = !adjustments.greyscale;
  applyFilters();
});
document.getElementById('b-mirror').addEventListener('click', () => {
  adjustments.mirror = !adjustments.mirror;
  applyFilters();
  applyZoom();
});
document.getElementById('b-rotate-left').addEventListener('click', () => {
  adjustments.rotation = (adjustments.rotation + 270) % 360;
  fitToWindow();
});
document.getElementById('b-rotate-right').addEventListener('click', () => {
  adjustments.rotation = (adjustments.rotation + 90) % 360;
  fitToWindow();
});
document.getElementById('b-reset').addEventListener('click', () => {
  resetAdjustments();
  fitToWindow();
});

enableDrag();
enablePdfDrag();

document.addEventListener('keydown', (e) => {
  if (viewer.hidden) return;
  // Shortcuts are not captured while typing into a control.
  // They are only yielded to fields that are typed into. A slider keeps focus
  // after being used, and blocking keys there would leave the viewer without
  // shortcuts right after touching an adjustment.
  // Escape is the exception: while describing an entry the focus is almost
  // always in a field, and without this there would be no way to close with
  // the keyboard.
  if (e.target.matches('textarea, input:not([type="range"])') && e.key !== 'Escape') return;

  // Ctrl+F searches inside the document, not the browser page.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    if (viewer.classList.contains('es-text')) {
      e.preventDefault();
      openDocFinder();
    }
    return;
  }

  switch (e.key) {
    case 'Escape':
      // Closes from the inside out: first whatever was opened over the
      // document, and only at the end the viewer itself.
      if (!panelBuscador.hidden) closeDocFinder();
      else if (!panelPartida.hidden) closeEntry();
      else if (!panel.hidden) togglePanel(false);
      else closeViewer();
      break;
    case 'Backspace':
      // Backspace goes back to the previous document of the trail.
      if (viewerHistory.length > 0) viewerBack();
      break;
    case 'f':
    case 'F':
      if (viewer.classList.contains('es-text')) openDocFinder();
      break;
    case 'ArrowRight':
      // Over a slider, the arrows belong to it: they fine-tune the value
      // and must not jump between documents.
      if (e.target.matches('input[type="range"]')) return;
      moveInList(1);
      break;
    case 'ArrowLeft':
      if (e.target.matches('input[type="range"]')) return;
      moveInList(-1);
      break;
    // The zoom keys serve the image or the PDF, depending which is on
    // screen.
    case '+':
    case '=':
      if (viewer.classList.contains('es-pdf')) zoomPdf('mas');
      else {
        state.zoom = Math.min(8, state.zoom * 1.25);
        applyZoom();
      }
      break;
    case '-':
      if (viewer.classList.contains('es-pdf')) zoomPdf('menos');
      else {
        state.zoom = Math.max(0.05, state.zoom / 1.25);
        applyZoom();
      }
      break;
    case '0':
      if (viewer.classList.contains('es-pdf')) zoomPdf('wide');
      else fitToWindow();
      break;
    case 'l':
    case 'L':
      readingMode();
      break;
    case 'a':
    case 'A':
      togglePanel();
      break;
    case 'm':
    case 'M':
      if (viewer.classList.contains('es-imagen')) toggleCropMode();
      break;
    case 'i':
    case 'I':
      adjustments.negative = !adjustments.negative;
      applyFilters();
      break;
    case 'r':
    case 'R':
      resetAdjustments();
      fitToWindow();
      break;
    default:
      break;
  }
});

// Wheel: zooms in and out on the point the cursor indicates. Ctrl is no
// longer needed, because the canvas has no scrollbars to move.
document.getElementById('viewer-canvas').addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    zoomAtPoint(e.deltaY < 0 ? 1.12 : 0.89, e.clientX, e.clientY);
  },
  { passive: false },
);

/**
 * Refreshes the watching state while the home screen is in view.
 * It is only queried when there is something to look at: polling while the
 * user is on another screen makes no sense.
 */
let watchPoll = null;

function watchState() {
  clearInterval(watchPoll);
  watchPoll = setInterval(() => {
    if (state.section !== 'home' || !document.getElementById('watching')) {
      clearInterval(watchPoll);
      return;
    }
    void renderWatching();
  }, 4000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.section === 'home') void renderWatching();
});

// The browser remembers between sessions whether it is collapsed and how wide it is.
if (readTextPreference('regesta.panel', '1') === '0') {
  document.getElementById('body').classList.add('no-panel');
}
setPanelWidth(readPreference('regesta.panelWidth', 268));
enableHandle();
setSheetWidth(readPreference('regesta.sheetWidth', 330));
enableSheetHandle();

// 'E' collapses and expands the browser, except while typing.
document.addEventListener('keydown', (e) => {
  if (!viewer.hidden) return;
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'e' || e.key === 'E') toggleBrowser();
});

goTo('home');
void renderBrowser();
watchState();
