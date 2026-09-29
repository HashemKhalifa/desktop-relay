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
    const message = document.getElementById('loading-message');
    if (message) {
      document.querySelector('main h1').textContent = 'Usage unavailable';
      message.textContent = status.textContent === 'Open again with dc-relayctl dashboard'
        ? 'Dashboard sign-in expired or is missing. Run bin/dc-relayctl dashboard on this Mac to reconnect. Your usage history is preserved.'
        : 'Cannot load usage from the relay. Retrying automatically; no counts are available yet.';
    }
  } finally {
    running = false;
  }
}

void refresh();
function refreshVisible() {
  if (!document.hidden) void refresh();
}

document.addEventListener('visibilitychange', refreshVisible);
window.addEventListener('focus', refreshVisible);
setInterval(refreshVisible, 10000);
