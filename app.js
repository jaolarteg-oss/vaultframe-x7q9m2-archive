/* Cambia SOLO esta URL por la que recibas al publicar tu Cloudflare Worker. */
const API_BASE = 'https://REEMPLAZAR-TU-WORKER.workers.dev';

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
$('refreshButton').addEventListener('click', loadFiles);
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
