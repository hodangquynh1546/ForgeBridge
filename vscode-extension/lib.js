// Pure helpers (no vscode API) so they can be unit-tested with node.
const STATUS_LABEL = { TO_DO: 'Cần làm', IN_PROGRESS: 'Đang làm', CODE_REVIEW: 'Review', TESTING: 'Kiểm thử', DONE: 'Hoàn thành' };

function slug(title) {
  return String(title).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/** feature/SHOP-12-dang-nhap */
function branchName(task) {
  const type = task.type === 'BUG' ? 'fix' : 'feature';
  return `${type}/${task.key}-${slug(task.title)}`.replace(/-$/, '');
}

function specMarkdown(task) {
  const out = [`# ${task.key}: ${task.title}`,
    `**Trạng thái:** ${STATUS_LABEL[task.status] || task.status} · **Ưu tiên:** ${task.priority} · **Dự án:** ${task.project}` +
      (task.epic ? ` · **Epic:** ${task.epic.title}` : '') + (task.assignee ? ` · **Người làm:** ${task.assignee}` : '')];
  if (task.specRemoved) out.push('> ⚠️ Use case này đã bị xoá khỏi đặc tả SmartSpec. Hãy xác nhận với PO trước khi làm tiếp.');
  if (task.description) out.push(task.description);
  if (task.acceptanceCriteria) out.push('## Tiêu chí chấp nhận\n' + task.acceptanceCriteria);
  const uc = task.spec;
  if (uc) {
    out.push(`## Đặc tả SmartSpec: ${uc.name}`);
    if (uc.main_flow && uc.main_flow.length) out.push('**Luồng chính**\n' + uc.main_flow.map((s, i) => `${s.step || i + 1}. ${s.actor || ''}: ${s.action || ''}${s.expected_result ? ' → ' + s.expected_result : ''}`).join('\n'));
    if (uc.alternative_flows && uc.alternative_flows.length) out.push('**Luồng thay thế**\n' + uc.alternative_flows.map((a) => `- (bước ${a.at_step}) ${a.condition} → ${a.system_response}`).join('\n'));
    if (uc.exceptions && uc.exceptions.length) out.push('**Ngoại lệ**\n' + uc.exceptions.map((e) => `- (bước ${e.at_step}) ${e.type}: ${e.description} → ${e.system_response}`).join('\n'));
    if (uc.rules && uc.rules.length) out.push('**Quy tắc**\n' + uc.rules.map((r) => `- ${r.id || ''} ${r.description}`).join('\n'));
  }
  return out.join('\n\n');
}

/** Task keys mentioned in text such as a branch name or commit message. */
function keysIn(text) {
  return [...new Set((String(text).match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) || []))];
}

module.exports = { STATUS_LABEL, slug, branchName, specMarkdown, keysIn };
