import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bashAvailable = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;

test('login reset atomically preserves a private dotenv under a permissive caller umask', { skip: !bashAvailable }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stroios-login-reset-'));
  const dotenv = join(root, '.env');
  const script = fileURLToPath(new URL('../scripts/reset-login.sh', import.meta.url));
  try {
    await writeFile(dotenv, 'APP_USERNAME=old\nAPP_PASSWORD=old-secret\nDATABASE_URL=private\n');
    await chmod(dotenv, 0o600);
    const before = await stat(dotenv);
    const result = spawnSync('bash', [
      '-c',
      'umask 022; source "$1"; printf "%s" "$2" | secure_replace_login_env "$3"',
      '_',
      script,
      'APP_USERNAME=owner\nAPP_PASSWORD=new-secret\nDATABASE_URL=private\n',
      dotenv,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const after = await stat(dotenv);
    assert.equal(after.mode & 0o777, 0o600);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.match(await readFile(dotenv, 'utf8'), /APP_PASSWORD=new-secret/);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.env.login-reset.')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a successful mocked login rotation leaves no secret backup in the worktree or process arguments', { skip: !bashAvailable }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stroios-login-reset-full-'));
  const sourceScript = fileURLToPath(new URL('../scripts/reset-login.sh', import.meta.url));
  const scriptDirectory = join(root, 'scripts');
  const script = join(scriptDirectory, 'reset-login.sh');
  const fakeBin = join(root, 'fake-bin');
  const dotenv = join(root, '.env');
  try {
    await mkdir(scriptDirectory, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await copyFile(sourceScript, script);
    await writeFile(dotenv, 'APP_USERNAME=old\nAPP_PASSWORD=old-secret\nDATABASE_URL=private\nTELEGRAM_BOT_TOKEN=private-token\n');
    await chmod(dotenv, 0o600);
    const docker = join(fakeBin, 'docker');
    await writeFile(docker, '#!/bin/sh\nif [ "$1" = "inspect" ]; then printf "healthy\\n"; fi\ncat >/dev/null 2>&1 || true\nexit 0\n');
    await chmod(docker, 0o755);

    const result = spawnSync('bash', [script], {
      cwd: root,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ''}`, XDG_RUNTIME_DIR: root },
      input: 'new-owner-password-123\nnew-owner-password-123\n',
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /IKIOMA_LOGIN_READY/);
    assert.match(await readFile(dotenv, 'utf8'), /APP_PASSWORD='new-owner-password-123'/);
    assert.equal((await stat(dotenv)).mode & 0o777, 0o600);
    const files = await readdir(root, { recursive: true });
    assert.equal(files.some((name) => name.includes('before-login-reset') || name.includes('.env.login-reset.')), false);
    const scriptText = await readFile(sourceScript, 'utf8');
    assert.doesNotMatch(scriptText, /awk[^\n]*password_line/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
