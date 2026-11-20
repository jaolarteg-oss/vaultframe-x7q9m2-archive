/* Cambia SOLO esta URL por la que recibas al publicar tu Cloudflare Worker. */
const API_BASE = 'https://framevault-secure-api.ja-olarteg.workers.dev';

const MAX_FILE_SIZE = 8 * 1024 * 1024;
const EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm']);
let sessionToken = ''; // Solo RAM. Al recargar, se requiere volver a iniciar sesión.
let library = { files: [], folders: [] };
let activeFolder = '';
let selectedFiles = [];
let selectedPreview = null;
let toastTimer;
const $ = (id) => document.getElementById(id);

function notify(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

function prettyBytes(bytes) {
  if (!bytes) return '0 KB';
  const unit = bytes >= 1024 * 1024 ? 'MB' : 'KB';
  const divisor = unit === 'MB' ? 1024 * 1024 : 1024;
  return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

function extension(name) {
  return name.split('.').pop().toLowerCase();
}

async function callApi(path, options = {}, requiresAuth = true) {
  if (API_BASE.includes('REEMPLAZAR')) throw new Error('Configura API_BASE al comienzo de app.js. Consulta README.md.');
  const headers = new Headers(options.headers || {});
  if (requiresAuth) headers.set('Authorization', `Bearer ${sessionToken}`);
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers, cache: 'no-store' });
  } catch {
    throw new Error('No se pudo conectar con el servidor. Comprueba la URL de tu Worker y ALLOWED_ORIGIN.');
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && requiresAuth) {
    endSession();
    throw new Error('La sesión expiró. Ingresa de nuevo tu código.');
  }
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

function showDashboard() {
  $('loginPage').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  $('accessCode').value = '';
}

function endSession() {
  sessionToken = '';
  library = { files: [], folders: [] };
  selectedFiles = [];
  activeFolder = '';
  hideMobileMenu();
  $('loginPage').classList.remove('hidden');
  $('dashboard').classList.add('hidden');
  for (const id of ['uploadDialog', 'folderDialog', 'previewDialog']) {
    if ($(id).open) $(id).close();
  }
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('loginButton');
  button.disabled = true;
  $('loginError').textContent = '';
  try {
    const data = await callApi('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('accessCode').value })
    }, false);
    sessionToken = data.token;
    showDashboard();
    await loadFiles();
    void loadUsage();
    switchView('library');
    notify('Acceso concedido. Bienvenido a FrameVault.');
  } catch (error) {
    $('loginError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('togglePass').addEventListener('click', () => {
  const input = $('accessCode');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('togglePass').textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar';
});

$('logoutButton').addEventListener('click', endSession);
$('logoutTop').addEventListener('click', endSession);
$('refreshButton').addEventListener('click', () => { loadFiles(); void loadUsage(); });
$('searchInput').addEventListener('input', renderGrid);
$('typeFilter').addEventListener('change', renderGrid);
$('sortSelect').addEventListener('change', renderGrid);
$('allFilesButton').addEventListener('click', () => selectFolder(''));

async function loadFiles() {
  $('pageMessage').textContent = 'Consultando archivos del repositorio…';
  try {
    library = await callApi('/files');
    library.files ||= [];
    library.folders ||= [];
    $('pageMessage').textContent = '';
    renderFolders();
    renderGrid();
    updateInsights();
  } catch (error) {
    $('pageMessage').textContent = error.message;
    notify(error.message);
  }
}

