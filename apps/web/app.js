const icons = {
  dashboard:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  connections:
    '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/>',
  remote:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  box: '<path d="m12 3 9 5v8l-9 5-9-5V8Zm0 10v8M3 8l9 5 9-5M7 5l10 6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.box}</svg>`;
const e = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const screens = [
  ['dashboard', 'Dashboard', 'dashboard'],
  ['workspaces', 'Workspaces', 'folder'],
  ['connections', 'Connections', 'connections'],
  ['remote', 'Remote access', 'remote'],
  ['permissions', 'Permissions', 'shield'],
  ['activity', 'Activity', 'activity'],
  ['changes', 'Changes', 'folder'],
  ['settings', 'Settings', 'settings'],
];
const permissionNames = {
  read: 'Read workspace',
  write: 'Modify workspace',
  execute: 'Execute commands',
  git: 'Git',
  network: 'Network access',
};
let state,
  csrf,
  screen = currentScreen(),
  remoteTab,
  consentSelection = new Set(),
  providers = [],
  lastFingerprint = '',
  busy = false,
  toastTimer,
  activeFilter = '',
  diagnostics,
  review;
function currentScreen() {
  return location.hash.startsWith('#oauth=') ? 'oauth' : location.hash.slice(1) || 'dashboard';
}
const isLocalDashboard = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const app = document.querySelector('#app');
const active = () => state.workspaces.find((w) => w.id === state.activeWorkspaceId);
const endpoint = () =>
  `${state.tunnel.publicUrl || `http://127.0.0.1:${state.runtime.mcpPort}`}/mcp`;
const validTokens = () =>
  state.tokens.filter(
    (t) =>
      !t.revokedAt &&
      (!t.expiresAt || Date.parse(t.expiresAt) > Date.now()) &&
      (t.oauth
        ? t.oauth.workspaceIds.some((id) => state.workspaces.some((w) => w.id === id))
        : t.workspaceId === state.activeWorkspaceId),
  );
const pill = (text, type = '') =>
  `<span class="status-pill ${type}"><span class="dot ${type === 'warn' ? 'warn' : type ? 'off' : ''}"></span>${e(text)}</span>`;
const button = (text, action, style = '', data = '') =>
  `<button class="button ${style}" data-action="${action}" ${data}>${text}</button>`;
const copyField = (value) =>
  `<div class="endpoint"><code>${e(value)}</code><button class="copy" aria-label="Copy" data-action="copy" data-value="${e(value)}">${icon('copy')}</button></div>`;
function toast(text, error = false) {
  const el = document.querySelector('#toast');
  el.textContent = text;
  el.className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 5000);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { 'x-mcp-code-csrf': csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (response.status === 401 && !isLocalDashboard()) {
    location.reload();
    return;
  }
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
async function refresh(force = false) {
  try {
    state = await api('/status');
    const fingerprint = JSON.stringify(state);
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (force || (!editing && !busy && fingerprint !== lastFingerprint)) {
      render();
      lastFingerprint = fingerprint;
    }
  } catch (error) {
    if (!state)
      app.innerHTML = `<div class="loading">${e(error.message)} Reload to reconnect.</div>`;
  }
}
function heading(title, description, actions = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="actions">${actions}</div></div>`;
}
function panel(title, body, action = '', extra = '') {
  return `<section class="panel ${extra}"><div class="panel-head"><h2>${title}</h2>${action}</div>${body}</section>`;
}
function empty(title, description, action = '', symbol = 'folder') {
  return `<div class="empty">${icon(symbol)}<strong>${title}</strong>${description}${action}</div>`;
}
function permissionTags(p) {
  return `<div class="permission-summary">${
    Object.keys(permissionNames)
      .filter((k) => p[k])
      .map((k) => `<span class="permission-tag">${e(permissionNames[k])}</span>`)
      .join('') || '<span class="help">No access</span>'
  }</div>`;
}
function activityTable(entries) {
  if (!entries.length)
    return empty(
      'Your activity will appear here',
      'Connect a client and run a workspace tool to begin.',
      '',
      'activity',
    );
  return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Tool / command</th><th>Client</th><th>Result</th></tr></thead><tbody>${entries.map((a) => `<tr><td class="time" title="${e(a.timestamp)}">${new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td><td><code>${e(a.command || a.tool)}</code>${a.command ? `<div class="help">${e(a.tool)}</div>` : ''}</td><td>${e(a.client)}</td><td>${pill(a.result === 'allowed' ? (a.exitCode === undefined ? 'Allowed' : `Exit ${a.exitCode}`) : a.result, a.result === 'error' ? 'error' : a.result === 'denied' ? 'warn' : a.exitCode ? 'warn' : '')}</td></tr>`).join('')}</tbody></table></div>`;
}
function setup() {
  const done = [!!active(), state.sandbox.imageReady, validTokens().length > 0];
  if (done.every(Boolean)) return '';
  return panel(
    'Set up your local workspace',
    `<div class="setup-steps">${[
      [
        'Choose a project',
        'Only this folder is shared with your AI client.',
        'workspaces',
        'Select folder',
      ],
      [
        'Prepare the sandbox',
        'An isolated development image keeps your host private.',
        'dashboard',
        'Build image',
      ],
      [
        'Connect your client',
        'Create a workspace token and copy the MCP endpoint.',
        'connections',
        'Create token',
      ],
    ]
      .map(
        (s, i) =>
          `<div class="setup-step"><span class="step-circle ${done[i] ? 'done' : ''}">${done[i] ? '✓' : i + 1}</span><div><h3>${s[0]}</h3><p>${s[1]}</p>${!done[i] ? (i === 1 ? `<button class="button plain small" data-action="build">${s[3]}</button>` : `<a href="#${s[2]}">${s[3]}</a>`) : '<span class="help">Ready</span>'}</div></div>`,
      )
      .join('')}</div>`,
    '',
    'setup',
  );
}
function jobsPanel() {
  const jobs = state.jobs.filter((j) => ['running', 'awaiting-approval'].includes(j.status));
  if (!jobs.length) return '';
  return panel(
    'Commands in progress',
    jobs
      .map(
        (j) =>
          `<div class="job ${j.status === 'awaiting-approval' ? 'approval' : ''}"><div class="job-top"><span>${e(j.client)} · ${e(state.workspaces.find((w) => w.id === j.workspaceId)?.name)}</span>${pill(j.status === 'awaiting-approval' ? 'Needs your approval' : 'Running', j.status === 'awaiting-approval' ? 'warn' : '')}</div><pre>${e(j.command)}</pre><div class="actions">${j.status === 'awaiting-approval' ? button('Approve command', 'approve', 'primary small', `data-id="${j.id}"`) + button('Deny', 'deny', 'small', `data-id="${j.id}"`) : button('Cancel command', 'cancel', 'danger small', `data-id="${j.id}"`)}</div></div>`,
      )
      .join(''),
  );
}
function dashboard() {
  const w = active();
  return (
    heading(
      'Your local coding workspace',
      'Give your AI client a place to work. Keep execution on your machine.',
      button(
        `${icon('folder')} ${w ? 'Manage workspaces' : 'Select workspace'}`,
        w ? 'go-workspaces' : 'workspace-modal',
        'primary',
      ),
    ) +
    setup() +
    (!state.sandbox.available
      ? `<div class="notice warning"><div><strong>Docker is not available</strong>${e(state.sandbox.detail)} MCP Code will keep command execution disabled until isolation is ready.</div>${button('Check again', 'refresh', 'small')}</div>`
      : '') +
    `<div class="stack">${jobsPanel()}${panel('Workspace runtime', `<div class="runtime-map"><div class="runtime-node"><div class="node-icon">${icon('folder')}</div><h3>${e(w?.name || 'No workspace selected')}</h3><p>${w ? e(w.path) : 'Select a local project folder'}</p>${pill(w ? 'Active workspace' : 'Not configured', w ? '' : 'off')}</div><div class="connector"></div><div class="runtime-node"><div class="node-icon">${icon('box')}</div><h3>Isolated environment</h3><p>Docker · /workspace<br>Ephemeral command containers</p>${pill(state.sandbox.imageReady ? 'Ready' : state.sandbox.available ? 'Image needed' : 'Unavailable', state.sandbox.imageReady ? '' : 'warn')}</div><div class="connector"></div><div class="runtime-node"><div class="node-icon">${icon('connections')}</div><h3>MCP endpoint</h3><p>${state.tunnel.state === 'connected' ? 'Remote access connected' : 'Local connection'}<br>${state.clients.length} recent ${state.clients.length === 1 ? 'client' : 'clients'}</p>${pill(state.runtime.mcpEnabled ? 'Listening' : 'Stopped', state.runtime.mcpEnabled ? '' : 'off')}</div></div><div class="panel-footer actions">${button(state.runtime.mcpEnabled ? 'Stop MCP' : 'Start MCP', 'toggle-mcp', 'small')}${button('Change workspace', 'go-workspaces', 'small')}${button('Open activity', 'go-activity', 'small')}</div>`, pill('Local execution'))}<div class="grid two">${panel('Recent activity', activityTable(state.activity.slice(0, 6)), `<a href="#activity" class="button plain small">View all activity</a>`)}${panel('Connection details', `<div class="panel-body"><span class="field-label">MCP endpoint</span>${copyField(endpoint())}<div class="meta-row"><span>Authentication</span><strong>Bearer token required</strong></div><div class="meta-row"><span>Remote access</span><strong>${state.tunnel.state === 'connected' ? e(providers.find((p) => p.id === state.tunnel.provider)?.name || state.tunnel.provider) + ' connected' : 'Local only'}</strong></div><div class="meta-row"><span>Sandbox network</span><strong>${w?.permissions.network ? 'Allowed' : 'Blocked'}</strong></div><p class="connection-note">Your project and command execution stay on this computer. Choose which client gets access.</p><a href="#connections" class="button plain">Manage connections ${icon('arrow')}</a></div>`)}</div>${state.imageBuild.running || state.imageBuild.log ? panel('Development image build', `<div class="panel-body"><pre class="snippet">${e(state.imageBuild.log || 'Starting build…')}</pre></div>`, pill(state.imageBuild.running ? 'Building' : 'Finished', state.imageBuild.running ? 'warn' : 'off')) : ''}</div><div class="footer-note">${icon('lock')} Only the selected workspace is mounted. Your host credentials stay outside the sandbox.</div>`
  );
}
function workspaces() {
  return (
    heading(
      'Workspaces',
      'Save your projects here. Manual tokens use the active project; OAuth clients use approved projects.',
      button(`${icon('plus')} Add workspace`, 'workspace-modal', 'primary'),
    ) +
    panel(
      'Your projects',
      state.workspaces.length
        ? state.workspaces
            .map(
              (w) =>
                `<div class="workspace-row"><div><h3>${e(w.name)} ${w.id === state.activeWorkspaceId ? pill('Active') : ''}</h3><p class="workspace-path">${e(w.path)}</p>${permissionTags(w.permissions)}</div><div class="actions">${w.id !== state.activeWorkspaceId ? button('Activate', 'activate', 'primary small', `data-id="${w.id}"`) : '<a class="button small" href="#permissions">Permissions</a>'}${button('Resources', 'resources', 'small', `data-id="${w.id}"`)}${button('Rename', 'rename', 'small', `data-id="${w.id}"`)}${button('Remove', 'remove-workspace', 'danger small', `data-id="${w.id}"`)}</div></div>`,
            )
            .join('')
        : empty(
            'Choose your first project',
            'Select a folder from this computer to create an isolated coding workspace.',
            button('Select folder', 'workspace-modal', 'primary'),
          ),
    ) +
    `<div class="notice"><div><strong>Workspace access stays scoped</strong>Manual tokens follow the active project. OAuth agents can choose among the workspaces you approved. Each command mounts one workspace.</div></div>`
  );
}
function registeredClients() {
  return panel(
    'Registered OAuth clients',
    (state.oauthClients || [])
      .map(
        (c) =>
          `<div class="token-row"><div><h3>${e(c.client_name)}</h3><p>${e(c.client_id)}</p><p class="help">${c.redirect_uris.map(e).join('<br>')}</p></div>${button('Remove client', 'remove-oauth-client', 'danger small', `data-id="${e(c.client_id)}"`)}</div>`,
      )
      .join('') || '<div class="panel-body">No registered OAuth clients.</div>',
  );
}
function connections() {
  const tokens = state.tokens.filter((t) => !t.revokedAt);
  return (
    heading(
      'Connections',
      'Approve OAuth clients or create a manual token. You choose the workspaces each agent can access.',
      button(`${icon('plus')} Create access token`, 'token-modal', 'primary'),
    ) +
    registeredClients() +
    oauthRequestsPanel() +
    `<div class="grid two">${panel(
      'Client access',
      tokens.length
        ? tokens
            .map((t) => {
              const expired = t.expiresAt && Date.parse(t.expiresAt) <= Date.now();
              const connected = state.clients.some((c) => c.id === t.id);
              return `<div class="token-row"><div><h3>${e(t.name)}${pill(expired ? 'Expired' : connected ? 'Recently active' : 'Ready', expired ? 'warn' : connected ? '' : 'off')}</h3><p>${e((t.oauth?.workspaceIds || [t.workspaceId]).map((id) => state.workspaces.find((w) => w.id === id)?.name || 'Removed workspace').join(', '))} · ${t.expiresAt ? 'Expires ' + new Date(t.expiresAt).toLocaleString() : 'No expiration'}</p>${t.oauth ? '<p class="help">Per-workspace permissions and the original authorization limits apply.</p>' : permissionTags(t.permissions)}</div><div class="actions">${t.oauth ? pill('OAuth') : button('Rotate', 'rotate', 'small', `data-id="${t.id}"`)}${button('Revoke', 'revoke', 'danger small', `data-id="${t.id}"`)}</div></div>`;
            })
            .join('')
        : empty(
            'No clients have access yet',
            'Create a token, then add the endpoint to a client that supports bearer authentication.',
            button('Create token', 'token-modal', 'primary'),
            'connections',
          ),
      tokens.length ? button('Revoke all', 'revoke-all', 'danger small') : '',
    )}${panel(
      'Connect with MCP',
      `<div class="panel-body"><span class="field-label">Streamable HTTP endpoint</span>${copyField(endpoint())}<p class="help">Send your access token in the Authorization header:</p><pre class="snippet">Authorization: Bearer &lt;your-access-token&gt;</pre><div class="meta-row"><span>MCP server</span>${pill(state.runtime.mcpEnabled ? 'Listening' : 'Stopped', state.runtime.mcpEnabled ? '' : 'off')}</div><div class="meta-row"><span>Recent clients</span><strong>${state.clients.length}</strong></div><p class="connection-note">OAuth clients discover authorization automatically. Review the request and check the workspaces the agent may access. Manual bearer tokens remain available.</p><h3 class="section-title">Local stdio clients</h3><p class="help">Use the separate <code>mcp-code-stdio</code> executable with <code>MCP_CODE_TOKEN</code> in the client environment. Keep the daemon running.</p><pre class="snippet">{
  "mcpServers": {
    "mcp-code": {
      "command": "mcp-code-stdio",
      "env": { "MCP_CODE_TOKEN": "&lt;your-token&gt;" }
    }
  }
}</pre></div>`,
    )}</div>`
  );
}
function diagnosticsPanel() {
  const rows = diagnostics
    ? [
        {
          name: 'Docker',
          ready: diagnostics.sandbox.available,
          detail: diagnostics.sandbox.detail,
        },
        {
          name: 'Development image',
          ready: diagnostics.sandbox.imageReady,
          detail: diagnostics.sandbox.imageReady
            ? 'Ready for isolated commands.'
            : 'Start Docker, then choose Build image.',
        },
        {
          name: 'MCP server',
          ready: diagnostics.mcpEnabled,
          detail: diagnostics.mcpEnabled
            ? 'Accepting authenticated connections.'
            : 'Start MCP from the dashboard.',
        },
        ...diagnostics.providers,
      ]
    : [];
  return panel(
    'Connection checks',
    `<div class="panel-body">${rows.length ? rows.map((r) => `<div class="meta-row"><strong>${e(r.name)}</strong>${pill(r.ready ? 'Ready' : 'Needs attention', r.ready ? '' : 'warn')}</div><p class="help">${e(r.detail)}</p>`).join('') : '<p>Check Docker, the development image, and your tunnel tools.</p>'}<div class="actions">${button('Check connections', 'diagnostics', 'small')}${diagnostics?.sandbox.available && !diagnostics.sandbox.imageReady ? button('Build image', 'build', 'small') : ''}</div></div>`,
  );
}
function tunnelSettings(id, busy) {
  if (!['ngrok', 'cloudflare'].includes(id)) return '';
  const c = state.tunnelConfigs?.[id] || { mode: 'temporary' };
  return `<p class="help">Address: ${c.mode === 'temporary' ? 'Provider-assigned address' : e(c.publicUrl)}</p>${busy ? '' : button('Configure address', 'tunnel-settings', 'small', `data-id="${id}"`)}`;
}
function tunnelSettingsModal(id) {
  const c = state.tunnelConfigs?.[id] || { mode: 'temporary' };
  modal(
    'Tunnel address',
    `<form id="tunnel-settings-form" class="form"><label>Address mode<select name="mode"><option value="temporary" ${c.mode === 'temporary' ? 'selected' : ''}>Provider-assigned address</option><option value="${id === 'ngrok' ? 'ngrok-domain' : 'cloudflare-named'}" ${c.mode !== 'temporary' ? 'selected' : ''}>Stable address</option></select></label><label>Public HTTPS address<input name="publicUrl" placeholder="https://your-domain.example" value="${e(c.publicUrl || '')}"></label>${id === 'cloudflare' ? `<label>Tunnel UUID<input name="tunnelId" value="${e(c.tunnelId || '')}"></label><label>Credentials file (absolute path)<input name="credentialsFile" value="${e(c.credentialsFile || '')}"></label><p class="help">Create a locally managed tunnel and route this hostname to its UUID in Cloudflare first. Credentials stay in the native file. The app exposes only its gateway through this tunnel.</p>` : '<p class="help">Use a domain available in your ngrok account. Your native ngrok configuration supplies authentication.</p>'}<p class="help">Stable-address fields are only used in Stable address mode. Changing the public address requires agents to authorize again.</p><button type="submit" class="button primary">Save address</button></form>`,
  );
  document.querySelector('#tunnel-settings-form').onsubmit = (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const config = data.mode === 'temporary' ? { mode: 'temporary' } : data;
    perform(async () => {
      await api(`/tunnels/config/${id}`, 'PUT', config);
      diagnostics = undefined;
      closeModal();
      await refresh(true);
      toast('Tunnel address saved.');
    });
  };
}
function changes() {
  const selected =
    review && state.workspaces.some((w) => w.id === review.workspaceId) ? review : undefined;
  const data = selected?.data;
  return (
    heading(
      'Workspace changes',
      'Review all current Git changes, including your edits and agent edits. Nothing is applied or reverted here.',
    ) +
    panel(
      'Choose a workspace',
      `<div class="panel-body"><label>Workspace<select id="review-workspace">${state.workspaces.map((w) => `<option value="${w.id}" ${w.id === selected?.workspaceId ? 'selected' : ''}>${e(w.name)}</option>`).join('')}</select></label>${button('Load changes', 'load-changes', 'primary')}<p class="help">Review runs in a read-only container. Click Load changes again for an updated snapshot.</p></div>`,
    ) +
    (data
      ? !data.repository
        ? panel(
            'No Git repository',
            '<div class="panel-body">This folder is not a Git repository. Initialize Git to review staged and working changes.</div>',
          )
        : panel(
            'Changed files',
            `<div class="panel-body">${data.files.length ? data.files.map((f) => `<p><code>${e(f.status)} ${e(f.path)}</code></p>`).join('') : '<p>No changes.</p>'}${data.truncated ? '<p class="help">This review is truncated. Some file content or entries were omitted.</p>' : ''}</div>`,
          ) +
          panel(
            'Staged changes',
            `<div class="panel-body"><pre class="snippet">${e(data.staged || 'No staged changes.')}</pre></div>`,
          ) +
          panel(
            'Working changes',
            `<div class="panel-body"><pre class="snippet">${e(data.working || 'No working changes.')}</pre></div>`,
          ) +
          data.untracked
            .map((f) =>
              panel(
                e(f.path),
                `<div class="panel-body"><pre class="snippet">${e(f.text)}</pre>${f.truncated ? '<p class="help">Preview truncated.</p>' : ''}</div>`,
              ),
            )
            .join('')
      : '')
  );
}
function remote() {
  const tunnel = state.tunnel;
  remoteTab ||= tunnel.provider || 'local';
  const tabs = [{ id: 'local', name: 'Local' }, ...providers];
  const provider = providers.find((p) => p.id === remoteTab);
  const busy = ['starting', 'connected'].includes(tunnel.state);
  const selected = busy && tunnel.provider === remoteTab;
  const providerName = providers.find((p) => p.id === tunnel.provider)?.name || tunnel.provider;
  const mode =
    remoteTab === 'local'
      ? `<h3>Connect on this computer</h3><p>Use your local dashboard and MCP endpoint without a public tunnel.</p>${busy ? button('Use local only', 'stop-tunnel', 'primary') : pill('Current mode')}<span class="field-label">Local MCP endpoint</span>${copyField(`http://127.0.0.1:${state.runtime.mcpPort}/mcp`)}`
      : `<h3>${e(provider?.name || remoteTab)}</h3><p>${remoteTab === 'ngrok' ? 'Use your ngrok account to give the dashboard, OAuth, and MCP endpoint one HTTPS address.' : remoteTab === 'cloudflare' ? 'Use a quick tunnel or an existing named tunnel to give the dashboard, OAuth, and MCP endpoint one address.' : 'Connect through this installed tunnel provider.'}</p><p class="help">CLI: ${provider?.available ? 'Installed' : 'Not installed'}</p>${remoteTab === 'ngrok' ? '<p class="help">Configure once in your terminal: <code>ngrok config add-authtoken YOUR_TOKEN</code>. Credentials stay with ngrok.</p>' : ''}<div class="actions">${selected ? pill(tunnel.state === 'starting' ? 'Connecting' : 'Connected') : busy ? '<p class="help">Stop the active tunnel before switching methods.</p>' : button('Start ' + (provider?.name || remoteTab), 'start-tunnel', 'primary', `data-id="${e(remoteTab)}"`)}${['ngrok', 'cloudflare'].includes(remoteTab) ? `<a class="button plain" href="${remoteTab === 'ngrok' ? 'https://ngrok.com/docs/getting-started/' : 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/'}" target="_blank" rel="noreferrer">Installation guide</a>` : ''}</div>`;
  return (
    heading(
      'Remote access',
      'Choose how clients and your browser connect to this runtime.',
      busy ? button('Stop tunnel', 'stop-tunnel', 'danger') : '',
    ) +
    `<div class="stack">${diagnosticsPanel()}${panel('Remote dashboard sessions', `<div class="panel-body"><p class="help">Sign out every remote browser and invalidate unused login codes. Agent connections stay active.</p>${button('Sign out all remote sessions', 'remote-logout-all', 'danger small')}</div>`)}${panel('Connection mode', `<div class="connection-tabs" role="tablist" aria-label="Connection methods">${tabs.map((tab) => `<button role="tab" aria-selected="${remoteTab === tab.id}" aria-controls="connection-panel" id="tab-${e(tab.id)}" tabindex="${remoteTab === tab.id ? 0 : -1}" data-action="connection-tab" data-id="${e(tab.id)}">${e(tab.name === 'Cloudflare quick tunnel' ? 'Cloudflare' : tab.name)}</button>`).join('')}</div><div id="connection-panel" role="tabpanel" aria-labelledby="tab-${e(remoteTab)}" class="panel-body connection-panel">${mode}${tunnelSettings(remoteTab, busy)}</div>`)}${tunnel.state === 'connected' ? panel('One public address', `<div class="panel-body"><span class="field-label">Dashboard</span>${copyField(tunnel.publicUrl + '/')}<span class="field-label">MCP endpoint</span>${copyField(endpoint())}<div class="meta-row"><span>Provider</span><strong>${e(providerName)}</strong></div><p class="help">The dashboard requires an owner login. Agents use OAuth or bearer tokens to access MCP.</p>${isLocalDashboard() ? button('Create remote login code', 'remote-code', 'primary') + '<p class="help">Use this one-time code to sign in at the public address. Codes expire in five minutes; owner sessions last eight hours.</p>' : button('Sign out of dashboard', 'remote-logout', 'danger small')}</div>`, pill('Connected')) : tunnel.error ? `<div class="notice warning"><div><strong>Tunnel could not connect</strong>${e(tunnel.error)}</div></div>` : ''}${panel('Agent authorization', `<div class="panel-body"><p>OAuth approval lets you check exactly which saved workspaces an agent may access. Unselected projects stay private.</p><a href="#connections" class="button plain">Manage agent access</a></div>`)}</div>`
  );
}
function oauthRequestsPanel() {
  const requests = state.oauthRequests || [];
  if (!requests.length) return '';
  return panel(
    'Agents waiting for approval',
    requests
      .map(
        (request) =>
          `<div class="workspace-row"><div><h3>${e(request.clientName)}</h3><p>Choose the workspaces this agent may access.</p></div><a href="#oauth=${e(request.id)}" class="button primary small">Review access</a></div>`,
      )
      .join(''),
  );
}
function oauthConsent() {
  const id = location.hash.slice('#oauth='.length);
  const request = (state.oauthRequests || []).find((r) => r.id === id);
  if (!request)
    return (
      heading('Agent authorization', 'Choose which workspaces an agent can access.') +
      panel(
        'Request unavailable',
        empty(
          'This request is no longer pending',
          'It may have expired or already been reviewed. Start the connection again in your agent.',
          '<a href="#connections" class="button">Manage connections</a>',
        ),
      )
    );
  const available = state.workspaces.filter((w) => w.permissions.read);
  return (
    heading(
      'Approve agent access',
      'Select the workspaces this agent may use. Nothing is selected by default.',
    ) +
    `<div class="stack consent-layout">${panel('Connection request', `<div class="panel-body"><h3>${e(request.clientName)}</h3><p class="help">The client supplies this name. Approve only a connection you started.</p><div class="meta-row"><span>Return address</span><strong>${e(new URL(request.redirectUri).host)}</strong></div><div class="meta-row"><span>MCP endpoint</span><code>${e(request.resource)}</code></div><div class="meta-row"><span>Expires</span><strong>${new Date(request.expiresAt).toLocaleTimeString()}</strong></div></div>`)}${panel('Workspaces the agent can access', available.length ? `<div class="consent-workspaces">${available.map((w) => `<label class="consent-workspace"><input type="checkbox" data-consent-workspace="${w.id}" ${consentSelection.has(w.id) ? 'checked' : ''}><span><strong>${e(w.name)}</strong><span class="workspace-path">${e(w.path)}</span>${permissionTags(w.permissions)}<span class="help">${w.approvalMode === 'ask' ? 'You approve each command.' : w.permissions.execute ? 'Commands run without individual approval.' : 'Command execution is disabled.'}</span></span></label>`).join('')}</div><div class="panel-footer actions">${button('Allow selected workspaces', 'oauth-approve', 'primary', `data-id="${e(id)}"`)}${button('Deny access', 'oauth-deny', 'danger', `data-id="${e(id)}"`)}</div>` : empty('Add a workspace first', 'No saved workspaces have read access enabled.', '<a href="#workspaces" class="button primary">Manage workspaces</a>') + `<div class="panel-footer">${button('Deny access', 'oauth-deny', 'danger', `data-id="${e(id)}"`)}</div>`)}<p class="help">Access is limited to these projects and their current permissions. You can revoke this connection at any time in Connections.</p></div>`
  );
}
function permissions() {
  const w = active();
  if (!w)
    return (
      heading('Permissions', 'Set the boundaries for your active workspace.') +
      panel(
        'Workspace permissions',
        empty(
          'Select a workspace first',
          'Choose a project to configure its access policy.',
          '<a class="button primary" href="#workspaces">Choose workspace</a>',
        ),
      )
    );
  const help = {
    read: 'Allow clients to inspect files in this workspace.',
    write: 'Allow sandboxed commands to modify project files.',
    execute: 'Allow arbitrary terminal commands in isolated containers.',
    git: 'Allow Git operations through terminal execution.',
    network:
      'Allow outbound internet and reachable local-network connections from command containers.',
  };
  return (
    heading(
      'Permissions',
      `Define what clients can do inside ${e(w.name)}. Token permissions can further restrict this policy.`,
    ) +
    `<div class="grid two">${panel(
      'Workspace access',
      `<form id="permissions-form" class="panel-body">${Object.entries(permissionNames)
        .map(
          ([key, name]) =>
            `<div class="toggle-row"><div><h3>${name}</h3><p>${help[key]}</p></div><label class="switch"><input type="checkbox" name="${key}" aria-label="${name}" ${w.permissions[key] ? 'checked' : ''}><span></span></label></div>`,
        )
        .join(
          '',
        )}<div class="help">Saving permission changes cancels running commands so they cannot retain previous access.</div><div class="actions"><button class="button primary" type="submit">Save permissions</button></div></form>`,
    )}<div class="stack">${panel('Command approvals', `<form id="approval-form" class="panel-body form"><label class="check"><input type="radio" name="mode" value="autonomous" ${w.approvalMode === 'autonomous' ? 'checked' : ''}>Autonomous</label><p class="help">Commands run within the configured permissions without asking.</p><label class="check"><input type="radio" name="mode" value="ask" ${w.approvalMode === 'ask' ? 'checked' : ''}>Ask before every terminal command</label><p class="help">Review the exact command in the dashboard. Pending requests expire after two minutes. Structured reads do not require approval.</p><button class="button" type="submit">Save approval mode</button></form>`)}${panel('How access is enforced', `<div class="panel-body prose"><h3>Workspace policy + token policy</h3><p>A client receives only permissions enabled in both places. Internet access is blocked by Docker when network is off.</p><p>Arbitrary terminal access requires Read, Modify, Execute, and Git together. Disabling one turns terminal access off. Read-only clients can still use the file, tree, and search tools.</p></div>`)}</div></div>`
  );
}
function activity() {
  const entries = state.activity.filter(
    (a) =>
      !activeFilter ||
      `${a.command || ''} ${a.tool} ${a.client}`.toLowerCase().includes(activeFilter.toLowerCase()),
  );
  return (
    heading(
      'Activity',
      'See each tool call and command result. Command output stays in memory; audit history stores metadata.',
      button('Clear history', 'clear-activity', 'danger'),
    ) +
    `<div class="stack">${jobsPanel()}${panel('Audit history', `<div class="filter-row"><input id="activity-filter" type="search" placeholder="Filter by command, tool, or client" aria-label="Filter activity" value="${e(activeFilter)}"><span class="help">${entries.length} records · ${state.settings.retentionDays}-day retention</span></div><div id="audit-table">${activityTable(entries)}</div>`)}${
      state.jobs.some((j) => j.status === 'completed')
        ? panel(
            'Recent command output',
            state.jobs
              .filter((j) => j.status === 'completed')
              .slice(0, 10)
              .map(
                (j) =>
                  `<div class="job"><div class="job-top"><span>${e(j.client)} · ${new Date(j.createdAt).toLocaleTimeString()}</span>${pill(j.error ? 'Failed' : `Exit ${j.result?.exitCode ?? '—'}`, j.error || j.result?.exitCode ? 'warn' : '')}</div><code>${e(j.command)}</code><details><summary>View result</summary><pre>${e(j.error || [j.result?.stdout, j.result?.stderr].filter(Boolean).join('\n') || 'No output')}${j.result?.truncated ? '\n[Output limit reached]' : ''}</pre></details></div>`,
              )
              .join(''),
          )
        : ''
    }<p class="help">Commands can contain secrets. Avoid passing credentials in command text, and clear history when needed.</p></div>`
  );
}
function settings() {
  return (
    heading(
      'Settings',
      'Local runtime configuration. Port changes apply after restarting MCP Code.',
    ) +
    `<div class="grid equal"><div class="stack">${panel('Runtime configuration', `<form id="settings-form" class="panel-body form"><label>Dashboard port<input name="uiPort" type="number" min="1024" max="65535" value="${state.settings.uiPort}" required></label><label>MCP port<input name="mcpPort" type="number" min="1024" max="65535" value="${state.settings.mcpPort}" required></label><label>Audit retention (days)<input name="retentionDays" type="number" min="1" max="90" value="${state.settings.retentionDays}" required></label><p class="help">Both services bind to 127.0.0.1. The dashboard and MCP ports must differ.</p><button class="button primary" type="submit">Save settings</button></form>`)}${panel('Development image', `<div class="panel-body"><div class="meta-row"><span>Docker engine</span>${pill(state.sandbox.available ? 'Available' : 'Unavailable', state.sandbox.available ? '' : 'warn')}</div><div class="meta-row"><span>Development image</span>${pill(state.sandbox.imageReady ? 'Ready' : 'Not built', state.sandbox.imageReady ? '' : 'warn')}</div><p class="help">Includes Node.js, npm, Python, pip, Git, ripgrep, and make. Building requires internet; running a prepared sandbox does not.</p><div class="actions">${button('Build development image', 'build', 'small')}</div></div>`)}</div><div class="stack">${panel('About MCP Code', `<div class="panel-body prose"><h3>Your workspace. Your machine.</h3><p>MCP Code is an open-source bridge between MCP-capable AI clients and an isolated local development environment. It does not host a model or upload projects to an MCP Code server.</p><p>AI clients and tunnel providers may process data under their own policies. Only share folders you intend the client to read.</p><div class="meta-row"><span>Version</span><strong>0.1.0</strong></div><div class="meta-row"><span>Runtime</span><strong>Local daemon</strong></div></div>`)}${panel('Shut down runtime', `<div class="panel-body"><p class="help">Stops MCP requests, cancels commands, closes tunnels, and releases the local runtime. Start it again with <code>mcp-code</code>.</p><div class="actions">${button('Shut down MCP Code', 'shutdown', 'danger')}</div></div>`, '', 'danger-zone')}</div></div>`
  );
}
function render() {
  if (screen !== 'oauth' && !screens.some((s) => s[0] === screen)) screen = 'dashboard';
  const title =
    screen === 'oauth' ? 'Agent authorization' : screens.find((s) => s[0] === screen)[1];
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><img src="/icon.svg" alt="">MCP <span>Code</span></div><nav aria-label="Main navigation">${screens.map(([id, label, symbol]) => `<a href="#${id}" class="nav-item ${screen === id ? 'active' : ''}" ${screen === id ? 'aria-current="page"' : ''}>${icon(symbol)}${label}</a>`).join('')}</nav><div class="sidebar-footer"><div class="local-badge"><span class="dot"></span>${isLocalDashboard() ? 'Running on your machine' : 'Connected to your runtime'}</div>No hosted MCP Code services.<br>Your folders stay local.<div class="version">MCP Code v0.1.0</div></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">MCP Code / <strong>${title}</strong></div><div class="top-right"><span class="runtime-chip"><span class="dot"></span>Runtime running</span><span class="workspace-chip">${e(active()?.name || 'No active workspace')}</span></div></header><div class="content">${{ dashboard, workspaces, connections, remote, permissions, activity, changes, settings, oauth: oauthConsent }[screen]()}</div></main></div>`;
  bindForms();
}
function modal(title, body) {
  document.querySelector('#modal-root').innerHTML =
    `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${e(title)}"><div class="modal-head"><h2>${title}</h2><button class="close" data-action="close-modal" aria-label="Close dialog">×</button></div><div class="modal-body">${body}</div></section></div>`;
  setTimeout(() => document.querySelector('.modal input,.modal button')?.focus(), 0);
}
function closeModal() {
  document.querySelector('#modal-root').innerHTML = '';
}
function resourcesModal(id) {
  const w = state.workspaces.find((w) => w.id === id);
  const r = w.resources || { memoryMb: 512, cpus: 1, timeoutSeconds: 300 };
  modal(
    'Workspace resources',
    `<form id="resources-form" class="form"><p>${e(w.name)}</p><label>Memory (MB)<input type="number" name="memoryMb" min="256" max="32768" step="1" value="${r.memoryMb}" required></label><label>CPU cores<input type="number" name="cpus" min="0.5" max="16" step="0.5" value="${r.cpus}" required></label><label>Maximum command time (seconds)<input type="number" name="timeoutSeconds" min="1" max="3600" step="1" value="${r.timeoutSeconds}" required></label><p class="help">Limits apply to each command. Saving cancels this workspace’s running and pending commands. Choose limits your computer can support.</p><button type="submit" class="button primary">Save resources</button></form>`,
  );
  document.querySelector('#resources-form').onsubmit = (event) => {
    event.preventDefault();
    const resources = Object.fromEntries(
      [...new FormData(event.target)].map(([k, v]) => [k, Number(v)]),
    );
    perform(async () => {
      await api(`/workspaces/${id}`, 'PATCH', { resources });
      closeModal();
      toast('Workspace resources saved.');
      await refresh(true);
    });
  };
}
function workspaceModal() {
  modal(
    'Add a local workspace',
    `<form id="workspace-form" class="form">${button(`${icon('folder')} Select folder on this computer`, 'pick-folder')}<label>Project folder<input name="path" placeholder="/home/you/projects/my-project" required></label><p class="help">If the native folder picker is unavailable, enter the full local path. Choose a project folder without secrets you want to keep private.</p><label>Workspace name <span class="help">(optional)</span><input name="name" placeholder="My project" maxlength="80"></label><button class="button primary" type="submit">Add workspace</button></form>`,
  );
  document.querySelector('#workspace-form').onsubmit = async (event) => {
    event.preventDefault();
    await perform(async () => {
      const data = new FormData(event.target);
      await api('/workspaces', 'POST', {
        path: data.get('path'),
        name: data.get('name') || undefined,
      });
      closeModal();
      toast('Workspace added.');
      await refresh(true);
    });
  };
}
function tokenModal() {
  if (!state.workspaces.length) return workspaceModal();
  const w = active() || state.workspaces[0];
  modal(
    'Create access token',
    `<form id="token-form" class="form"><label>Client name<input name="name" placeholder="My AI client" required maxlength="80"></label><label>Workspace<select name="workspaceId">${state.workspaces.map((ws) => `<option value="${ws.id}" ${ws.id === w.id ? 'selected' : ''}>${e(ws.name)}</option>`).join('')}</select></label><label>Expiration<select name="expiresInHours"><option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option><option value="0">No expiration</option></select></label><fieldset><legend>Token permissions</legend><div class="check-grid">${Object.entries(
      permissionNames,
    )
      .map(
        ([k, label]) =>
          `<label class="check"><input type="checkbox" name="${k}" ${w.permissions[k] ? 'checked' : ''}>${label}</label>`,
      )
      .join(
        '',
      )}</div><p class="help">Effective access is the intersection of workspace and token permissions.</p></fieldset><button class="button primary" type="submit">Create token</button></form>`,
  );
  document.querySelector('#token-form').onsubmit = async (event) => {
    event.preventDefault();
    await perform(async () => {
      const form = event.target;
      const permissions = Object.fromEntries(
        Object.keys(permissionNames).map((k) => [k, form.elements[k].checked]),
      );
      const hours = Number(form.elements.expiresInHours.value);
      const result = await api('/tokens', 'POST', {
        name: form.elements.name.value,
        workspaceId: form.elements.workspaceId.value,
        permissions,
        ...(hours ? { expiresInHours: hours } : {}),
      });
      showToken(result);
      await refresh(true);
    });
  };
}
function showToken(result) {
  modal(
    'Save your access token',
    `<p class="help">This is the only time the full token is displayed. Store it in your client's secure configuration. MCP Code stores only its hash.</p><div class="secret">${copyField(result.token)}</div><span class="field-label">MCP endpoint</span>${copyField(endpoint())}<pre class="snippet">Authorization: Bearer ${e(result.token)}</pre><button class="button primary" data-action="close-modal">I have saved the token</button>`,
  );
}
async function perform(fn, el) {
  if (busy) return;
  busy = true;
  if (el) el.disabled = true;
  try {
    await fn();
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy = false;
    if (el?.isConnected) el.disabled = false;
  }
}
function bindForms() {
  const form = document.querySelector('#permissions-form');
  if (form)
    form.onsubmit = (event) => {
      event.preventDefault();
      perform(async () => {
        const permissions = Object.fromEntries(
          Object.keys(permissionNames).map((k) => [k, form.elements[k].checked]),
        );
        await api(`/workspaces/${active().id}`, 'PATCH', { permissions });
        toast('Permissions saved.');
        await refresh(true);
      });
    };
  const approvals = document.querySelector('#approval-form');
  if (approvals)
    approvals.onsubmit = (event) => {
      event.preventDefault();
      perform(async () => {
        await api(`/workspaces/${active().id}`, 'PATCH', {
          approvalMode: new FormData(approvals).get('mode'),
        });
        toast('Approval mode saved.');
        await refresh(true);
      });
    };
  const settingsForm = document.querySelector('#settings-form');
  if (settingsForm)
    settingsForm.onsubmit = (event) => {
      event.preventDefault();
      perform(async () => {
        const data = Object.fromEntries(
          [...new FormData(settingsForm)].map(([k, v]) => [k, Number(v)]),
        );
        const result = await api('/settings', 'PATCH', data);
        toast(
          result.restartRequired
            ? 'Settings saved. Restart MCP Code to apply port changes.'
            : 'Settings saved.',
        );
        await refresh(true);
      });
    };
  const filter = document.querySelector('#activity-filter');
  if (filter)
    filter.oninput = () => {
      activeFilter = filter.value;
      document.querySelector('#audit-table').innerHTML = activityTable(
        state.activity.filter((a) =>
          `${a.command || ''} ${a.tool} ${a.client}`
            .toLowerCase()
            .includes(activeFilter.toLowerCase()),
        ),
      );
    };
}
document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action,
    id = el.dataset.id;
  if (action === 'close-modal') return closeModal();
  if (action === 'workspace-modal') return workspaceModal();
  if (action === 'token-modal') return tokenModal();
  if (action === 'tunnel-settings') return tunnelSettingsModal(id);
  if (action === 'resources') return resourcesModal(id);
  if (action === 'go-workspaces') {
    location.hash = 'workspaces';
    return;
  }
  if (action === 'go-activity') {
    location.hash = 'activity';
    return;
  }
  if (action === 'copy') {
    navigator.clipboard.writeText(el.dataset.value).then(
      () => toast('Copied to clipboard.'),
      () => toast('Select and copy the value manually.', true),
    );
    return;
  }
  perform(async () => {
    switch (action) {
      case 'remove-oauth-client':
        if (!confirm('Remove this client, revoke all its grants, and cancel its commands?')) return;
        await api(`/oauth/clients/${id}`, 'DELETE');
        toast('OAuth client removed.');
        break;
      case 'remote-logout-all':
        if (!confirm('Sign out all remote dashboard sessions and invalidate unused login codes?'))
          return;
        await api('/remote/logout-all', 'POST');
        if (!isLocalDashboard()) {
          location.reload();
          return;
        }
        toast('Remote sessions signed out.');
        break;
      case 'diagnostics':
        diagnostics = await api('/diagnostics');
        providers = await api('/tunnels/providers');
        break;
      case 'load-changes': {
        const workspaceId = document.querySelector('#review-workspace').value;
        if (!workspaceId) throw new Error('Add a workspace first.');
        toast('Loading workspace changes…');
        const data = await api(`/workspaces/${workspaceId}/changes`);
        review = { workspaceId, data };
        break;
      }
      case 'pick-folder': {
        const result = await api('/workspaces/pick', 'POST');
        if (result.path)
          document.querySelector('#workspace-form input[name=path]').value = result.path;
        return;
      }
      case 'activate':
        await api(`/workspaces/${id}/activate`, 'POST');
        toast('Workspace activated.');
        break;
      case 'rename': {
        const name = prompt('Workspace name', state.workspaces.find((w) => w.id === id).name);
        if (!name) return;
        await api(`/workspaces/${id}`, 'PATCH', { name });
        toast('Workspace renamed.');
        break;
      }
      case 'remove-workspace':
        if (
          !confirm(
            'Remove this workspace configuration and revoke its tokens? Your project files will stay on disk.',
          )
        )
          return;
        await api(`/workspaces/${id}`, 'DELETE');
        toast('Workspace removed.');
        break;
      case 'revoke':
        await api(`/tokens/${id}/revoke`, 'POST');
        toast('Token revoked.');
        break;
      case 'revoke-all':
        if (!confirm('Revoke every client token and cancel all commands?')) return;
        await api('/tokens/revoke-all', 'POST');
        toast('All tokens revoked.');
        break;
      case 'rotate':
        showToken(await api(`/tokens/${id}/rotate`, 'POST'));
        break;
      case 'build':
        await api('/sandbox/build', 'POST');
        toast('Development image build started.');
        break;
      case 'connection-tab':
        remoteTab = id;
        render();
        return;
      case 'remote-code': {
        const result = await api('/remote/code', 'POST');
        modal(
          'Remote owner login',
          `<p class="help">This code works once and expires in five minutes. Enter it at the public dashboard.</p>${copyField(result.code)}<span class="field-label">Dashboard address</span>${copyField(result.url + '/')}<button class="button primary" data-action="close-modal">Done</button>`,
        );
        return;
      }
      case 'remote-logout':
        await fetch('/owner/logout', { method: 'POST' });
        location.reload();
        return;
      case 'oauth-approve':
      case 'oauth-deny': {
        const result = await api(`/oauth/requests/${id}/decision`, 'POST', {
          approved: action === 'oauth-approve',
          workspaceIds: [...consentSelection],
        });
        consentSelection.clear();
        location.assign(result.redirectUrl);
        return;
      }
      case 'start-tunnel':
        toast('Starting tunnel…');
        await api('/tunnels/start', 'POST', { provider: id });
        toast('Tunnel connected.');
        break;
      case 'stop-tunnel':
        await api('/tunnels/stop', 'POST');
        toast('Tunnel stopped.');
        break;
      case 'toggle-mcp':
        await api('/mcp', 'POST', { enabled: !state.runtime.mcpEnabled });
        toast(state.runtime.mcpEnabled ? 'MCP stopped.' : 'MCP started.');
        break;
      case 'approve':
      case 'deny':
        await api(`/jobs/${id}/approval`, 'POST', { approved: action === 'approve' });
        toast(action === 'approve' ? 'Command approved.' : 'Command denied.');
        break;
      case 'cancel':
        await api(`/jobs/${id}/cancel`, 'POST');
        toast('Command cancelled.');
        break;
      case 'clear-activity':
        if (!confirm('Clear the stored audit history?')) return;
        await api('/activity', 'DELETE');
        toast('Audit history cleared.');
        break;
      case 'shutdown':
        if (!confirm('Shut down MCP Code and cancel all running commands?')) return;
        await api('/shutdown', 'POST');
        app.innerHTML =
          '<div class="loading">MCP Code is shutting down. Run mcp-code to start it again.</div>';
        clearInterval(poll);
        return;
      case 'refresh':
        diagnostics = await api('/diagnostics');
        providers = await api('/tunnels/providers');
        break;
    }
    await refresh(true);
  }, el);
});
document.addEventListener('change', (event) => {
  const id = event.target.dataset?.consentWorkspace;
  if (id) {
    if (event.target.checked) consentSelection.add(id);
    else consentSelection.delete(id);
  }
});
document.addEventListener('keydown', (event) => {
  if (
    event.target.matches?.('[role="tab"]') &&
    ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
  ) {
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(event.target);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    remoteTab = tabs[next].dataset.id;
    render();
    document.querySelector(`[role="tab"][data-id="${CSS.escape(remoteTab)}"]`).focus();
    return;
  }
  if (event.key === 'Escape') closeModal();
  if (event.key === 'Tab' && document.querySelector('.modal')) {
    const elements = [
      ...document.querySelector('.modal').querySelectorAll('button,input,select,a[href]'),
    ].filter((el) => !el.disabled);
    const first = elements[0],
      last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
window.addEventListener('hashchange', async () => {
  screen = currentScreen();
  consentSelection.clear();
  if (screen === 'remote')
    try {
      providers = await api('/tunnels/providers');
    } catch {}
  render();
});
const poll = setInterval(() => refresh(), 3000);
(async () => {
  try {
    const response = await fetch('/api/bootstrap');
    ({ csrf } = await response.json());
    await refresh(true);
    providers = await api('/tunnels/providers');
    if (screen === 'remote') render();
  } catch (error) {
    toast(error.message, true);
  }
})();
