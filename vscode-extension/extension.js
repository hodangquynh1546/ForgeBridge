const vscode = require('vscode');
const { STATUS_LABEL, branchName, specMarkdown, keysIn } = require('./lib');

const TOKEN_KEY = 'forge.workhubToken';
let secrets;
let timer;

const cfg = () => vscode.workspace.getConfiguration('forge');
const bridge = () => String(cfg().get('bridgeUrl')).replace(/\/$/, '');

async function http(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error((data && (data.message || data.detail || data.title)) || `HTTP ${res.status}`);
  return data;
}

async function ide(method, path, body) {
  const token = await secrets.get(TOKEN_KEY);
  if (!token) throw new Error('Chưa đăng nhập Forge');
  return http(bridge() + '/ide' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

class TaskProvider {
  constructor() { this._emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this._emitter.event; this.tasks = []; }
  refresh() { this._emitter.fire(); }
  async load() {
    const logged = !!(await secrets.get(TOKEN_KEY));
    await vscode.commands.executeCommand('setContext', 'forge.loggedIn', logged);
    if (!logged) { this.tasks = []; return; }
    try { this.tasks = await ide('GET', '/tasks'); } catch (e) { vscode.window.showWarningMessage('Forge: ' + e.message); }
  }
  getTreeItem(t) {
    const item = new vscode.TreeItem(`${t.key}  ${t.title}`, vscode.TreeItemCollapsibleState.None);
    item.description = (t.blocked ? '⛔ ' : '') + (STATUS_LABEL[t.status] || t.status);
    item.tooltip = `${t.project}${t.sprint ? ' · ' + t.sprint : ''}${t.specLinked ? ' · có đặc tả SmartSpec' : ''}`;
    item.iconPath = new vscode.ThemeIcon(t.status === 'IN_PROGRESS' ? 'play-circle' : t.status === 'TESTING' || t.status === 'CODE_REVIEW' ? 'eye' : 'circle-outline');
    item.contextValue = 'task';
    item.command = { command: 'forge.openTask', title: 'Xem task', arguments: [t] };
    return item;
  }
  async getChildren() { await this.load(); return this.tasks; }
}

async function pickTask(arg) {
  if (arg && arg.key) return arg;
  const key = await vscode.window.showInputBox({ prompt: 'Mã task (ví dụ SHOP-12)', value: guessKeyFromBranch() });
  return key ? { key: key.trim().toUpperCase() } : undefined;
}

function guessKeyFromBranch() {
  try {
    const git = vscode.extensions.getExtension('vscode.git');
    const repo = git && git.exports.getAPI(1).repositories[0];
    const name = repo && repo.state.HEAD && repo.state.HEAD.name;
    return name ? keysIn(name)[0] : undefined;
  } catch { return undefined; }
}

function activate(context) {
  secrets = context.secrets;
  const provider = new TaskProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('forge.tasks', provider));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'forge.refresh';
  context.subscriptions.push(status);
  const updateStatus = () => {
    const key = guessKeyFromBranch();
    if (key) { status.text = `$(checklist) ${key}`; status.tooltip = 'Forge: task của branch hiện tại'; status.show(); } else status.hide();
  };
  updateStatus();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...a) => {
    try { await fn(...a); } catch (e) { vscode.window.showErrorMessage('Forge: ' + e.message); }
  }));

  reg('forge.login', async () => {
    const email = await vscode.window.showInputBox({ prompt: 'Email WorkHub' });
    if (!email) return;
    const password = await vscode.window.showInputBox({ prompt: 'Mật khẩu WorkHub', password: true });
    if (!password) return;
    const r = await http(String(cfg().get('workhubUrl')).replace(/\/$/, '') + '/api/integrations/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, tokenName: 'VS Code' }),
    });
    await secrets.store(TOKEN_KEY, r.token); // chỉ lưu token tích hợp, không lưu mật khẩu
    vscode.window.showInformationMessage(`Forge: đã đăng nhập ${r.user.fullName || r.user.email}`);
    provider.refresh();
  });
  reg('forge.logout', async () => { await secrets.delete(TOKEN_KEY); provider.refresh(); });
  reg('forge.refresh', async () => { provider.refresh(); updateStatus(); });

  reg('forge.openTask', async (arg) => {
    const t = await pickTask(arg);
    if (!t) return;
    const detail = await ide('GET', '/issues/' + encodeURIComponent(t.key));
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: specMarkdown(detail) });
    await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc, { preview: true }));
  });

  reg('forge.openDesign', async (arg) => {
    const t = await pickTask(arg);
    if (!t) return;
    const { documents } = await ide('GET', '/issues/' + encodeURIComponent(t.key) + '/design');
    if (!documents.length) { vscode.window.showInformationMessage(`Forge: ${t.key} chưa có tài liệu thiết kế từ SmartSpec.`); return; }
    const pick = documents.length === 1 ? documents[0] : (await vscode.window.showQuickPick(documents.map((d) => ({ label: d.title, description: d.scope === 'use-case' ? 'của use case này' : 'toàn dự án', d })), { placeHolder: 'Chọn tài liệu thiết kế' }) || {}).d;
    if (!pick) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: pick.content });
    await vscode.window.showTextDocument(doc, { preview: true });
    vscode.window.showInformationMessage('Sơ đồ Mermaid hiển thị khi cài thêm extension "Markdown Preview Mermaid Support", hoặc mở trong WorkHub.', 'Mở trong WorkHub').then((c) => { if (c) vscode.env.openExternal(vscode.Uri.parse(pick.url)); });
  });

  reg('forge.setStatus', async (arg) => {
    const t = await pickTask(arg);
    if (!t) return;
    const pick = await vscode.window.showQuickPick(Object.entries(STATUS_LABEL).map(([value, label]) => ({ label, value })), { placeHolder: `Trạng thái mới cho ${t.key}` });
    if (!pick) return;
    await ide('PUT', `/issues/${encodeURIComponent(t.key)}/status`, { status: pick.value });
    provider.refresh();
  });

  reg('forge.startTask', async (arg) => {
    const t = await pickTask(arg);
    if (!t) return;
    const detail = await ide('GET', '/issues/' + encodeURIComponent(t.key));
    const name = branchName(detail);
    const term = vscode.window.createTerminal({ name: 'Forge' });
    term.show();
    term.sendText(`git checkout -b ${name}`);
    if (detail.status === 'TO_DO') await ide('PUT', `/issues/${encodeURIComponent(t.key)}/status`, { status: 'IN_PROGRESS' });
    provider.refresh();
    updateStatus();
  });

  reg('forge.openInWorkHub', async (arg) => {
    const t = await pickTask(arg);
    if (t && t.url) vscode.env.openExternal(vscode.Uri.parse(t.url));
  });

  reg('forge.comment', async (arg) => {
    const t = await pickTask(arg);
    if (!t) return;
    const body = await vscode.window.showInputBox({ prompt: `Bình luận vào ${t.key}` });
    if (body) await ide('POST', `/issues/${encodeURIComponent(t.key)}/comments`, { body });
  });

  const every = Number(cfg().get('refreshSeconds')) || 0;
  if (every > 0) { timer = setInterval(() => { provider.refresh(); updateStatus(); }, every * 1000); context.subscriptions.push({ dispose: () => clearInterval(timer) }); }
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