function renderFolders() {
  $('statFiles').textContent = String(library.files.length);
  $('statFolders').textContent = String(library.folders.length);
  $('statSize').textContent = prettyBytes(library.files.reduce((sum, file) => sum + (file.size || 0), 0));
  $('sideCount').textContent = String(library.files.length);
  const nav = $('folderList');
  nav.replaceChildren();
  for (const folder of library.folders) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `folder-item${activeFolder === folder ? ' active' : ''}`;
    const icon = document.createElement('span'); icon.textContent = '▱';
    const name = document.createElement('span'); name.textContent = folder;
    button.append(icon, name);
    button.addEventListener('click', () => selectFolder(folder));
    nav.append(button);
  }
  const select = $('uploadFolder');
  const previous = select.value;
  select.replaceChildren(new Option('Sin carpeta (raíz)', ''));
  for (const folder of library.folders) select.append(new Option(folder, folder));
  select.value = library.folders.includes(previous) ? previous : '';
  if (activeFolder && !library.folders.includes(activeFolder)) activeFolder = '';
  updateActiveFolderLabel();
}

function updateActiveFolderLabel() {
  $('crumbCurrent').textContent = activeFolder || 'Todos los archivos';
  $('allFilesButton').classList.toggle('active', !activeFolder);
  for (const button of $('folderList').children) {
    button.classList.toggle('active', button.children[1]?.textContent === activeFolder);
  }
}

function selectFolder(folder) {
  switchView('library');
  hideMobileMenu();
  activeFolder = folder;
  updateActiveFolderLabel();
  renderGrid();
}

function renderGrid() {
  const search = $('searchInput').value.trim().toLocaleLowerCase();
  const type = $('typeFilter').value;
  const sort = $('sortSelect').value;
  let visible = library.files.filter((file) => {
    return (!activeFolder || file.folder === activeFolder || file.folder.startsWith(activeFolder + '/')) &&
      (!search || file.name.toLocaleLowerCase().includes(search) || file.folder.toLocaleLowerCase().includes(search)) &&
      (type === 'all' || file.category === type);
  });
  visible.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, 'es');
    const delta = (a.createdAt || '').localeCompare(b.createdAt || '');
    return sort === 'new' ? -delta : delta;
  });
  $('filesCount').textContent = String(visible.length);
  const grid = $('grid');
  grid.replaceChildren();
  if (!visible.length) {
    const box = document.createElement('div');
    box.className = 'empty-state';
    const icon = document.createElement('div'); icon.className = 'empty-icon'; icon.textContent = '▧';
    const h = document.createElement('h3'); h.textContent = 'No hay archivos aquí';
    const p = document.createElement('p'); p.textContent = 'Prueba otra búsqueda o agrega tus primeros archivos.';
    box.append(icon, h, p); grid.append(box);
    return;
  }
  const fragment = document.createDocumentFragment();
  visible.forEach((file) => fragment.append(makeCard(file)));
  grid.append(fragment);
}

function makeCard(file) {
  const card = document.createElement('article'); card.className = 'file-card';
  const media = document.createElement('div'); media.className = 'file-media'; media.tabIndex = 0; media.setAttribute('role', 'button'); media.setAttribute('aria-label', `Previsualizar ${file.name}`);
  let element;
  if (file.category === 'video') {
    element = document.createElement('video'); element.src = file.rawUrl; element.muted = true; element.preload = 'metadata';
    const play = document.createElement('div'); play.className = 'video-indicator'; play.textContent = '▶'; media.append(play);
  } else {
    element = document.createElement('img'); element.src = file.rawUrl; element.alt = file.name; element.loading = 'lazy'; element.decoding = 'async';
  }
  media.prepend(element);
  const tag = document.createElement('span'); tag.className = 'type-tag'; tag.textContent = extension(file.name).toUpperCase(); media.append(tag);
  media.addEventListener('click', () => showPreview(file));
  media.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showPreview(file); } });
  const info = document.createElement('div'); info.className = 'file-info';
  const title = document.createElement('div'); title.className = 'file-name'; title.textContent = file.name; title.title = file.name;
  const subtitle = document.createElement('div'); subtitle.className = 'file-subtitle';
  const date = file.createdAt ? new Date(file.createdAt).toLocaleDateString('es-CO') : 'Fecha desconocida';
  subtitle.textContent = `${prettyBytes(file.size)} · ${date}`;
  const actions = document.createElement('div'); actions.className = 'file-actions';
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '▢ Copiar URL'; copy.addEventListener('click', () => copyUrl(file.rawUrl));
  const open = document.createElement('button'); open.type = 'button'; open.textContent = '↗ Ver'; open.addEventListener('click', () => window.open(file.rawUrl, '_blank', 'noopener,noreferrer'));
  actions.append(copy, open);
  info.append(title, subtitle, actions);
  card.append(media, info);
  return card;
}

