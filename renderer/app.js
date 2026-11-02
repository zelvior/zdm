'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const api = window.downloader;
const progressMode = new URLSearchParams(location.search).get('progress');
if(progressMode)document.body.classList.add('progress-window');
let state = { downloads: [], settings: {}, integration: {} }, selectedId = null, detailId = null, filter = 'all', category = '', searchTerm = '', sort = 'createdAt', ascending = false, visibleDownloads = [], toastTimer, unsubscribe, unsubscribeCommands;
const selectedIds = new Set();
const pending = new Set();
let pendingReviewId = null;
let selectionDrag = null, suppressRowClick = false;
const dismissedReviews = new Set();
const iconPaths = {
  add:['M12 5v14M5 12h14'], play:['M8 5.5v13l11-6.5z'], pause:['M8 5v14M16 5v14'], trash:['M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6'],
  sparkle:['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z'],
  sliders:['M4 7h9M17 7h3M4 17h3M11 17h9M13 5v4M7 15v4'], clock:['M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0-16','M12 8v4.5l3 1.5'],
  globe:['M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0-16','M4 12h16M12 4c-3 3-3 13 0 16M12 4c3 3 3 13 0 16'], search:['M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14','M20 20l-4-4'],
  list:['M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'], bolt:['M13 3L5 13h6l-1 8 8-10h-6z'], queue:['M4 6h16M4 12h10M4 18h6M17 15l4 3-4 3z'], check:['M5 12.5l4.5 4.5L19 7.5'],
  video:['M4 6h12v12H4z','M16 10l5-3v10l-5-3'], audio:['M9 18V6l10-2v12','M9 18a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0M19 16a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0'],
  image:['M4 5h16v14H4z','M8.5 10a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3','M4 17l5-5 4 4 3-3 4 4'], document:['M7 3h7l4 4v14H7z','M14 3v4h4M10 12h5M10 16h5'],
  archive:['M4 7h16v4H4z','M5 11v9h14v-9M10 15h4'], program:['M12 3l8 4.5v9L12 21l-8-4.5v-9z','M12 12l8-4.5M12 12L4 7.5M12 12v9'], file:['M7 3h7l4 4v14H7z','M14 3v4h4'],
  open:['M14 4h6v6M20 4l-9 9','M18 14v5H5V6h5'], folder:['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'], info:['M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0-16','M12 11v5M12 8h.01'],
  download:['M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14']
};
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon(name) { const svg = document.createElementNS(SVG_NS,'svg'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true'); for (const data of iconPaths[name] || iconPaths.file) { const path = document.createElementNS(SVG_NS,'path'); path.setAttribute('d',data); svg.append(path); } return svg; }
for (const holder of $$('[data-icon]')) holder.prepend(svgIcon(holder.dataset.icon));
function element(tag,className,text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
const rememberLabel = element('label','checkbox-label'); const rememberInput = element('input'); rememberInput.type = 'checkbox'; rememberInput.id = 'remember-category-path'; rememberInput.disabled = true; rememberLabel.append(rememberInput,document.createTextNode('Remember this folder for the selected type'));
$('#add-directory').closest('.form-line').after(rememberLabel);

// ---- Browser connection: every browser ZDM found, whether it can reach the app, and how to add the extension or another browser ----
const isMac = /Mac/i.test(navigator.platform), isWindows = /Win/i.test(navigator.platform);
const pasteKeys = isMac ? ['Command+Shift+G','Command+V','Return'] : ['Ctrl+L','Ctrl+V','Enter'];
const friendlyProblem = { 'not connected': 'Waiting to be connected', 'browser registry entry is missing': 'Connection entry missing, repairing…', 'browser connector file is missing': 'Connection entry missing, repairing…', 'connector manifest is missing': 'Connection entry damaged, repairing…', 'connector program moved or missing': 'ZDM moved, repairing…', 'extension ID changed': 'Extension changed, repairing…' };
function renderSteps(info) {
  const steps = $('#extension-steps'); steps.replaceChildren();
  const items = [
    ['Copy the extension folder path above.'],
    ['Open your browser’s extensions page (use the buttons above, or type ',['strong','chrome://extensions'],' / ',['strong','brave://extensions'],' / ',['strong','edge://extensions'],' in the address bar).'],
    ['Turn on ',['strong','Developer mode'],'.'],
    ['Choose ',['strong','Load unpacked'],`. In the folder window press ${pasteKeys[0]}${isMac ? ' (Go to Folder)' : ''}, paste with ${pasteKeys[1]}, press ${pasteKeys[2]}, then choose the folder itself.`],
    ['Check that ',['strong','ZDM Integration'],' is switched on. ZDM connects by itself; this window shows the result within a few seconds.']
  ];
  if ((info.browsers || []).some(b => b.family === 'firefox')) items.push(['Firefox-based browsers: open ',['strong','about:debugging'],', choose ',['strong','This Firefox'],', then ',['strong','Load Temporary Add-on'],' and pick ',['strong','manifest.json'],` in ${info.firefoxExtensionPath || 'the firefox-extension folder'}.`]);
  for (const parts of items) { const li = element('li'); for (const part of parts) li.append(Array.isArray(part) ? element(part[0],'',part[1]) : document.createTextNode(part)); steps.append(li); }
}
function renderIntegration(info = {}) {
  $('#extension-path').value = info.extensionPath || '';
  const browsers = info.browsers || [], list = $('#browser-list'); list.replaceChildren();
  if (!browsers.length) { const empty = element('li','empty','No supported browser found yet. Install one, or add yours under “My browser is not listed”.'); list.append(empty); }
  for (const browser of browsers) {
    const item = element('li'); item.dataset.state = browser.connected ? 'connected' : 'problem';
    item.append(element('span','state-dot'),element('span','browser-name',browser.label));
    let detail = browser.connected ? 'Connected' : friendlyProblem[browser.problem] || browser.problem || 'Not connected';
    if (browser.shared) detail += ` (through ${browser.shared})`;
    item.append(element('span','browser-detail',detail));
    if (!browser.verified) { const tag = element('span','tag','expected to work'); tag.title = 'The place this browser reads connections from follows its parent browser. If the extension still says “not connected”, add it under “My browser is not listed”.'; item.append(tag); }
    if (browser.custom) { const remove = element('button','small-button','Remove'); remove.type = 'button'; remove.addEventListener('click',async () => { try { renderIntegration(await call('removeCustom',{id:browser.name})); } catch (error) { notify(messageOf(error),true); } }); item.append(remove); }
    list.append(item);
  }
  const connected = browsers.filter(b => b.connected);
  const status = $('#automatic-connection');
  if (info.connectionError) { status.dataset.state = 'attention'; status.textContent = `Setup needs attention: ${info.connectionError}`; }
  else if (connected.length) { status.dataset.state = 'ok'; status.textContent = `${connected.map(b => b.label).join(', ')} ${connected.length === 1 ? 'is' : 'are'} connected. Reload your video page to see the download button.`; }
  else if (browsers.length) { status.dataset.state = 'attention'; status.textContent = 'Browsers found. ZDM is connecting them; this takes a few seconds.'; }
  else { status.dataset.state = ''; status.textContent = 'No supported browser found yet.'; }
  const openers = $('#open-browser-buttons'); openers.replaceChildren();
  const chromium = browsers.filter(b => b.family === 'chromium' && !b.custom && !b.shared).map(b => b.name);
  for (const name of chromium.length ? chromium : ['Chrome','Edge']) { const button = element('button','small-button',name); button.type = 'button'; button.addEventListener('click',async () => { try { await call('browserSetup',{action:'open',browser:name}); } catch (error) { notify(messageOf(error),true); } }); openers.append(button); }
  renderSteps(info);
  $('#integration-port').value = info.port ? 'Ready' : 'Unavailable';
}
$('#custom-location-label').textContent = isWindows ? 'Registry key' : 'Folder';
$('#custom-location').placeholder = isWindows ? 'Vivaldi' : (isMac ? '/Users/you/Library/Application Support/MyBrowser' : '/home/you/.config/my-browser');
$('#custom-location-help').textContent = isWindows ? 'The vendor key under HKCU\\Software where the browser looks for native messaging hosts, for example Vivaldi or Opera Software\\Opera.' : 'The browser’s data folder (or its NativeMessagingHosts folder inside it).';
for (const [id,action] of [['#copy-extension-path','copy'],['#show-extension-folder','folder']]) $(id).addEventListener('click',async () => { try { await call('browserSetup',{action}); if (action === 'copy') notify(`Extension folder path copied. In the folder window press ${pasteKeys.join(', ')}.`); } catch (error) { notify(messageOf(error),true); } });
$('#custom-browser-form').addEventListener('submit',async event => {
  event.preventDefault(); const result = $('#custom-result'), submit = $('#custom-submit'); result.textContent = ''; result.dataset.error = 'false'; submit.disabled = true;
  try { const added = await call('registerCustom',{kind:$('#custom-kind').value,label:$('#custom-label').value.trim(),location:$('#custom-location').value.trim()}); if (added?.integration) renderIntegration(added.integration); result.textContent = `${added?.label || 'Browser'} added. Reload the extension in that browser.`; $('#custom-location').value = ''; $('#custom-label').value = ''; }
  catch (error) { result.dataset.error = 'true'; result.textContent = messageOf(error); } finally { submit.disabled = false; }
});
let setupPolling = false;
const setupPoll = setInterval(async () => {
  if (progressMode || !$('#integration-dialog').open || setupPolling) return;
  setupPolling = true;
  try { renderIntegration(await call('integration')); } catch (error) { $('#automatic-connection').textContent = messageOf(error); } finally { setupPolling = false; }
}, 3000);
window.addEventListener('beforeunload',() => clearInterval(setupPoll));
const completionActions=element('div','transfer-buttons');completionActions.id='download-complete-actions';completionActions.hidden=true;
for(const [label,action] of [['Open','open'],['Open with…','openWith'],['Open folder','reveal'],['Close','close']]){const button=element('button','button',label);button.type='button';button.addEventListener('click',()=>action==='close'?$('#details-dialog').close():performAction(detailDownload(),action));completionActions.append(button);}
const completedPanel=element('section','completed-panel');
const completedSummary=element('div','completed-summary');
completedPanel.append(completedSummary);
const completedFields={};
for(const [key,label] of [['url','Address'],['path','The file saved as']]){
  const fieldLabel=element('label','completed-field',label),input=element('input');
  input.readOnly=true; input.setAttribute('aria-label',label);fieldLabel.append(input);completedPanel.append(fieldLabel);completedFields[key]=input;
}
completedPanel.append(completionActions);
const suppressLabel=element('label','checkbox-label'),suppressCompletion=element('input');suppressCompletion.type='checkbox';
suppressLabel.append(suppressCompletion,document.createTextNode("Don't show this dialog again"));completedPanel.append(suppressLabel);
suppressCompletion.addEventListener('change',async()=>{try{await call('settings',{hideCompletionDialog:suppressCompletion.checked});}catch(error){suppressCompletion.checked=!suppressCompletion.checked;notify(messageOf(error),true);}});
$('#details-dialog').append(completedPanel);
const protocolNames={'h2':'HTTP/2','http/1.1':'HTTP/1.1','http/1.0':'HTTP/1.0'};
function badge(text,kind,title){const node=element('span','badge badge-'+kind,text);if(title)node.title=title;return node;}
// On-screen protocol indicators: negotiated HTTP version, multiplexing, adaptive scaling, rate limiting, hashing and integrity.
function renderProtocol(d){
  const box=$('#protocol-badges');if(!box)return;
  const t=d.transfer||{},status=statusOf(d),live=['downloading','connecting'].includes(status),badges=[];
  const proto=protocolNames[d.protocol];
  if(proto)badges.push(badge(proto,d.protocol==='h2'?'good':'plain',d.protocol==='h2'?'Negotiated HTTP/2 (TLS ALPN)':'Negotiated HTTP/1.1'));
  else if(live)badges.push(badge('Negotiating…','plain'));
  if(d.layout==='direct')badges.push(badge('Range blocks','plain','Segmented 2–4 MB range requests written directly into the file'));
  else if(d.resumable===false)badges.push(badge('Single stream','warn','The server does not support byte ranges'));
  if(t.multiplex)badges.push(badge('Multiplexed','good','Blocks share one HTTP/2 session because the server rate-limited extra connections'));
  if(live&&t.configured)badges.push(badge(`${t.active||0}/${t.allowed} connections`+(t.allowed<t.configured?` (limit ${t.configured})`:''),t.allowed<t.configured?'warn':'plain','Active / currently allowed connections'));
  if(t.lastThrottle&&live)badges.push(badge(`Server throttling (HTTP ${t.lastThrottle.statusCode})`,'bad',`Connections were scaled down to ${t.lastThrottle.allowed}; waiting ${Math.ceil((t.lastThrottle.waitMs||0)/1000)} s`));
  if(live&&t.drops)badges.push(badge(`${t.drops} slow dropped`,'plain','Slow connections replaced by faster ones'));
  if(t.adaptive===false&&live)badges.push(badge('Adaptive off','plain'));
  if(t.hashing?.enabled&&live)badges.push(badge(t.hashing.threaded?'Hashing (worker)':'Hashing','plain','SHA-256 and MD5 are computed while downloading'));
  const i=d.integrity;
  if(i)badges.push(badge(i.status==='verified'?'Checksum verified':i.status==='mismatch'?'Checksum MISMATCH':i.status==='warning'?'Server checksum differs':'Checksums computed',i.status==='verified'?'good':i.status==='mismatch'||i.status==='warning'?'bad':'plain'));
  box.replaceChildren(...badges);
  const content=$('#details-content');
  if(content&&i){content.append(element('dt','','SHA-256'),element('dd','mono',i.sha256||'—'),element('dt','','MD5'),element('dd','mono',i.md5||'—'));
    if(i.expected)content.append(element('dt','','Expected'),element('dd','mono',`${i.expected.algorithm}:${i.expected.value} (${i.expected.source==='user'?'entered by you':'announced by server'})`));}
  const list=$('#source-list'),sources=t.sources||[];
  if(list){list.hidden=!(live&&sources.length>1);list.replaceChildren();
    if(!list.hidden){list.append(element('p','connection-caption','Mirrors'));const table=element('table','connections-table');
      const head=element('tr');for(const label of ['Host','Protocol','Conns','Speed','State'])head.append(element('th','',label));table.append(head);
      for(const x of sources){const row=element('tr');row.append(element('td','',x.host),element('td','',protocolNames[x.protocol]||x.protocol||'—'),element('td','',`${x.active}/${x.allowed}`),element('td','',`${bytes(x.speed)}/s`),element('td','',x.dead?'Unavailable':x.coolingMs>0?'Cooling down':'Active'));table.append(row);}
      list.append(table);}}
}
const renderTransferDetails=renderDetails;
renderDetails=function(){
  renderTransferDetails();const d=detailDownload();if(d)renderProtocol(d);if(!d||statusOf(d)!=='completed')return;
  completedSummary.replaceChildren(element('span','completed-icon','✓'),element('div','',`Download complete\nDownloaded ${bytes(d.total||d.downloaded)} (${Math.round(d.total||d.downloaded||0)} Bytes)`));
  completedFields.url.value=d.url||'';completedFields.path.value=d.path||'';
  suppressCompletion.checked=state.settings.hideCompletionDialog===true;
};
function numeric(value) { const result = Number(value); return Number.isFinite(result) && result > 0 ? result : 0; }
function statusOf(d) { const value = String(d.status || 'queued').toLowerCase(); return ({active:'downloading',running:'downloading',probing:'connecting',complete:'completed',done:'completed',error:'failed',canceled:'cancelled',pending:'queued'})[value] || value; }
function categoryOf(d) { const value = String(d.category || '').toLowerCase(); if (/video/.test(value)) return 'Video'; if (/audio|music/.test(value)) return 'Audio'; if (/doc|text/.test(value)) return 'Documents'; if (/arch|compress/.test(value)) return 'Archives'; if (/program/.test(value)) return 'Programs'; if (/image|picture|photo/.test(value)) return 'Images'; return 'Other'; }
function bytes(value) { const size = numeric(value); if (!size) return '0 B'; const power = Math.min(4,Math.floor(Math.log(size) / Math.log(1024))); return `${(size / 1024 ** power).toFixed(power ? 2 : 0)} ${['B','KB','MB','GB','TB'][power]}`; }
function date(value) { if (!value) return ''; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString([],{dateStyle:'short',timeStyle:'short'}); }
function timeLeft(d) { const total=numeric(d.total)||numeric(d.streamProgress?.estimatedBytes); if (!total || !numeric(d.speed)) return ''; const seconds=Math.max(0,Math.ceil((total-numeric(d.downloaded))/numeric(d.speed))); return ((!d.total||d.estimated)?'≈ ':'')+duration(seconds); }
function sizeLabel(d) { return numeric(d.total)?(d.estimated?'≈ ':'')+bytes(d.total):d.streamProgress?.estimatedBytes?'≈ '+bytes(d.streamProgress.estimatedBytes):d.kind==='hls'?'Calculating from segments…':'Not supplied by server'; }
function duration(seconds) { return seconds < 60 ? `${Math.ceil(seconds)} sec` : seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.floor(seconds / 3600)} hr ${Math.floor(seconds % 3600 / 60)} min`; }
function percentage(d) { return statusOf(d) === 'completed' ? 100 : numeric(d.total) ? Math.min(100,numeric(d.downloaded) / numeric(d.total) * 100) : d.streamProgress?.total ? d.streamProgress.completed/d.streamProgress.total*100 : null; }
function messageOf(error) { return error?.message || String(error || 'The operation failed.'); }
function notify(message,error = false) { clearTimeout(toastTimer); $('#toast-text').textContent = message; $('#toast').dataset.error = String(error); $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; },error ? 14000 : 7000); }
async function call(method,...args) { if (!api || typeof api[method] !== 'function') throw new Error('The download service is unavailable. Restart ZDM.'); const result = await api[method](...args); if (result?.error && !result.downloads) throw new Error(typeof result.error === 'string' ? result.error : result.error.message || 'The request failed.'); return result; }
function acceptSnapshot(snapshot) { if (!snapshot || !Array.isArray(snapshot.downloads)) return; state = {downloads:snapshot.downloads,settings:snapshot.settings || state.settings,integration:snapshot.integration || state.integration}; const valid=new Set(state.downloads.map(d=>d.id)); for(const id of selectedIds)if(!valid.has(id))selectedIds.delete(id); if (!valid.has(selectedId)) selectedId = selectedIds.values().next().value || null; $('#download-list').setAttribute('aria-busy','false'); $('#connection-label').textContent = 'Ready'; $('.engine-state').dataset.state = 'ready'; render(); if (!$$('dialog[open]').length) { const review = state.downloads.find(d => d.needsReview && !dismissedReviews.has(d.id)); if (review) openReview(review.id); } }
async function refresh() { acceptSnapshot(await call('snapshot')); }
function selected() { return state.downloads.find(d => d.id === selectedId); }
function canResume(d) { return d && !d.needsReview && ['paused','queued','scheduled','failed','cancelled'].includes(statusOf(d)); }
function canPause(d) { return d && !d.needsReview && ['downloading','connecting','queued','scheduled','assembling'].includes(statusOf(d)); }
function matches(d) { const status = statusOf(d); if (filter === 'completed' && status !== 'completed') return false; if (filter === 'unfinished' && status === 'completed') return false; if (filter === 'queued' && !['queued','scheduled','paused'].includes(status)) return false; if (category && categoryOf(d) !== category) return false; return !searchTerm || `${d.filename || ''} ${d.url || ''}`.toLowerCase().includes(searchTerm); }
function paintSelection() { $$('.download-row').forEach(row => { const active=selectedIds.has(row.dataset.id); row.classList.toggle('selected',active); row.setAttribute('aria-selected',String(active)); }); updateControls(); }
function selectDownload(id,{additive=false,toggle=false}={}) { if(!additive)selectedIds.clear(); if(toggle&&selectedIds.has(id))selectedIds.delete(id); else if(id)selectedIds.add(id); selectedId=selectedIds.has(id)?id:(selectedIds.values().next().value||null); paintSelection(); }
const categoryIcons = {Video:'video',Audio:'audio',Images:'image',Documents:'document',Archives:'archive',Programs:'program',Other:'file'};
const statusNames = {completed:'Finished',downloading:'Downloading',connecting:'Connecting',assembling:'Finishing',queued:'Waiting',scheduled:'Scheduled',paused:'Paused',cancelled:'Cancelled',failed:'Failed'};
function hostOf(d) { try { return new URL(d.url).hostname; } catch { return ''; } }
function rowFor(d) {
  const status = statusOf(d), percent = percentage(d), active = ['downloading','connecting','assembling'].includes(status);
  const row = element('div','download-row'); row.setAttribute('role','option'); row.dataset.id = d.id; row.dataset.status = status; row.classList.toggle('selected',selectedIds.has(d.id)); row.setAttribute('aria-selected',String(selectedIds.has(d.id)));
  const icon = element('div','row-icon'); icon.append(svgIcon(status === 'failed' ? 'info' : status === 'completed' ? 'check' : categoryIcons[categoryOf(d)] || 'file'));
  const main = element('div','row-main'); main.title = d.filename || d.url || '';
  const meta = element('div','row-meta'); const host = hostOf(d);
  meta.append(element('span','',sizeLabel(d) || '—')); if (host) meta.append(element('span','row-host',host)); if (d.protocol === 'h2') meta.append(element('span','chip','HTTP/2'));
  main.append(element('div','row-name',d.filename || 'Preparing file…'),meta);
  const progress = element('div','row-progress'); const bar = element('div','bar'); const fill = element('span');
  if (active && percent === null) bar.classList.add('indeterminate'); else fill.style.width = `${Math.max(0,Math.min(100,percent ?? 0))}%`;
  bar.append(fill);
  const stats = element('div','row-stats'); const left = element('span'), right = element('span');
  if (status === 'downloading') { left.append(element('strong','',percent === null ? 'Receiving…' : `${percent.toFixed(1)}%`)); right.textContent = [`${bytes(d.speed)}/s`,timeLeft(d) && `${timeLeft(d)} left`].filter(Boolean).join(' · '); }
  else if (status === 'completed') { left.textContent = 'Saved'; right.textContent = date(d.lastTry || d.createdAt); }
  else if (status === 'failed') { left.textContent = d.error || 'The download failed'; left.title = d.error || ''; }
  else if (status === 'scheduled') left.textContent = d.scheduledAt ? `Starts ${date(d.scheduledAt)}` : 'Scheduled';
  else if (status === 'paused') { left.textContent = percent !== null ? `${percent.toFixed(1)}%` : 'Paused'; right.textContent = d.description || ''; }
  else left.textContent = statusNames[status] || status;
  stats.append(left,right); progress.append(bar,stats);
  const pill = element('span',`pill status-${status}`,statusNames[status] || status); pill.title = d.error || '';
  row.append(icon,main,progress,pill);
  row.addEventListener('contextmenu',event => { event.preventDefault(); selectDownload(d.id); showDetails(d.id); });
  return row;
}
function updateControls() { const d = selected(), busy = d && pending.has(d.id); $('#selection-bar').hidden = !selectedIds.size; $('#selection-name').textContent = selectedIds.size > 1 ? `${selectedIds.size} downloads selected` : (d?.filename || ''); $('#resume-selected').disabled = (!canResume(d) && !d?.needsReview) || busy; $('#stop-selected').disabled = !canPause(d) || busy; $('#remove-selected').disabled = !d || busy; $('#open-selected').disabled = !d || statusOf(d) !== 'completed'; $('#reveal-selected').disabled = !d; $('#details-selected').disabled = !d; $('#pause-all').disabled = !state.downloads.some(canPause); $('#resume-all').disabled = !state.downloads.some(canResume); $('#remove-completed').disabled = !state.downloads.some(d => statusOf(d) === 'completed'); $('#scheduler-start').disabled = $('#resume-all').disabled; $('#scheduler-stop').disabled = $('#pause-all').disabled; }
function renderCounts() {
  const by = predicate => state.downloads.filter(predicate).length, status = d => statusOf(d);
  const active = by(d => ['downloading','connecting','assembling'].includes(status(d))), waiting = by(d => ['queued','scheduled','paused'].includes(status(d))), done = by(d => status(d) === 'completed');
  $('#count-all').textContent = state.downloads.length; $('#count-unfinished').textContent = by(d => status(d) !== 'completed'); $('#count-queued').textContent = waiting; $('#count-completed').textContent = done;
  for (const badge of $$('[data-count-category]')) badge.textContent = by(d => categoryOf(d) === badge.dataset.countCategory);
  $('#list-count').textContent = state.downloads.length ? `${active} active · ${waiting} waiting · ${done} finished` : 'No downloads yet';
}
function render() { visibleDownloads = state.downloads.filter(matches).sort((a,b) => { const result = sort === 'total' ? numeric(a.total) - numeric(b.total) : sort === 'createdAt' ? new Date(a.createdAt || 0) - new Date(b.createdAt || 0) : String(a[sort] || '').localeCompare(String(b[sort] || '')); return ascending ? result : -result; }); $('#download-list').replaceChildren(...visibleDownloads.map(rowFor)); $('#empty-state').hidden = visibleDownloads.length > 0; $('#empty-message').textContent = searchTerm ? 'No downloads match your search' : filter === 'all' && !category ? 'Nothing here yet' : 'Nothing in this view'; renderCounts(); $('#status-summary').textContent = `${bytes(state.downloads.reduce((sum,d) => sum + numeric(d.speed),0))}/s`; updateControls(); if ($('#details-dialog').open) renderDetails(); if ($('#scheduler-dialog').open) renderScheduler(); }
async function performAction(d,action) { if (!d || pending.has(d.id)) return; if (action === 'remove' && !window.confirm(`Delete “${d.filename || 'this download'}” from the download list?\n\nThe downloaded file will remain on your PC.`)) return; pending.add(d.id); updateControls(); try { await call('action',{id:d.id,action}); await refresh(); } catch (error) { notify(messageOf(error),true); } finally { pending.delete(d.id); updateControls(); if ($('#details-dialog').open) renderDetails(); } }
async function bulkAction(action) { const downloads = state.downloads.filter(action === 'pause' ? canPause : canResume); const results = await Promise.allSettled(downloads.map(d => call('action',{id:d.id,action:action === 'resume' && ['failed','cancelled'].includes(statusOf(d)) ? 'retry' : action}))); const failures = results.filter(r => r.status === 'rejected'); if (failures.length) notify(`${failures.length} operation(s) failed: ${messageOf(failures[0].reason)}`,true); try { await refresh(); } catch (error) { notify(messageOf(error),true); } }
async function removeCompleted() { const downloads = state.downloads.filter(d => statusOf(d) === 'completed'); if (!downloads.length || !window.confirm(`Delete ${downloads.length} completed download(s) from the list?\n\nThe downloaded files will remain on your PC.`)) return; const results = await Promise.allSettled(downloads.map(d => call('action',{id:d.id,action:'remove'}))); const failures = results.filter(r => r.status === 'rejected'); if (failures.length) notify(messageOf(failures[0].reason),true); try { await refresh(); } catch (error) { notify(messageOf(error),true); } }
function showDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }
function openAdd(text = '',scheduled = '') { pendingReviewId = null; $('#add-error').hidden = true; $('#download-urls').value = text; $('#download-mirrors').value = ''; $('#download-checksum').value = ''; $('#download-extract').checked = false; $('#download-quality').value = ''; $('#download-container').value = ''; $('#download-urls').readOnly = false; $('#download-filename').value = ''; $('#download-description').value = ''; $('#download-category').value = ''; rememberInput.checked = false; rememberInput.disabled = true; $('#download-schedule').value = scheduled; $('#add-directory').value = state.settings.defaultDirectory || ''; showDialog('#add-dialog'); $('#download-urls').focus(); }
function openReview(id) { if(progressMode)return; const d = state.downloads.find(item => item.id === id && item.needsReview); if (!d || dismissedReviews.has(id)) return; openAdd(d.url || ''); pendingReviewId = id; $('#download-urls').readOnly = true; $('#download-filename').value = d.filename || ''; $('#download-description').value = d.description || ''; $('#download-category').value = d.category || ''; rememberInput.disabled = !$('#download-category').value; $('#add-directory').value = d.directory || state.settings.defaultDirectory || ''; }
async function dismissReview() { if (!pendingReviewId) return; const id = pendingReviewId; dismissedReviews.add(id); pendingReviewId = null; try { await call('action',{id,action:'remove'}); await refresh(); } catch (error) { notify(messageOf(error),true); } }
function showDetails(id) { if (state.downloads.find(d => d.id === id)?.needsReview) { openReview(id); return; } if(!progressMode){call('openProgress',{id}).catch(e=>notify(messageOf(e),true));return;} detailId = id; $('#detail-speed-limit').value = state.settings.speedLimitKbps || 0; $('#notify-complete').checked = state.settings.notifyOnComplete !== false; $('#reveal-complete').checked = state.settings.revealOnComplete === true; $('#completion-result').textContent = ''; setDetailTab('status'); renderDetails(); showDialog('#details-dialog'); }
function renderDetails() { const d = state.downloads.find(d => d.id === detailId); if (!d) { $('#details-dialog').close(); return; } const status = statusOf(d), percent = percentage(d), content = $('#details-content'); $('#details-title').textContent = `${percent !== null ? `${Math.floor(percent)}% ` : ''}${d.filename || 'Download'}`; $('#transfer-source').textContent = d.url || ''; $('#transfer-source').title = d.url || ''; const names = {completed:'Finished',downloading:'Downloading',connecting:'Connecting…',paused:'Paused',queued:'Waiting',scheduled:'Scheduled',failed:'Failed',cancelled:'Cancelled',assembling:'Finishing…'}; const rows = [['Status',names[status] || status],['File size',sizeLabel(d)],['Downloaded',`${bytes(d.downloaded)}${percent !== null ? ` (${percent.toFixed(2)}%)` : ''}`],['Speed',status === 'downloading' ? `${bytes(d.speed)}/s` : '0 B/s'],['Time left',status === 'downloading' ? timeLeft(d) || 'Estimating…' : '—'],['Can resume',d.resumable === true ? 'Yes' : d.resumable === false ? 'No' : 'Checking…']]; if (numeric(d.duration)) rows.splice(1,0,['Video duration',`${Math.floor(d.duration/60)} min ${Math.floor(d.duration%60)} sec`]); if(d.streamProgress?.total&&status!=='completed')rows.push(['Segments',`${d.streamProgress.completed} / ${d.streamProgress.total}`]); if (d.scheduledAt && status === 'scheduled') rows.push(['Start at',date(d.scheduledAt)]); content.replaceChildren(); for (const [label,value] of rows) content.append(element('dt','',label),element('dd','',value)); const progress = $('#detail-progress'); if (percent === null && ['downloading','connecting'].includes(status)) progress.removeAttribute('value'); else progress.value = percent || 0; const segments = Array.isArray(d.connectionsProgress) ? d.connectionsProgress : []; const bars = $('#segment-bars'), map = $('#segment-map'); bars.replaceChildren(); map.replaceChildren(); for (let index = 0; index < segments.length; index++) { const segment = segments[index]; const row = element('tr'); const segmentStatus = segment.status === 'complete' || segment.status === 'completed' ? 'Completed.' : segment.status || (status === 'downloading' ? 'Downloading' : names[status] || status); row.append(element('td','',String(index + 1)),element('td','',bytes(segment.downloaded)),element('td','',segmentStatus)); bars.append(row); const bar = element('progress'); bar.max = 100; const total = numeric(segment.total); bar.value = total ? Math.min(100,numeric(segment.downloaded) / total * 100) : 0; bar.setAttribute('aria-label',`Connection ${index + 1} progress`); if (!total && status === 'downloading') bar.removeAttribute('value'); map.append(bar); } $('#segment-note').textContent = segments.length ? `${segments.length} connection(s)` : status === 'completed' ? 'Download completed.' : 'Connection progress appears when the transfer starts.'; $('#detail-error').textContent = d.error || ''; $('#detail-error').hidden = !d.error; $('#detail-open').disabled = status !== 'completed'; $('#detail-resume').disabled = !canResume(d) || pending.has(d.id); $('#detail-stop').disabled = !canPause(d) || pending.has(d.id); $('#detail-cancel').disabled = ['completed','cancelled'].includes(status) || pending.has(d.id); $('.transfer-buttons').hidden=status==='completed'; $('#download-complete-actions').hidden=status!=='completed'; $('#details-dialog').classList.toggle('is-complete',status==='completed'); }
function setDetailTab(name) { for (const tab of ['status','speed','completion']) { const active = tab === name; $(`#tab-${tab}`).classList.toggle('active-tab',active); $(`#tab-${tab}`).setAttribute('aria-selected',String(active)); $(`#${tab}-panel`).hidden = !active; } }
function setView(nextFilter,nextCategory = '') { filter = nextFilter; category = nextCategory; $$('[data-filter],[data-category]').forEach(button => { const active = nextCategory ? button.dataset.category === nextCategory : button.dataset.filter === nextFilter; button.classList.toggle('selected',active); if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); }); render(); }
function setSettingsTab(name) { for (const tab of ['general','connection','integrity','about']) { const active = tab === name; $(`#stab-${tab}`).classList.toggle('active-tab',active); $(`#stab-${tab}`).setAttribute('aria-selected',String(active)); $(`#spanel-${tab}`).hidden = !active; } }
function openSettings() { const settings = state.settings; setSettingsTab('general'); $('#set-notify').checked = settings.notifyOnComplete !== false; $('#set-reveal').checked = settings.revealOnComplete === true; $('#set-confirm').checked = settings.confirmBrowserDownloads !== false; $('#set-clipboard').checked = settings.watchClipboard !== false; $('#set-tray').checked = settings.closeToTray !== false; $('#set-login').checked = settings.launchAtLogin === true; $('#set-http2').checked = settings.http2 !== false; $('#set-adaptive').checked = settings.adaptive !== false; $('#set-verify').checked = settings.verifyHashes !== false; $('#set-workers').checked = settings.workerThreads !== false; $('#set-direct').checked = settings.directWrite !== false; $('#memory-budget').value = settings.memoryBudgetMb || 256; $('#default-directory').value = settings.defaultDirectory || ''; $('#max-concurrent').value = settings.maxConcurrent || 3; $('#connections').value = settings.connections || 8; $('#speed-limit').value = settings.speedLimitKbps || 0; $('#settings-error').hidden = true; showDialog('#settings-dialog'); }
function renderScheduler() { const downloads = state.downloads.filter(d => statusOf(d) === 'scheduled').sort((a,b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)); const list = $('#scheduled-list'); list.replaceChildren(); if (!downloads.length) list.append(element('p','field-help','No scheduled downloads.')); for (const d of downloads) { const row = element('div','scheduled-item'); const name = element('span','',d.filename); name.title = d.filename; row.append(name,element('time','',date(d.scheduledAt))); list.append(row); } }
function openScheduler() { renderScheduler(); showDialog('#scheduler-dialog'); }
async function openIntegration() { try { renderIntegration(await call('integration') || state.integration); showDialog('#integration-dialog'); } catch (error) { notify(messageOf(error),true); } }
const commands = {add:() => openAdd(),paste:async () => { try { openAdd(await call('clipboard')); } catch (error) { notify(messageOf(error),true); } },find:() => $('#search').focus(),settings:openSettings,integration:openIntegration,scheduler:openScheduler,pauseAll:() => bulkAction('pause'),resumeAll:() => bulkAction('resume'),removeCompleted};
commands.find = () => $('#search').focus();
commands.details = () => { if (selectedId) showDetails(selectedId); };
commands.remove = () => performAction(selected(),'remove');
commands.all = () => setView('all');
document.addEventListener('keydown', event => { if (event.ctrlKey && event.key.toLowerCase() === 'f') commands.find(); if (event.key === 'Escape' && document.activeElement === $('#search')) $('#search').blur(); });
$('#new-download').addEventListener('click',commands.add); $('#settings-button').addEventListener('click',openSettings); $('#integration-button').addEventListener('click',openIntegration); $('#scheduler-button').addEventListener('click',openScheduler); $('#pause-all').addEventListener('click',commands.pauseAll); $('#resume-all').addEventListener('click',commands.resumeAll); $('#remove-completed').addEventListener('click',removeCompleted);
$('#resume-selected').addEventListener('click',() => { const d = selected(); if (d?.needsReview) { openReview(d.id); return; } performAction(d,d && ['failed','cancelled'].includes(statusOf(d)) ? 'retry' : 'resume'); }); $('#stop-selected').addEventListener('click',() => performAction(selected(),'pause')); $('#remove-selected').addEventListener('click',() => performAction(selected(),'remove')); $('#open-selected').addEventListener('click',() => performAction(selected(),'open')); $('#reveal-selected').addEventListener('click',() => performAction(selected(),'reveal')); $('#details-selected').addEventListener('click',() => { if (selectedId) showDetails(selectedId); });
const detailDownload = () => state.downloads.find(d => d.id === detailId);
$('#detail-open').addEventListener('click',() => performAction(detailDownload(),'open')); $('#detail-folder').addEventListener('click',() => performAction(detailDownload(),'reveal')); $('#detail-stop').addEventListener('click',() => performAction(detailDownload(),'pause')); $('#detail-cancel').addEventListener('click',() => performAction(detailDownload(),'cancel')); $('#detail-resume').addEventListener('click',() => { const d = detailDownload(); performAction(d,d && ['failed','cancelled'].includes(statusOf(d)) ? 'retry' : 'resume'); });
$('#toggle-details').addEventListener('click',async() => { const details = $('#connection-details'); details.hidden = !details.hidden; document.body.classList.toggle('details-collapsed',details.hidden); $('#toggle-details').textContent = details.hidden ? 'Show connections' : 'Hide connections'; if(progressMode)try{await call('resizeProgress',{expanded:!details.hidden});}catch(error){notify(messageOf(error),true);} });
for (const tab of ['status','speed','completion']) $(`#tab-${tab}`).addEventListener('click',() => setDetailTab(tab));
$('#detail-speed-form').addEventListener('submit',async event => { event.preventDefault(); $('#detail-speed-error').hidden = true; try { await call('settings',{speedLimitKbps:Number($('#detail-speed-limit').value)}); await refresh(); notify('Global speed limit saved.'); } catch (error) { $('#detail-speed-error').textContent = messageOf(error); $('#detail-speed-error').hidden = false; } });
$('#completion-form').addEventListener('submit',async event => { event.preventDefault(); try { await call('settings',{notifyOnComplete:$('#notify-complete').checked,revealOnComplete:$('#reveal-complete').checked}); await refresh(); $('#completion-result').textContent = ' Saved.'; } catch (error) { $('#completion-result').textContent = ` ${messageOf(error)}`; } });
$('#scheduler-start').addEventListener('click',commands.resumeAll); $('#scheduler-stop').addEventListener('click',commands.pauseAll); $('#schedule-new').addEventListener('click',() => { $('#scheduler-dialog').close(); const future = new Date(Date.now() + 3600000); openAdd('',new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0,16)); });
$$('[data-filter]').forEach(button => button.addEventListener('click',() => setView(button.dataset.filter))); $$('[data-category]').forEach(button => button.addEventListener('click',() => setView('all',button.dataset.category))); const sortModes = {newest:['createdAt',false],oldest:['createdAt',true],name:['filename',true],size:['total',false],status:['status',true]};
$('#sort-select').addEventListener('change',event => { [sort,ascending] = sortModes[event.target.value] || sortModes.newest; render(); }); $('#search').addEventListener('input',event => { searchTerm = event.target.value.trim().toLowerCase(); render(); });
const tableScroll=$('#table-scroll'),selectionRectangle=$('#selection-rectangle');
const tablePoint=event=>{const bounds=tableScroll.getBoundingClientRect();return{x:event.clientX-bounds.left+tableScroll.scrollLeft,y:event.clientY-bounds.top+tableScroll.scrollTop};};
tableScroll.addEventListener('pointerdown',event=>{
  if(event.button!==0||event.target.closest('thead')||event.target.closest('button'))return;
  const point=tablePoint(event),row=event.target.closest('.download-row');
  selectionDrag={pointerId:event.pointerId,startX:point.x,startY:point.y,row,base:(event.ctrlKey||event.metaKey)?new Set(selectedIds):new Set(),moved:false};
  tableScroll.setPointerCapture(event.pointerId);event.preventDefault();
});
tableScroll.addEventListener('pointermove',event=>{
  if(!selectionDrag||selectionDrag.pointerId!==event.pointerId)return;
  const point=tablePoint(event),dx=point.x-selectionDrag.startX,dy=point.y-selectionDrag.startY;
  if(!selectionDrag.moved&&Math.hypot(dx,dy)<4)return;
  selectionDrag.moved=true;
  const left=Math.min(selectionDrag.startX,point.x),top=Math.min(selectionDrag.startY,point.y),right=Math.max(selectionDrag.startX,point.x),bottom=Math.max(selectionDrag.startY,point.y);
  Object.assign(selectionRectangle.style,{left:`${left}px`,top:`${top}px`,width:`${Math.max(1,right-left)}px`,height:`${Math.max(1,bottom-top)}px`});selectionRectangle.hidden=false;
  selectedIds.clear();for(const id of selectionDrag.base)selectedIds.add(id);
  const viewport=tableScroll.getBoundingClientRect();
  for(const row of $$('.download-row')){const rect=row.getBoundingClientRect(),rowLeft=rect.left-viewport.left+tableScroll.scrollLeft,rowTop=rect.top-viewport.top+tableScroll.scrollTop;if(rowLeft<right&&rowLeft+rect.width>left&&rowTop<bottom&&rowTop+rect.height>top)selectedIds.add(row.dataset.id);}
  selectedId=selectedIds.values().next().value||null;paintSelection();event.preventDefault();
});
// The list captures the pointer so drag-selection works. Chromium then delivers the final click (and double-click) to the list
// instead of the row under the pointer, so selecting and opening details is decided here, on pointer-up.
let lastTap = {id:null,time:0};
function tapRow(id,event){
  const additive = event.ctrlKey || event.metaKey; selectDownload(id,{additive,toggle:additive});
  const now = Date.now();
  if (lastTap.id === id && now - lastTap.time < 400) { lastTap = {id:null,time:0}; showDetails(id); } else lastTap = {id,time:now};
}
function finishMarquee(event){if(!selectionDrag||selectionDrag.pointerId!==event.pointerId)return;const moved=selectionDrag.moved,row=selectionDrag.row;try{tableScroll.releasePointerCapture(event.pointerId);}catch{}selectionDrag=null;selectionRectangle.hidden=true;if(moved){suppressRowClick=true;setTimeout(()=>{suppressRowClick=false;},0);}else if(row)tapRow(row.dataset.id,event);else selectDownload(null);}
tableScroll.addEventListener('pointerup',finishMarquee);tableScroll.addEventListener('pointercancel',finishMarquee);
$('#table-scroll').addEventListener('keydown',event => { if (!visibleDownloads.length) return; const index = visibleDownloads.findIndex(d => d.id === selectedId); if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleDownloads.length - 1 : Math.max(0,Math.min(visibleDownloads.length - 1,index + (event.key === 'ArrowDown' ? 1 : -1))); selectDownload(visibleDownloads[next].id); $$('.download-row').find(row => row.dataset.id === selectedId)?.scrollIntoView({block:'nearest'}); } if (event.key === 'Enter' && selectedId) showDetails(selectedId); if (event.key === 'Delete') performAction(selected(),'remove'); });
$('#dismiss-toast').addEventListener('click',() => { $('#toast').hidden = true; }); $$('[data-close]').forEach(button => button.addEventListener('click',() => { const dialog = button.closest('dialog'); dialog.close(); if (dialog.id === 'add-dialog') dismissReview(); })); $('#add-dialog').addEventListener('cancel',() => dismissReview()); document.addEventListener('keydown',event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!$$('dialog[open]').length) openAdd(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !$$('dialog[open]').length) { event.preventDefault(); $('#search').focus(); } });
$('#paste-button').addEventListener('click',async () => { try { $('#download-urls').value = await call('clipboard'); $('#download-urls').focus(); } catch (error) { $('#add-error').textContent = messageOf(error); $('#add-error').hidden = false; } }); $('#add-browse').addEventListener('click',async () => { try { const path = await call('chooseDirectory'); if (typeof path === 'string' && path) $('#add-directory').value = path; } catch (error) { $('#add-error').textContent = messageOf(error); $('#add-error').hidden = false; } });
$('#download-category').addEventListener('change',event => { const folder = state.settings.categoryDirectories?.[event.target.value]; if (folder) $('#add-directory').value = folder; rememberInput.disabled = !event.target.value; if (rememberInput.disabled) rememberInput.checked = false; });
$('#add-form').addEventListener('submit',async event => {
  event.preventDefault();
  const errorElement = $('#add-error'); errorElement.hidden = true;
  const urls = $('#download-urls').value.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
  const filename = $('#download-filename').value.trim(), scheduled = $('#download-schedule').value;
  try {
    if (!urls.length) throw new Error('Enter at least one download address.');
    for (const url of urls) { let parsed; try { parsed = new URL(url); } catch { throw new Error(`Invalid address: ${url}`); } if (!['http:','https:'].includes(parsed.protocol)) throw new Error('Download addresses must begin with http:// or https://.'); }
    if (filename && urls.length !== 1) throw new Error('A custom file name can only be used for a single address.');
    const mirrors = $('#download-mirrors').value.split(/\r?\n/).map(url => url.trim()).filter(Boolean), checksum = $('#download-checksum').value.trim();
    for (const url of mirrors) { let parsed; try { parsed = new URL(url); } catch { throw new Error(`Invalid mirror address: ${url}`); } if (!['http:','https:'].includes(parsed.protocol)) throw new Error('Mirror addresses must begin with http:// or https://.'); }
    if ((mirrors.length || checksum) && urls.length !== 1) throw new Error('Mirrors and a checksum can only be used with a single address.');
    const scheduledAt = scheduled ? new Date(scheduled).toISOString() : undefined;
    if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now()) throw new Error('Choose a future start time or leave Start at empty.');
    $('#add-submit').disabled = true; $('#add-later').disabled = true;
    const directory = $('#add-directory').value, selectedCategory = $('#download-category').value, description = $('#download-description').value.trim();
    if (rememberInput.checked && selectedCategory && directory) await call('settings',{categoryDirectories:{...state.settings.categoryDirectories,[selectedCategory]:directory}});
    const extract = $('#download-extract').checked, container = $('#download-container').value, quality = $('#download-quality').value;
    if (extract && urls.length !== 1) throw new Error('Page video extraction works with a single address at a time.');
    const data = {...(extract ? {extract: true, ...(quality ? {extractFormat: quality} : {}), ...(container ? {outputFormat: container} : {})} : {}),...(mirrors.length ? {mirrors} : {}),...(checksum ? {checksum} : {}),...(filename ? {filename} : {}),...(scheduledAt ? {scheduledAt} : {}),...(directory ? {directory} : {}),...(selectedCategory ? {category:selectedCategory} : {}),description,queueOnly:event.submitter?.dataset.queueOnly === 'true'};
    const ids = pendingReviewId ? await call('review',{id:pendingReviewId,...data}) : await call('add',{urls,...data});
    pendingReviewId = null; $('#add-dialog').close(); setView('all'); await refresh();
    if (!data.queueOnly && !scheduledAt && ids?.length === 1) { selectDownload(ids[0]); showDetails(ids[0]); }
  } catch (error) { errorElement.textContent = messageOf(error); errorElement.hidden = false; }
  finally { $('#add-submit').disabled = false; $('#add-later').disabled = false; }
});
$('#choose-directory').addEventListener('click',async () => { try { const path = await call('chooseDirectory'); if (typeof path === 'string' && path) $('#default-directory').value = path; } catch (error) { $('#settings-error').textContent = messageOf(error); $('#settings-error').hidden = false; } }); $('#settings-form').addEventListener('submit',async event => { event.preventDefault(); const button = $('button[type=submit]',event.target); $('#settings-error').hidden = true; button.disabled = true; try { await call('settings',{defaultDirectory:$('#default-directory').value.trim(),maxConcurrent:Number($('#max-concurrent').value),connections:Number($('#connections').value),speedLimitKbps:Number($('#speed-limit').value),notifyOnComplete:$('#set-notify').checked,revealOnComplete:$('#set-reveal').checked,confirmBrowserDownloads:$('#set-confirm').checked,watchClipboard:$('#set-clipboard').checked,closeToTray:$('#set-tray').checked,launchAtLogin:$('#set-login').checked,http2:$('#set-http2').checked,adaptive:$('#set-adaptive').checked,verifyHashes:$('#set-verify').checked,workerThreads:$('#set-workers').checked,directWrite:$('#set-direct').checked,memoryBudgetMb:Number($('#memory-budget').value)}); await refresh(); $('#settings-dialog').close(); } catch (error) { $('#settings-error').textContent = messageOf(error); $('#settings-error').hidden = false; } finally { button.disabled = false; } });
for (const tab of ['general','connection','integrity','about']) $(`#stab-${tab}`).addEventListener('click',() => setSettingsTab(tab));
$('#open-about').addEventListener('click',async () => { try { await call('about'); } catch (error) { $('#settings-error').textContent = messageOf(error); $('#settings-error').hidden = false; } });
async function start() { try { await refresh(); if (typeof api.subscribe === 'function') unsubscribe = api.subscribe(snapshot => { if (snapshot?.downloads) acceptSnapshot(snapshot); else refresh().catch(error => notify(messageOf(error),true)); }); if (typeof api.onCommand === 'function') unsubscribeCommands = api.onCommand(async payload => { const command = typeof payload === 'string' ? payload : payload?.command; if (command === 'clipboardLink') { if (!$$('dialog[open]').length && typeof payload.text === 'string') { openAdd(payload.text); if (payload.extract) { $('#download-extract').checked = true; document.querySelector('.advanced-fields').open = true; } } return; }
 if (command === 'reviewDownload') { try { await refresh(); if (!$$('dialog[open]').length) openReview(payload.id); } catch (error) { notify(messageOf(error),true); } return; } if (!$$('dialog[open]').length || ['pauseAll','resumeAll','removeCompleted'].includes(command)) commands[command]?.(); }); } catch (error) { $('#download-list').setAttribute('aria-busy','false'); $('#list-count').textContent = 'Download service unavailable'; $('#connection-label').textContent = 'Not running'; $('.engine-state').dataset.state = 'down'; notify(messageOf(error),true); } }
window.addEventListener('beforeunload',() => { if (typeof unsubscribe === 'function') unsubscribe(); if (typeof unsubscribeCommands === 'function') unsubscribeCommands(); });
if(progressMode){
  $('#details-dialog').addEventListener('close',()=>call('closeProgress'));
  new MutationObserver(()=>{document.title=$('#details-title').textContent;}).observe($('#details-title'),{childList:true,characterData:true,subtree:true});
  detailId=progressMode;showDialog('#details-dialog');
}
start().then(async()=>{
  if(progressMode){showDetails(progressMode);return;}
  if(state.integration.packaged && !state.integration.connectedBrowsers?.length && !localStorage.getItem('browser-setup-introduced') && !$$('dialog[open]').length){
    await openIntegration();
    localStorage.setItem('browser-setup-introduced','1');
  }
});
