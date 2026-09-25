const status = document.getElementById('connection-status');
let running = false;

async function refresh() {
  if (running) return;
  running = true;
  try {
    const key = location.hash.slice(1);
    if (key) {
      history.replaceState(null, '', '/');
      const response = await fetch('/session', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Open again with dc-relayctl dashboard');
    }
    const response = await fetch('/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (response.status === 401) throw new Error('Open again with dc-relayctl dashboard');
    if (!response.ok) throw new Error('Disconnected · retrying');
    const snapshot = await response.json();
    const next = new DOMParser().parseFromString(snapshot.html, 'text/html').querySelector('main');
    if (!next) throw new Error('Invalid dashboard response');
    const expanded = document.querySelector('details')?.open;
    document.querySelector('main').replaceWith(next);
    next.querySelector('details').open = expanded ?? false;
    status.textContent = `${snapshot.status.upstream === 'running' ? 'Connected' : 'Upstream ' + snapshot.status.upstream} · ${snapshot.status.sessions} MCP sessions`;
    status.dataset.state = snapshot.status.upstream === 'running' ? 'connected' : 'offline';
  } catch (error) {
    status.textContent = error.name === 'TimeoutError' || error instanceof TypeError ? 'Disconnected · retrying' : error.message;
    status.dataset.state = 'offline';
  } finally {
    running = false;
  }
}

void refresh();
setInterval(refresh, 10000);