async function copyUrl(url) {
  try {
    await navigator.clipboard.writeText(url);
    notify('URL directa copiada al portapapeles.');
  } catch {
    window.prompt('Copia esta URL:', url);
  }
}

function showPreview(file) {
  selectedPreview = file;
  $('previewTitle').textContent = file.name;
  const box = $('previewContent'); box.replaceChildren();
  const el = file.category === 'video' ? document.createElement('video') : document.createElement('img');
  el.src = file.rawUrl;
  if (file.category === 'video') { el.controls = true; el.preload = 'metadata'; } else el.alt = file.name;
  box.append(el);
  $('previewOpenLink').href = file.rawUrl;
  $('previewDialog').showModal();
}

$('previewCopy').addEventListener('click', () => selectedPreview && copyUrl(selectedPreview.rawUrl));
$('previewDialog').addEventListener('close', () => { $('previewContent').replaceChildren(); selectedPreview = null; });

function openUpload() {
  selectedFiles = [];
  $('fileInput').value = '';
  $('selectedFiles').replaceChildren();
  $('uploadStatus').textContent = '';
  $('startUpload').disabled = true;
  $('uploadFolder').value = activeFolder || '';
  $('uploadDialog').showModal();
}
$('uploadOpen').addEventListener('click', openUpload);
$('cancelUpload').addEventListener('click', () => $('uploadDialog').close());
$('dropZone').addEventListener('click', () => $('fileInput').click());
$('dropZone').addEventListener('keydown', (event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); $('fileInput').click(); } });
$('fileInput').addEventListener('change', (event) => stageFiles(event.target.files));
$('dropZone').addEventListener('dragover', (event) => { event.preventDefault(); $('dropZone').classList.add('dragging'); });
$('dropZone').addEventListener('dragleave', () => $('dropZone').classList.remove('dragging'));
$('dropZone').addEventListener('drop', (event) => { event.preventDefault(); $('dropZone').classList.remove('dragging'); stageFiles(event.dataTransfer.files); });

function stageFiles(files) {
  const valid = [];
  const problems = [];
  for (const file of Array.from(files)) {
    if (!EXTENSIONS.has(extension(file.name))) problems.push(`${file.name}: tipo no permitido`);
    else if (!file.size || file.size > MAX_FILE_SIZE) problems.push(`${file.name}: tamaño fuera del límite`);
    else valid.push(file);
  }
  selectedFiles = valid;
  const list = $('selectedFiles'); list.replaceChildren();
  for (const file of valid) { const line = document.createElement('div'); line.textContent = `✓ ${file.name} (${prettyBytes(file.size)})`; list.append(line); }
  $('startUpload').disabled = !valid.length;
  $('uploadStatus').textContent = problems.length ? problems.join(' · ') : `${valid.length} archivo(s) seleccionado(s).`;
}

$('startUpload').addEventListener('click', async () => {
  if (!selectedFiles.length) return;
  $('startUpload').disabled = true;
  const folder = $('uploadFolder').value;
  let uploaded = 0;
  const errors = [];
  for (const file of selectedFiles) {
    $('uploadStatus').textContent = `Subiendo ${uploaded + 1} de ${selectedFiles.length}: ${file.name}…`;
    try {
      const params = new URLSearchParams({ name: file.name, folder });
      await callApi(`/upload?${params}`, {
        method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file
      });
      uploaded += 1;
    } catch (error) {
      errors.push(`${file.name}: ${error.message}`);
      if (!sessionToken) break;
    }
  }
  $('uploadStatus').textContent = `${uploaded} subidos. ${errors.join(' · ')}`;
  if (uploaded) {
    $('uploadDialog').close();
    await loadFiles();
    notify(`¡${uploaded} archivo(s) publicados! Ya puedes copiar sus URLs.`);
  } else {
    $('startUpload').disabled = false;
    if (errors.length) notify(errors[0]);
  }
});

