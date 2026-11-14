const test = require('node:test');
const assert = require('node:assert');
const { slug, branchName, keysIn, specMarkdown } = require('./lib');
test('slug strips accents', () => assert.equal(slug('Đăng nhập hệ thống!'), 'dang-nhap-he-thong'));
test('branch name', () => assert.equal(branchName({ key: 'SHOP-12', title: 'Đăng nhập', type: 'USER_STORY' }), 'feature/SHOP-12-dang-nhap'));
test('bug branch', () => assert.equal(branchName({ key: 'SHOP-3', title: 'Lỗi', type: 'BUG' }), 'fix/SHOP-3-loi'));
test('keysIn', () => assert.deepEqual(keysIn('feature/SHOP-12-x, fixes ABC-7 and shop-1'), ['SHOP-12', 'ABC-7']));
test('spec markdown mentions flow', () => assert.match(specMarkdown({ key: 'A-1', title: 't', status: 'TO_DO', priority: 'LOW', project: 'p', spec: { name: 'n', main_flow: [{ step: 1, actor: 'K', action: 'x', expected_result: 'ok' }] } }), /1\. K: x → ok/));
