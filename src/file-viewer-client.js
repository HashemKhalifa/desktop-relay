import { App } from '@modelcontextprotocol/ext-apps';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';

for (const [name, grammar] of Object.entries({ javascript, typescript, python, json, bash, go, rust })) hljs.registerLanguage(name, grammar);
const languages = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', json: 'json', sh: 'bash', bash: 'bash', go: 'go', rs: 'rust' };

const element = id => document.getElementById(id);
const app = new App({ name: 'Desktop Relay file viewer', version: '1.0.0' }, {}, { autoResize: true });
let filePath = '';
let offset = 0;
let page;
let busy = false;
let serial = 0;
let fullscreen = false;

function setDisplayMode(mode) {
  fullscreen = mode === 'fullscreen';
  document.body.classList.toggle('fullscreen', fullscreen);
  const label = fullscreen ? 'Exit expanded view' : 'Expand viewer';
  element('fullscreen').setAttribute('aria-label', label);
  element('fullscreen').title = label;
}

function notice(message, error = false) {
  element('notice').hidden = !message;
  element('notice').textContent = message;
  element('notice').dataset.error = String(error);
}

function controls() {
  for (const id of ['refresh', 'line', 'page-size', 'jump']) element(id).disabled = busy;
  element('previous').disabled = busy || !page || page.firstLine === null || page.firstLine <= 1;
  element('next').disabled = busy || !page || page.nextOffset === null;
  element('copy').disabled = busy || !page;
  element('download').disabled = busy || !page;
}

function renderText() {
  const fragment = document.createDocumentFragment();
  const query = element('search').value.toLocaleLowerCase();
  let matches = 0;
  const language = languages[filePath.split('.').pop().toLowerCase()];
  (page?.readLines === 0 ? [] : (page?.text ?? '').split('\n')).forEach((line, index) => {
    const row = document.createElement('div');
    row.className = 'code-row';
    const number = document.createElement('span');
    number.className = 'line-number';
    number.textContent = page?.firstLine === null ? '' : String((page?.firstLine ?? 1) + index);
    number.setAttribute('aria-hidden', 'true');
    const source = document.createElement('span');
    source.className = 'source-line';
    if (!query && language) {
      // highlight.js escapes source text before producing its span markup.
      source.innerHTML = hljs.highlight(line, { language, ignoreIllegals: true }).value || '\u200b';
      row.append(number, source);
      fragment.append(row);
      return;
    }
    let from = 0;
    let match = query ? line.toLocaleLowerCase().indexOf(query) : -1;
    while (match !== -1) {
      source.append(document.createTextNode(line.slice(from, match)));
      const mark = document.createElement('mark');
      mark.textContent = line.slice(match, match + query.length);
      source.append(mark);
      from = match + query.length;
      matches++;
      match = line.toLocaleLowerCase().indexOf(query, from);
    }
    source.append(document.createTextNode(line.slice(from) || (line === '' ? '\u200b' : '')));
    row.append(number, source);
    fragment.append(row);
  });
  element('code').replaceChildren(fragment);
  element('matches').textContent = query ? `${matches} found` : '';
}