function openFolder() { $('folderName').value = ''; $('folderError').textContent = ''; $('folderDialog').showModal(); $('folderName').focus(); }
$('createFolder').addEventListener('click', openFolder);
$('newFolderSide').addEventListener('click', openFolder);
$('cancelFolder').addEventListener('click', () => $('folderDialog').close());
$('folderForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('folderName').value.trim();
  if (!/^[a-zA-Z0-9_-]{1,40}(\/[a-zA-Z0-9_-]{1,40}){0,3}$/.test(name)) {
    $('folderError').textContent = 'Usa letras sin tildes, números, guiones o guiones bajos. Máximo 4 niveles.';
    return;
  }
  $('folderError').textContent = '';
  try {
    await callApi('/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: name }) });
    $('folderDialog').close();
    await loadFiles();
    selectFolder(name);
    notify('Carpeta creada correctamente.');
  } catch (error) { $('folderError').textContent = error.message; }
});

/* FrameVault v2: vistas y seguimiento — ninguna credencial se almacena aquí. */
const PAGE_BYTES_REFERENCE = 1_000_000_000;
const MONTHLY_BANDWIDTH_BYTES = 100_000_000_000;
const USAGE_LIMITS = { workerUsed: 100000, kvReadsUsed: 100000, kvWritesUsed: 1000 };
let cloudUsage = null;
let currentView = 'library';
const MONTH_KEY = new Date().toISOString().slice(0,7);
const DAY_KEY = new Date().toISOString().slice(0,10);
const LOCAL_PREFERENCES_KEY = 'framevault:usage-estimates:v2';

function numberEs(value) { return Number(value).toLocaleString('es-CO'); }
function conciseGB(bytes) { return `${(bytes / 1_000_000_000).toLocaleString('es-CO', {maximumFractionDigits: 2})} GB`; }
function percent(value, total) { return total ? Math.max(0, Math.min(100, value / total * 100)) : 0; }
function setWidth(id, part) { $(id).style.width = `${Math.max(0,Math.min(100,part))}%`; }

function switchView(view) {
  currentView = view;
  $('libraryView').classList.toggle('hidden', view !== 'library');
  $('insightsView').classList.toggle('hidden', view !== 'insights');
  $('navLibrary').classList.toggle('active', view === 'library');
  $('navInsights').classList.toggle('active', view === 'insights');
  $('crumbCurrent').textContent = view === 'library' ? (activeFolder || 'Mi biblioteca') : 'Seguimiento';
  hideMobileMenu();
  if (view === 'insights') { updateInsights(); void loadUsage(); }
}
function hideMobileMenu() {
  $('sidebar').classList.remove('open');
  $('mobileBackdrop').classList.add('hidden');
}
$('navLibrary').addEventListener('click', () => switchView('library'));
$('navInsights').addEventListener('click', () => switchView('insights'));
$('heroInsights').addEventListener('click', () => switchView('insights'));
$('insightsRefresh').addEventListener('click', () => { void loadFiles(); void loadUsage(); });
$('mobileMenuButton').addEventListener('click', () => {
  const opening = !$('sidebar').classList.contains('open');
  $('sidebar').classList.toggle('open', opening);
  $('mobileBackdrop').classList.toggle('hidden', !opening);
});
$('mobileBackdrop').addEventListener('click', hideMobileMenu);

async function loadUsage() {
  if (!sessionToken) return;
  try {
    const next = await callApi('/usage');
    cloudUsage = next;
    $('apiHint').textContent = 'Cuota de GitHub consultada directamente desde la API con tu sesión protegida.';
  } catch (error) {
    // Si no se ha actualizado el Worker, la biblioteca sigue completamente funcional.
    cloudUsage = null;
    if (sessionToken) $('apiHint').textContent = 'No se pudo consultar la cuota de GitHub. Actualiza el código del Worker para habilitar esta lectura.';
  }
  updateInsights();
}

