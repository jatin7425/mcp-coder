import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWithinHostPath,
  isWithinProtectedHostPath,
  sameHostPath,
  normalizeHostPath,
  macSystemAlias,
  sandboxIdentity,
  dockerMountSource,
  platformConfigDirectory,
} from '../packages/shared/platform.js';
import { dockerArguments } from '../packages/sandbox/docker.js';
import { defaultPermissions } from '../packages/shared/types.js';
test('Windows path boundaries handle casing, drive letters, separators, Unicode, and namespace prefixes', () => {
  assert.ok(sameHostPath('C:\\Users\\Ada\\Project', 'c:/users/ada/project', 'win32'));
  assert.ok(sameHostPath('\\\\?\\C:\\Users\\Ada\\Project', 'C:\\Users\\Ada\\Project', 'win32'));
  assert.ok(isWithinHostPath('C:\\Users\\Ada\\项目\\src', 'c:\\users\\ada\\项目', 'win32'));
  assert.ok(isWithinHostPath('C:\\Users\\Ada\\project', 'C:\\', 'win32'));
  assert.ok(!isWithinHostPath('C:\\Users\\Ada\\project-other', 'C:\\Users\\Ada\\project', 'win32'));
  assert.ok(!isWithinHostPath('D:\\project', 'C:\\project', 'win32'));
  assert.ok(!isWithinHostPath('C:\\project\\..\\private', 'C:\\project', 'win32'));
  assert.equal(normalizeHostPath('C:\\', 'win32'), 'c:\\');
  assert.equal(dockerMountSource('\\\\?\\C:\\Users\\Ada\\项目', 'win32'), 'C:\\Users\\Ada\\项目');
});
test('Unix boundaries preserve casing and accept only exact macOS system aliases', () => {
  assert.ok(isWithinHostPath('/workspace/project/src', '/workspace/project', 'linux'));
  assert.ok(!isWithinHostPath('/workspace/project-other', '/workspace/project', 'linux'));
  assert.ok(!sameHostPath('/Project', '/project', 'darwin'));
  assert.ok(isWithinProtectedHostPath('/library/keychains', '/Library', 'darwin'));
  assert.ok(macSystemAlias('/var', '/private/var'));
  assert.ok(macSystemAlias('/tmp', '/private/tmp'));
  assert.ok(!macSystemAlias('/Users/ada/link', '/private/tmp'));
  assert.ok(!macSystemAlias('/tmp', '/Users/ada/project'));
});
test('platform state directories use native path conventions and user profile fallbacks', () => {
  assert.equal(
    platformConfigDirectory('win32', 'C:\\Users\\Ada', {}),
    'C:\\Users\\Ada\\AppData\\Local\\mcp-code',
  );
  assert.equal(
    platformConfigDirectory('win32', 'C:\\Users\\Ada', { LOCALAPPDATA: 'D:\\Local' }),
    'D:\\Local\\mcp-code',
  );
  assert.equal(
    platformConfigDirectory('darwin', '/Users/ada', {}),
    '/Users/ada/Library/Application Support/mcp-code',
  );
  assert.equal(
    platformConfigDirectory('linux', '/home/ada', { XDG_CONFIG_HOME: '/data/config' }),
    '/data/config/mcp-code',
  );
});
test('Docker uses host Unix ownership or a fixed Windows non-root identity and preserves native host mount paths', () => {
  assert.deepEqual(sandboxIdentity('linux', 1201, 1202), { uid: 1201, gid: 1202 });
  assert.deepEqual(sandboxIdentity('linux', 0, 0), { uid: 1000, gid: 1000 });
  assert.deepEqual(sandboxIdentity('darwin', 501, 20), { uid: 501, gid: 20 });
  assert.deepEqual(sandboxIdentity('win32'), { uid: 1000, gid: 1000 });
  const execution = {
    id: 'test',
    workspace: {
      id: 'project',
      name: 'Project',
      path: 'C:\\Users\\Ada\\项目 with spaces',
      permissions: defaultPermissions,
      approvalMode: 'autonomous' as const,
      createdAt: new Date().toISOString(),
    },
    permissions: defaultPermissions,
    input: { command: 'git status', timeout: 1000, cwd: '/workspace' },
    signal: new AbortController().signal,
  };
  const args = dockerArguments(execution, 'test', 'win32');
  assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
  assert.ok(args.includes('type=bind,src=C:\\Users\\Ada\\项目 with spaces,dst=/workspace'));
  assert.ok(args.includes('GIT_CONFIG_VALUE_0=/workspace'));
  assert.equal(args[args.indexOf('--network') + 1], 'none');
});