async function load(nextOffset = offset) {
  if (busy) return;
  busy = true;
  const request = ++serial;
  const length = Number(element('page-size').value);
  controls();
  notice('Reading from your Mac…');
  try {
    const result = await app.callServerTool({ name: 'browse_relay_file', arguments: { path: filePath, offset: nextOffset, length } });
    if (request !== serial) return;
    if (result.isError) throw new Error(result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'File could not be read.');
    const view = result._meta?.fileView;
    if (!view || typeof view.text !== 'string' || view.path !== filePath) throw new Error('Preview data was not delivered. Refresh the Desktop Relay connection in ChatGPT and try again.');
    const changed = page && offset === nextOffset && page.length === length && page.hash !== view.hash;
    page = { ...view, length };
    offset = page.firstLine === null ? nextOffset : page.firstLine - 1;
    element('range').textContent = page.firstLine !== null
      ? page.readLines === 0 ? 'Empty range' : `Lines ${page.firstLine}–${page.firstLine + page.readLines - 1}${page.totalLines === null ? '' : ` of ${page.totalLines}`}`
      : 'Document preview · line navigation unavailable';
    element('line').value = String(Math.max(1, offset + 1));
    element('read-at').textContent = `Read ${new Date(page.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    renderText();
    element('code').scrollTop = 0;
    notice(changed ? 'This range changed since your last read.' : '');
  } catch (error) {
    if (request === serial) notice(`${error.message}${page ? ' Showing the previous successful read.' : ''}`, true);
  } finally {
    if (request === serial) { busy = false; controls(); }
  }
}

element('open').addEventListener('click', () => {
  const opening = element('workspace').hidden;
  element('workspace').hidden = !opening;
  element('card-note').hidden = opening;
  element('open').textContent = opening ? 'Close preview' : 'Open file ↗';
  element('open').setAttribute('aria-expanded', String(opening));
  if (opening && !page) void load();
});
element('refresh').addEventListener('click', () => void load());
element('previous').addEventListener('click', () => void load(Math.max(0, offset - Number(element('page-size').value))));
element('next').addEventListener('click', () => { if (page?.nextOffset !== null) void load(page.nextOffset); });
function jumpToLine() {
  if (element('line').checkValidity()) void load(Number(element('line').value) - 1);
}
element('jump').addEventListener('click', jumpToLine);
element('line').addEventListener('keydown', event => { if (event.key === 'Enter') jumpToLine(); });
element('page-size').addEventListener('change', () => void load());
element('search').addEventListener('input', renderText);
element('wrap').addEventListener('click', () => element('wrap').setAttribute('aria-pressed', String(element('code').classList.toggle('wrap'))));
element('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(page.text); notice('Displayed range copied.'); }
  catch { notice('Clipboard access is unavailable. Select the text to copy it.', true); }
});
element('download').addEventListener('click', () => {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([page.text], { type: 'text/plain;charset=utf-8' }));
  link.href = url;
  link.download = `${filePath.split('/').pop()}.${page.firstLine === null ? 'preview' : `lines-${page.firstLine}-${page.firstLine + page.readLines - 1}`}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
element('fullscreen').addEventListener('click', async () => {
  try {
    const result = await app.requestDisplayMode({ mode: fullscreen ? 'inline' : 'fullscreen' });
    setDisplayMode(result.mode);
  } catch { notice('Expanded view is unavailable in this host. You can still browse here.'); }
});
app.onhostcontextchanged = context => {
  if (context.theme) document.documentElement.dataset.theme = context.theme;
  if (context.displayMode) setDisplayMode(context.displayMode);
};
app.ontoolinput = ({ arguments: args }) => {
  serial++;
  busy = false;
  page = undefined;
  filePath = typeof args?.path === 'string' ? args.path : '';
  offset = Number.isSafeInteger(args?.offset) ? Math.max(-200, args.offset) : 0;
  const name = filePath.split('/').pop() || 'File preview';
  element('filename').textContent = name;
  const parts = filePath.split('/').filter(Boolean);
  element('file-path').textContent = parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : filePath;
  element('file-path').title = filePath;
  element('file-type').textContent = name.includes('.') ? name.split('.').pop().slice(0, 8).toUpperCase() : 'FILE';
  element('open').disabled = !filePath.startsWith('/') || args?.isUrl === true;
  element('workspace').hidden = true;
  element('card-note').hidden = false;
  element('open').textContent = 'Open file ↗';
  element('open').setAttribute('aria-expanded', 'false');
  element('code').replaceChildren();
  controls();
};
app.ontoolresult = result => {
  if (result.isError) element('card-note').textContent = 'The file read failed. See the tool response for details.';
};
app.connect().then(() => {
  document.documentElement.dataset.theme = app.getHostContext()?.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  setDisplayMode(app.getHostContext()?.displayMode ?? 'inline');
}).catch(() => { element('card-note').textContent = 'Open this viewer from a Desktop Relay file read in ChatGPT.'; });