function renderCategoryBars(byCategory) {
  const parent = $('categoryBars'); parent.replaceChildren();
  const total = Object.values(byCategory).reduce((sum,x) => sum + x.bytes, 0);
  const categories = [ ['image','Fotografías'], ['gif','GIFs'], ['video','Videos'] ];
  categories.forEach(([key,label]) => {
    const item = document.createElement('div'); item.className = 'category-row';
    const name = document.createElement('span'); name.className = 'label'; name.textContent = `${label} (${byCategory[key].count})`;
    const track = document.createElement('div'); track.className = 'category-track';
    const fill = document.createElement('div'); fill.className = 'category-fill';
    fill.style.width = `${percent(byCategory[key].bytes,total)}%`; track.append(fill);
    const amount = document.createElement('span'); amount.className = 'amount'; amount.textContent = prettyBytes(byCategory[key].bytes);
    item.append(name,track,amount); parent.append(item);
  });
}
function renderLargestFiles() {
  const root = $('largestFiles'); root.replaceChildren();
  const top = [...library.files].sort((a,b) => (b.size || 0) - (a.size || 0)).slice(0,5);
  if (!top.length) { const p = document.createElement('p'); p.textContent = 'Aún no hay archivos para analizar.'; root.append(p); }
  top.forEach((file,i) => {
    const line = document.createElement('div'); line.className = 'rank-row';
    const order = document.createElement('span'); order.className = 'rank-num'; order.textContent = String(i+1).padStart(2,'0');
    const name = document.createElement('span'); name.className = 'rank-name'; name.textContent = file.name; name.title = file.name;
    const size = document.createElement('span'); size.className = 'rank-size'; size.textContent = prettyBytes(file.size || 0);
    line.append(order,name,size); root.append(line);
  });
}
function updateInsights() {
  const files = library.files || [];
  const totalBytes = files.reduce((sum,file) => sum + (Number(file.size) || 0), 0);
  const storageLeft = Math.max(0, PAGE_BYTES_REFERENCE-totalBytes);
  const usedPct = percent(totalBytes,PAGE_BYTES_REFERENCE);
  $('statRemaining').textContent = prettyBytes(storageLeft);
  $('insightStorageUsed').textContent = prettyBytes(totalBytes);
  $('insightStorageLeft').textContent = prettyBytes(storageLeft);
  $('storageUsedPct').textContent = `${usedPct.toLocaleString('es-CO',{maximumFractionDigits:1})}%`;
  $('storageRing').style.setProperty('--percent',`${usedPct}%`);
  setWidth('storageProgress',usedPct);
  const counts = {image:{bytes:0,count:0},gif:{bytes:0,count:0},video:{bytes:0,count:0}};
  for (const f of files) if (counts[f.category]) { counts[f.category].bytes += Number(f.size)||0; counts[f.category].count++; }
  renderCategoryBars(counts);
  renderLargestFiles();
  if (cloudUsage && cloudUsage.githubApi && Number.isFinite(cloudUsage.githubApi.remaining)) {
    const a = cloudUsage.githubApi;
    $('apiRemaining').textContent = numberEs(a.remaining);
    $('apiReset').textContent = `de ${numberEs(a.limit)} · Reinicio: ${new Date(a.reset*1000).toLocaleString('es-CO',{dateStyle:'short',timeStyle:'short'})}`;
    setWidth('apiProgress',percent(a.used,a.limit));
  } else {
    $('apiRemaining').textContent = '—'; $('apiReset').textContent = 'Sin lectura en tiempo real'; setWidth('apiProgress',0);
  }
  const repo = cloudUsage?.repo;
  $('repoSize').textContent = repo && Number.isFinite(repo.sizeBytes) ? prettyBytes(repo.sizeBytes) : '—';
  refreshQuotaInputs();
  refreshProjection();
}
function loadPreferences() {
  try { return JSON.parse(localStorage.getItem(LOCAL_PREFERENCES_KEY)) || {}; } catch { return {}; }
}
function savePreferences() {
  const input = { date:DAY_KEY, month:MONTH_KEY };
  for (const name of [...Object.keys(USAGE_LIMITS), 'monthlyViews', 'averageWeight']) input[name] = $(name).value.trim();
  try { localStorage.setItem(LOCAL_PREFERENCES_KEY,JSON.stringify(input)); } catch { /* privado o restringido */ }
}
function populatePreferences() {
  const saved = loadPreferences();
  if (saved.date === DAY_KEY) for (const name of Object.keys(USAGE_LIMITS)) if (saved[name] !== undefined) $(name).value = saved[name];
  if (saved.month === MONTH_KEY) for (const name of ['monthlyViews','averageWeight']) if (saved[name] !== undefined) $(name).value = saved[name];
}
function refreshQuotaInputs() {
  for (const [id,limit] of Object.entries(USAGE_LIMITS)) {
    const field = $(id); const value = field.value.trim();
    const label = id === 'workerUsed' ? 'workerLeft' : id === 'kvReadsUsed' ? 'kvReadsLeft' : 'kvWritesLeft';
    const bar = id === 'workerUsed' ? 'workerBar' : id === 'kvReadsUsed' ? 'kvReadsBar' : 'kvWritesBar';
    if (value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) { $(label).textContent = '—'; setWidth(bar,0); continue; }
    const used = Number(value); const left = Math.max(0,limit-used);
    $(label).textContent = used > limit ? `${numberEs(left)} (excedido)` : numberEs(left);
    setWidth(bar,percent(used,limit));
  }
}
function refreshProjection() {
  const weightStr = $('averageWeight').value.trim();
  const viewsStr = $('monthlyViews').value.trim();
  const fileCount = library.files.length;
  const totalBytes = library.files.reduce((a,f)=>a+(Number(f.size)||0),0);
  const autoMB = fileCount ? totalBytes/fileCount/1_000_000 : 0;
  if (!weightStr) $('averageWeight').placeholder = autoMB ? `Media: ${autoMB.toFixed(2)} MB` : 'Ej. 2.5';
  if (!viewsStr || Number(viewsStr) < 0 || !Number.isFinite(Number(viewsStr)) || (!weightStr && !autoMB)) {
    $('projectedGB').textContent = '—'; $('projectedLeft').textContent = 'Completa las descargas para estimar el espacio restante.'; setWidth('bandwidthBar',0); return;
  }
  const mb = weightStr ? Number(weightStr) : autoMB;
  if (!(mb > 0 && Number.isFinite(mb))) { $('projectedGB').textContent='—';$('projectedLeft').textContent='Introduce un tamaño de archivo válido.';setWidth('bandwidthBar',0);return; }
  const transfer = mb * 1_000_000 * Number(viewsStr);
  const left = Math.max(0,MONTHLY_BANDWIDTH_BYTES-transfer);
  $('projectedGB').textContent = conciseGB(transfer);
  $('projectedLeft').textContent = transfer>MONTHLY_BANDWIDTH_BYTES ? `El escenario excedería el límite flexible por ${conciseGB(transfer-MONTHLY_BANDWIDTH_BYTES)}.` : `Restante proyectado: ${conciseGB(left)} de 100 GB.`;
  setWidth('bandwidthBar',percent(transfer,MONTHLY_BANDWIDTH_BYTES));
}
for (const id of Object.keys(USAGE_LIMITS)) $(id).addEventListener('input',() => { savePreferences(); refreshQuotaInputs(); });
for (const id of ['averageWeight','monthlyViews']) $(id).addEventListener('input',() => { savePreferences(); refreshProjection(); });
populatePreferences();
refreshQuotaInputs();
refreshProjection();
