import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileBucket } from '../server/file-bucket.js';
import { PostgresDatabase } from '../server/postgres.js';
import { revokeRestoredAccess } from '../server/revoke-restored-access.js';
import { claimTelegramBinding, unlinkTelegramBinding } from '../sites/telegram/bindings.js';
import { projectForBinding } from '../sites/worker.js';
import {
  ACCESS_SCHEMA_VERSION,
  AccessError,
  UserAccessService,
  hashAccessToken,
  verifyAccessPassword,
} from '../server/user-access.js';

const connectionString = process.env.AUTH_TEST_DATABASE_URL || '';

const profileState = (
  projectId: string,
  status: 'active' | 'invited' | 'disabled' = 'invited',
  user: Partial<{ id: string; name: string; email: string; role: 'management' | 'foreman' | 'client' }> = {},
) => ({
  version: 1,
  schemaVersion: 17,
  project: { id: projectId, code: projectId, name: `Проект ${projectId}` },
  settings: {
    users: [{
      id: 'user-1',
      name: 'Иван Прорабов',
      email: 'ivan@example.test',
      role: 'foreman',
      status,
      ...user,
    }],
  },
  activity: [],
});

const sessionRequest = (token: string) => new Request('https://stroios.example.test/', {
  headers: { cookie: `stroios_session=${token}` },
});

test('PostgreSQL auth lifecycle is atomic, revocable and project-scoped', { skip: !connectionString }, async () => {
  const databaseName = new URL(connectionString).pathname;
  assert.equal(databaseName, '/stroios_auth_test', 'AUTH_TEST_DATABASE_URL must point to the disposable stroios_auth_test database');
  const database = new PostgresDatabase(connectionString);
  const pool = database.pool;
  try {
    await pool.query('DROP TABLE IF EXISTS auth_tokens,auth_sessions,auth_memberships,auth_login_limits,auth_audit,auth_users CASCADE');
    await pool.query('DROP TABLE IF EXISTS telegram_user_chat_projects,telegram_bindings,telegram_link_codes CASCADE');
    await pool.query('DROP TABLE IF EXISTS audit_log,project_state,system_meta CASCADE');
    await pool.query(`CREATE TABLE system_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)`);
    await pool.query(`
      CREATE TABLE project_state (
        project_id TEXT PRIMARY KEY,state_json TEXT NOT NULL,revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,updated_role TEXT NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,
        actor TEXT NOT NULL,role TEXT NOT NULL,action TEXT NOT NULL,summary TEXT NOT NULL,state_bytes INTEGER NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE telegram_link_codes (
        code_hash TEXT PRIMARY KEY,project_id TEXT NOT NULL,system_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT,claim_id TEXT
      )
    `);
    await pool.query(`
      CREATE TABLE telegram_bindings (
        telegram_user_id TEXT NOT NULL,project_id TEXT NOT NULL,system_user_id TEXT NOT NULL,
        private_chat_id TEXT NOT NULL,username TEXT,display_name TEXT NOT NULL,role TEXT NOT NULL,
        bound_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY (telegram_user_id,project_id)
      )
    `);
    await pool.query(`
      CREATE TABLE telegram_user_chat_projects (
        telegram_user_id TEXT NOT NULL,chat_id TEXT NOT NULL,project_id TEXT NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY (telegram_user_id,chat_id)
      )
    `);
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO project_state VALUES ($1,$2,1,$3,$3,'owner','management')`,
      ['project-a', JSON.stringify(profileState('project-a')), now],
    );
    await pool.query(
      `INSERT INTO project_state VALUES ($1,$2,1,$3,$3,'owner','management')`,
      ['project-pending-b', JSON.stringify(profileState('project-pending-b', 'invited', {
        id: 'user-pending-b', name: 'Иван Прорабов', email: 'ivan@example.test', role: 'foreman',
      })), now],
    );
    const emptyProfileProject = profileState('project-profile');
    emptyProfileProject.settings.users = [];
    await pool.query(
      `INSERT INTO project_state VALUES ($1,$2,1,$3,$3,'owner','management')`,
      ['project-profile', JSON.stringify(emptyProfileProject), now],
    );
    await pool.query(
      `INSERT INTO project_state VALUES ($1,$2,1,$3,$3,'owner','management')`,
      ['project-matrix-a', JSON.stringify(profileState('project-matrix-a', 'invited', {
        id: 'user-matrix', name: 'Матрица Доступа', email: 'matrix@example.test', role: 'management',
      })), now],
    );
    const matrixSecondProject = profileState('project-matrix-b');
    matrixSecondProject.settings.users = [];
    await pool.query(
      `INSERT INTO project_state VALUES ($1,$2,1,$3,$3,'owner','management')`,
      ['project-matrix-b', JSON.stringify(matrixSecondProject), now],
    );

    const service = new UserAccessService({
      database,
      ownerEmail: 'owner@example.test',
      ownerName: 'Владелец',
      ownerUsername: 'owner',
      ownerPassword: 'owner-password-strong-123',
      publicUrl: 'https://stroios.example.test',
    });
    await service.initialize();
    assert.equal(await service.readiness(), true);
    assert.equal((await pool.query("SELECT value FROM system_meta WHERE key='auth_schema_version'")).rows[0].value, String(ACCESS_SCHEMA_VERSION));

    const initialMatrix = await service.listUserProjectAccess({
      projectId: 'project-matrix-a', userId: 'user-matrix',
    });
    assert.equal(initialMatrix.accountActive, false);
    assert.equal(initialMatrix.projects.find((project) => project.id === 'project-matrix-a')?.selected, false);
    const selectedMatrix = await service.setUserProjectAccess({
      projectId: 'project-matrix-a',
      userId: 'user-matrix',
      projectIds: ['project-matrix-a', 'project-matrix-b'],
      actorEmail: 'owner@example.test',
      actorName: 'Владелец',
    });
    assert.deepEqual(
      selectedMatrix.projects.filter((project) => project.selected).map((project) => project.id),
      ['project-matrix-a', 'project-matrix-b'],
    );
    const copiedMatrixState = JSON.parse((await pool.query(
      "SELECT state_json FROM project_state WHERE project_id='project-matrix-b'",
    )).rows[0].state_json);
    const copiedMatrixUser = copiedMatrixState.settings.users.find((user) => user.email === 'matrix@example.test');
    assert.equal(copiedMatrixUser.status, 'invited');
    assert.equal(copiedMatrixUser.role, 'management');
    assert.equal((await pool.query(`
      SELECT COUNT(*)::int AS count FROM auth_memberships
      WHERE project_id IN ('project-matrix-a','project-matrix-b') AND status='pending'
    `)).rows[0].count, 2);

    const matrixInvitation = await service.issueToken({
      projectId: 'project-matrix-a', userId: 'user-matrix', actorEmail: 'owner@example.test',
    });
    const matrixToken = new URL(matrixInvitation.url).pathname.split('/').pop()!;
    const matrixSession = await service.activate(
      matrixToken,
      'matrix-password-strong-123',
      'matrix-password-strong-123',
      { ip: '198.51.100.245' },
    );
    assert.deepEqual(
      (await service.fromRequest(sessionRequest(matrixSession.token)))?.projectIds,
      ['project-matrix-a', 'project-matrix-b'],
    );
    const activatedMatrixB = JSON.parse((await pool.query(
      "SELECT state_json FROM project_state WHERE project_id='project-matrix-b'",
    )).rows[0].state_json);
    assert.equal(activatedMatrixB.settings.users.find((user) => user.email === 'matrix@example.test')?.status, 'active');

    const matrixFutureProject = profileState('project-matrix-future');
    matrixFutureProject.settings.users = [];
    await pool.query(
      `INSERT INTO project_state VALUES ($1,$2,1,$3,$3,'owner','management')`,
      ['project-matrix-future', JSON.stringify(matrixFutureProject), now],
    );
    const matrixWithFuture = await service.listUserProjectAccess({
      projectId: 'project-matrix-a', userId: 'user-matrix',
    });
    assert.equal(matrixWithFuture.projects.find((project) => project.id === 'project-matrix-future')?.selected, false);
    const reducedMatrix = await service.setUserProjectAccess({
      projectId: 'project-matrix-a',
      userId: 'user-matrix',
      projectIds: ['project-matrix-a'],
      actorEmail: 'owner@example.test',
      actorName: 'Владелец',
    });
    assert.equal(reducedMatrix.projects.find((project) => project.id === 'project-matrix-b')?.selected, false);
    assert.equal((await pool.query(`
      SELECT COUNT(*)::int AS count FROM auth_memberships
      WHERE project_id='project-matrix-b' AND auth_user_id=(SELECT id FROM auth_users WHERE email_normalized='matrix@example.test')
    `)).rows[0].count, 0);
    assert.deepEqual(
      (await service.fromRequest(sessionRequest(matrixSession.token)))?.projectIds,
      ['project-matrix-a'],
    );

    const createdProfile = await service.createProjectUser({
      projectId: 'project-profile',
      actorEmail: 'owner@example.test',
      actorName: 'Владелец',
      profile: { name: 'Профиль Теста', email: 'profile@example.test', role: 'foreman', telegram: '@profile' },
    });
    assert.equal(createdProfile.user.status, 'invited');
    assert.equal(createdProfile.snapshot.revision, 2);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM auth_memberships WHERE project_id='project-profile'")).rows[0].count, 0);
    const profileInvite = await service.issueToken({
      projectId: 'project-profile', userId: createdProfile.user.id, actorEmail: 'owner@example.test',
    });
    const profileToken = new URL(profileInvite.url).pathname.split('/').pop()!;
    const profileSession = await service.activate(
      profileToken,
      'profile-password-strong-123',
      'profile-password-strong-123',
      { ip: '198.51.100.240' },
    );
    const pendingProfileReset = await service.issueToken({
      projectId: 'project-profile', userId: createdProfile.user.id, actorEmail: 'owner@example.test', purpose: 'reset',
    });
    const pendingProfileResetToken = new URL(pendingProfileReset.url).pathname.split('/').pop()!;
    const roleUpdate = await service.updateProjectUser({
      projectId: 'project-profile',
      userId: createdProfile.user.id,
      actorEmail: 'owner@example.test',
      actorName: 'Владелец',
      profile: { name: 'Профиль Теста', email: 'profile@example.test', role: 'management', telegram: '@profile-new' },
    });
    assert.equal(roleUpdate.user.role, 'management');
    assert.equal(await service.fromRequest(sessionRequest(profileSession.token)), null);
    assert.equal((await pool.query("SELECT role FROM auth_memberships WHERE project_id='project-profile'")).rows[0].role, 'management');
    await assert.rejects(() => service.inspectToken(pendingProfileResetToken), (error: AccessError) => error.code === 'invite_invalid');

    const profileSessionAfterRole = await service.authenticate(
      'profile@example.test', 'profile-password-strong-123', { ip: '198.51.100.241' },
    );
    const emailUpdate = await service.updateProjectUser({
      projectId: 'project-profile',
      userId: createdProfile.user.id,
      actorEmail: 'owner@example.test',
      actorName: 'Владелец',
      profile: { name: 'Профиль Теста', email: 'profile.changed@example.test', role: 'management', telegram: '' },
    });
    assert.equal(emailUpdate.user.status, 'invited');
    assert.equal(await service.fromRequest(sessionRequest(profileSessionAfterRole.token)), null);
    const remappedMembership = (await pool.query(`
      SELECT m.role,m.status,u.email_normalized,u.password_hash
      FROM auth_memberships m JOIN auth_users u ON u.id=m.auth_user_id
      WHERE m.project_id='project-profile'
    `)).rows[0];
    assert.deepEqual(
      { role: remappedMembership.role, status: remappedMembership.status, email: remappedMembership.email_normalized, password: remappedMembership.password_hash },
      { role: 'management', status: 'pending', email: 'profile.changed@example.test', password: null },
    );
    const emailState = JSON.parse((await pool.query("SELECT state_json FROM project_state WHERE project_id='project-profile'")).rows[0].state_json);
    assert.equal(emailState.settings.users[0].email, 'profile.changed@example.test');
    assert.equal(emailState.settings.users[0].status, 'invited');
    const profileWithoutCredentials = await service.createProjectUser({
      projectId: 'project-profile',
      actorEmail: 'owner@example.test',
      actorName: 'Владелец',
      profile: { name: 'Без доступа', email: 'no-access@example.test', role: 'client' },
    });
    await service.setBlocked({
      projectId: 'project-profile', userId: profileWithoutCredentials.user.id, actorEmail: 'owner@example.test', blocked: true,
    });
    const unblockedWithoutCredentials = await service.setBlocked({
      projectId: 'project-profile', userId: profileWithoutCredentials.user.id, actorEmail: 'owner@example.test', blocked: false,
    });
    assert.equal(unblockedWithoutCredentials.status, 'not_issued');
    const revisionBeforeDuplicate = Number((await pool.query("SELECT revision FROM project_state WHERE project_id='project-profile'")).rows[0].revision);
    await assert.rejects(
      () => service.updateProjectUser({
        projectId: 'project-profile',
        userId: createdProfile.user.id,
        actorEmail: 'owner@example.test',
        actorName: 'Владелец',
        profile: { name: 'Профиль Теста', email: 'no-access@example.test', role: 'management' },
      }),
      (error: AccessError) => error.code === 'duplicate_email',
    );
    assert.equal(Number((await pool.query("SELECT revision FROM project_state WHERE project_id='project-profile'")).rows[0].revision), revisionBeforeDuplicate);

    const ownerSessionBeforeRotation = await service.authenticate('owner', 'owner-password-strong-123', { ip: '198.51.100.250' });
    const rotatedOwnerService = new UserAccessService({
      database,
      ownerEmail: 'owner@example.test',
      ownerName: 'Владелец',
      ownerUsername: 'owner',
      ownerPassword: 'owner-password-rotated-456',
      publicUrl: 'https://stroios.example.test',
    });
    await rotatedOwnerService.initialize();
    assert.equal(await service.fromRequest(sessionRequest(ownerSessionBeforeRotation.token)), null);
    await service.initialize();

    for (let index = 0; index < 6; index += 1) {
      await service.authenticate('owner', 'wrong-owner-password-value', { ip: '198.51.100.249' }).catch(() => undefined);
    }
    await assert.rejects(
      () => service.authenticate('owner', 'owner-password-strong-123', { ip: '198.51.100.249' }),
      (error: AccessError) => error.code === 'rate_limited',
    );
    const ownerRecovery = await service.authenticate('owner', 'owner-password-strong-123', { ip: '198.51.100.248' });
    assert.equal((await service.fromRequest(sessionRequest(ownerRecovery.token)))?.isOwner, true);
    await pool.query('DELETE FROM auth_login_limits');

    const first = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test' });
    const firstToken = new URL(first.url).pathname.split('/').pop()!;
    const firstRow = (await pool.query('SELECT token_hash,revoked_at FROM auth_tokens WHERE token_hash=$1', [hashAccessToken(firstToken)])).rows[0];
    assert.ok(firstRow);
    assert.notEqual(firstRow.token_hash, firstToken);

    const second = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test' });
    const secondToken = new URL(second.url).pathname.split('/').pop()!;
    await assert.rejects(() => service.inspectToken(firstToken), (error: AccessError) => error.code === 'invite_invalid');
    assert.ok((await pool.query('SELECT revoked_at FROM auth_tokens WHERE token_hash=$1', [hashAccessToken(firstToken)])).rows[0].revoked_at);

    await pool.query("UPDATE auth_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE token_hash=$1", [hashAccessToken(secondToken)]);
    await assert.rejects(() => service.inspectToken(secondToken), (error: AccessError) => error.code === 'invite_invalid');

    const crossProjectA = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test' });
    const crossProjectAToken = new URL(crossProjectA.url).pathname.split('/').pop()!;
    const crossProjectB = await service.issueToken({ projectId: 'project-pending-b', userId: 'user-pending-b', actorEmail: 'owner@example.test' });
    const crossProjectBToken = new URL(crossProjectB.url).pathname.split('/').pop()!;
    await assert.rejects(() => service.inspectToken(crossProjectAToken), (error: AccessError) => error.code === 'invite_invalid');
    assert.equal((await service.inspectToken(crossProjectBToken)).projectId, 'project-pending-b');

    const third = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test' });
    const thirdToken = new URL(third.url).pathname.split('/').pop()!;
    await assert.rejects(() => service.inspectToken(crossProjectBToken), (error: AccessError) => error.code === 'invite_invalid');
    await pool.query('UPDATE auth_tokens SET revoked_at=NULL WHERE token_hash=$1', [hashAccessToken(crossProjectBToken)]);
    assert.equal((await service.inspectToken(crossProjectBToken)).projectId, 'project-pending-b');
    let activationSessionStage!: () => void;
    let releaseActivationSession!: () => void;
    const activationAtSession = new Promise<void>((resolve) => { activationSessionStage = resolve; });
    const activationSessionRelease = new Promise<void>((resolve) => { releaseActivationSession = resolve; });
    const initialCreateSession = service.createSession.bind(service);
    service.createSession = async (identity, context, client) => {
      if (context?.issueRace) {
        activationSessionStage();
        await activationSessionRelease;
      }
      return initialCreateSession(identity, context, client);
    };
    const activationsPromise = Promise.allSettled([
      service.activate(thirdToken, 'a-very-strong-password-123', 'a-very-strong-password-123', { ip: '198.51.100.1', issueRace: true }),
      service.activate(thirdToken, 'a-very-strong-password-123', 'a-very-strong-password-123', { ip: '198.51.100.1' }),
    ]);
    await activationAtSession;
    const issueDuringActivation = service.issueToken({
      projectId: 'project-pending-b', userId: 'user-pending-b', actorEmail: 'owner@example.test',
    });
    let issueWaitedForAccountLock = false;
    for (let attempt = 0; attempt < 100 && !issueWaitedForAccountLock; attempt += 1) {
      const waiting = await pool.query(`
        SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%SELECT id,password_hash,status,activated_at FROM auth_users%'
        LIMIT 1
      `);
      issueWaitedForAccountLock = Boolean(waiting.rowCount);
      if (!issueWaitedForAccountLock) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseActivationSession();
    const activations = await activationsPromise;
    const issuedDuringActivation = await issueDuringActivation;
    service.createSession = initialCreateSession;
    assert.equal(issueWaitedForAccountLock, true);
    assert.equal(issuedDuringActivation.existingAccount, true);
    assert.equal(activations.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(activations.filter((item) => item.status === 'rejected').length, 1);
    const activated = activations.find((item) => item.status === 'fulfilled') as PromiseFulfilledResult<{ token: string }>;
    const account = (await pool.query("SELECT id,password_hash,status FROM auth_users WHERE email_normalized='ivan@example.test'")).rows[0];
    assert.equal(account.status, 'active');
    assert.equal(await verifyAccessPassword('a-very-strong-password-123', account.password_hash), true);
    assert.equal((await pool.query('SELECT used_at FROM auth_tokens WHERE token_hash=$1', [hashAccessToken(thirdToken)])).rows[0].used_at !== null, true);
    assert.ok((await pool.query('SELECT revoked_at FROM auth_tokens WHERE token_hash=$1', [hashAccessToken(crossProjectBToken)])).rows[0].revoked_at);
    assert.equal((await pool.query("SELECT state_json FROM project_state WHERE project_id='project-a'")).rows[0].state_json.includes('"status":"active"'), true);

    const identity = await service.fromRequest(sessionRequest(activated.value.token));
    assert.deepEqual(identity?.projectIds, ['project-a', 'project-pending-b']);

    await pool.query(
      `INSERT INTO project_state VALUES ($1,$2,1,$3,$3,'owner','management')`,
      ['project-b', JSON.stringify(profileState('project-b', 'active')), new Date().toISOString()],
    );
    const stillScoped = await service.fromRequest(sessionRequest(activated.value.token));
    assert.deepEqual(stillScoped?.projectIds, ['project-a', 'project-pending-b']);

    const login = await service.authenticate('ivan@example.test', 'a-very-strong-password-123', { ip: '198.51.100.2' });
    assert.equal((await service.fromRequest(sessionRequest(login.token)))?.email, 'ivan@example.test');
    await service.revokeRequestSession(sessionRequest(login.token));
    assert.equal(await service.fromRequest(sessionRequest(login.token)), null);

    let burstPasswordChecks = 0;
    const burstService = new UserAccessService({
      database,
      ownerEmail: 'owner@example.test', ownerName: 'Владелец', ownerUsername: 'owner',
      ownerPassword: 'owner-password-strong-123', publicUrl: 'https://stroios.example.test',
      maxConcurrentPasswordJobs: 20,
      passwordVerifier: async (candidate: string, encoded: string) => {
        burstPasswordChecks += 1;
        return verifyAccessPassword(candidate, encoded);
      },
    });
    await burstService.initialize();
    const burst = await Promise.allSettled(Array.from({ length: 20 }, () =>
      burstService.authenticate('ivan@example.test', 'definitely-wrong-password', { ip: '198.51.100.3' })));
    assert.equal(burstPasswordChecks, 5);
    assert.equal(burst.filter((item) => item.status === 'rejected' && (item.reason as AccessError).code === 'invalid_credentials').length, 5);
    assert.equal(burst.filter((item) => item.status === 'rejected' && (item.reason as AccessError).code === 'rate_limited').length, 15);
    const freshBlockedAccountIpKey = burstService.ipRateKey('198.51.100.33');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM auth_login_limits WHERE key_hash=$1', [freshBlockedAccountIpKey])).rows[0].count, 0);
    const freshIpRecovery = await burstService.authenticate(
      'ivan@example.test', 'a-very-strong-password-123', { ip: '198.51.100.33' },
    );
    assert.equal((await burstService.fromRequest(sessionRequest(freshIpRecovery.token)))?.email, 'ivan@example.test');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM auth_login_limits WHERE key_hash=$1', [freshBlockedAccountIpKey])).rows[0].count, 0);
    await assert.rejects(
      () => burstService.authenticate('ivan@example.test', 'a-very-strong-password-123', { ip: '198.51.100.3' }),
      (error: AccessError) => error.code === 'rate_limited',
    );
    await pool.query('DELETE FROM auth_login_limits');

    let distributedAccountChecks = 0;
    const accountCooldownService = new UserAccessService({
      database,
      ownerEmail: 'owner@example.test', ownerName: 'Владелец', ownerUsername: 'owner',
      ownerPassword: 'owner-password-strong-123', publicUrl: 'https://stroios.example.test',
      maxConcurrentPasswordJobs: 20,
      passwordVerifier: async (candidate: string, encoded: string) => {
        distributedAccountChecks += 1;
        return verifyAccessPassword(candidate, encoded);
      },
    });
    await accountCooldownService.initialize();
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(
        () => accountCooldownService.authenticate('ivan@example.test', 'distributed-wrong-password', { ip: `198.51.101.${index + 1}` }),
        (error: AccessError) => error.code === 'invalid_credentials',
      );
    }
    await assert.rejects(
      () => accountCooldownService.authenticate('ivan@example.test', 'distributed-wrong-password', { ip: '198.51.101.6' }),
      (error: AccessError) => error.code === 'rate_limited' && error.retryAfter >= 1,
    );
    assert.equal(distributedAccountChecks, 6);
    await assert.rejects(
      () => accountCooldownService.authenticate('ivan@example.test', 'distributed-wrong-password', { ip: '198.51.101.7' }),
      (error: AccessError) => error.code === 'rate_limited',
    );
    assert.equal(distributedAccountChecks, 6, 'account cooldown rejects rotating prefixes before another KDF');
    const ivanRateKey = accountCooldownService.loginRateKey('ivan@example.test');
    await pool.query("UPDATE auth_login_limits SET blocked_until='2000-01-01T00:00:00.000Z' WHERE key_hash=$1", [ivanRateKey]);
    await assert.rejects(
      () => accountCooldownService.authenticate('ivan@example.test', 'distributed-wrong-password', { ip: '198.51.101.8' }),
      (error: AccessError) => error.code === 'rate_limited',
    );
    assert.equal(distributedAccountChecks, 7);
    await pool.query("UPDATE auth_login_limits SET blocked_until='2000-01-01T00:00:00.000Z' WHERE key_hash=$1", [ivanRateKey]);
    const cooldownRecovery = await accountCooldownService.authenticate(
      'ivan@example.test', 'a-very-strong-password-123', { ip: '198.51.101.9' },
    );
    assert.equal((await accountCooldownService.fromRequest(sessionRequest(cooldownRecovery.token)))?.email, 'ivan@example.test');
    assert.equal(distributedAccountChecks, 8);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM auth_login_limits WHERE key_hash=$1', [ivanRateKey])).rows[0].count, 0);
    await pool.query('DELETE FROM auth_login_limits');

    const collisionService = new UserAccessService({
      database,
      ownerEmail: 'owner@example.test', ownerName: 'Владелец', ownerUsername: 'owner',
      ownerPassword: 'owner-password-strong-123', publicUrl: 'https://stroios.example.test',
      passwordVerifier: async (candidate: string, encoded: string) => (
        candidate === 'a-very-strong-password-123' && verifyAccessPassword(candidate, encoded)
      ),
    });
    await collisionService.initialize();
    const unknownBuckets = new Map<string, string>();
    let collision: [string, string] | null = null;
    for (let index = 1; index < 20_000 && !collision; index += 1) {
      const address = `198.18.${Math.floor(index / 256)}.${index % 256}`;
      const key = collisionService.ipRateKey(address, true);
      const previous = unknownBuckets.get(key);
      if (previous && previous !== address) collision = [previous, address];
      else unknownBuckets.set(key, address);
    }
    assert.ok(collision);
    assert.notEqual(collisionService.ipRateKey(collision![0]), collisionService.ipRateKey(collision![1]));
    for (let index = 0; index < 6; index += 1) {
      await collisionService.authenticate(`unknown-collision-${index}@example.test`, 'definitely-wrong-password', { ip: collision![0] }).catch(() => undefined);
    }
    const collisionLogin = await collisionService.authenticate(
      'ivan@example.test', 'a-very-strong-password-123', { ip: collision![1] },
    );
    assert.equal((await collisionService.fromRequest(sessionRequest(collisionLogin.token)))?.email, 'ivan@example.test');
    await pool.query('DELETE FROM auth_login_limits');

    let gateChecks = 0;
    let gateCompletions = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const boundedService = new UserAccessService({
      database,
      ownerEmail: 'owner@example.test', ownerName: 'Владелец', ownerUsername: 'owner',
      ownerPassword: 'owner-password-strong-123', publicUrl: 'https://stroios.example.test',
      maxConcurrentPasswordJobs: 2,
      passwordVerifier: async () => { gateChecks += 1; await gate; return false; },
    });
    await boundedService.initialize();
    const distributedBurst = Array.from({ length: 20 }, (_, index) =>
      boundedService.authenticate(`unknown-${index}@example.test`, 'definitely-wrong-password', { ip: `203.0.113.${index + 1}` })
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: AccessError) => ({ status: 'rejected' as const, reason }),
        )
        .finally(() => { gateCompletions += 1; }));
    for (let attempt = 0; attempt < 500 && (gateCompletions < 18 || gateChecks < 2); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const gateChecksBeforeRelease = gateChecks;
    const gateCompletionsBeforeRelease = gateCompletions;
    releaseGate();
    const distributedOutcomes = await Promise.all(distributedBurst);
    assert.equal(gateChecksBeforeRelease, 2);
    assert.equal(gateCompletionsBeforeRelease, 18);
    assert.equal(distributedOutcomes.filter((item) => item.status === 'rejected' && (item.reason as AccessError).code === 'rate_limited').length, 18);
    await pool.query('DELETE FROM auth_login_limits');

    let cardinalityChecks = 0;
    const cardinalityService = new UserAccessService({
      database,
      ownerEmail: 'owner@example.test', ownerName: 'Владелец', ownerUsername: 'owner',
      ownerPassword: 'owner-password-strong-123', publicUrl: 'https://stroios.example.test',
      maxConcurrentPasswordJobs: 20,
      passwordVerifier: async () => { cardinalityChecks += 1; return false; },
    });
    await cardinalityService.initialize();
    const auditRowsBeforeUnknownBurst = (await pool.query('SELECT COUNT(*)::int AS count FROM auth_audit')).rows[0].count;
    for (let index = 0; index < 6; index += 1) {
      await cardinalityService.authenticate(`blocked-${index}@example.test`, 'definitely-wrong-password', { ip: '203.0.113.250' }).catch(() => undefined);
    }
    const rowsAtBlock = (await pool.query('SELECT COUNT(*)::int AS count FROM auth_login_limits')).rows[0].count;
    await Promise.all(Array.from({ length: 1_000 }, (_, index) =>
      cardinalityService.authenticate(`random-${index}@example.test`, 'definitely-wrong-password', { ip: '203.0.113.250' }).catch(() => undefined)));
    assert.equal(cardinalityChecks, 5);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM auth_login_limits')).rows[0].count, rowsAtBlock);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM auth_audit')).rows[0].count, auditRowsBeforeUnknownBurst);
    await pool.query(`
      INSERT INTO auth_login_limits(key_hash,attempts,window_started_at,blocked_until,updated_at)
      VALUES ('stale-test-key',1,'2000-01-01T00:00:00.000Z',NULL,'2000-01-01T00:00:00.000Z')
    `);
    cardinalityService.lastLoginLimitCleanupAt = 0;
    await cardinalityService.cleanupLoginLimits(new Date());
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM auth_login_limits WHERE key_hash='stale-test-key'")).rows[0].count, 0);
    await pool.query('DELETE FROM auth_login_limits');

    const reset = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test', purpose: 'reset' });
    const resetToken = new URL(reset.url).pathname.split('/').pop()!;
    const beforeReset = await service.authenticate('ivan@example.test', 'a-very-strong-password-123', { ip: '198.51.100.4' });
    const afterReset = await service.activate(resetToken, 'a-new-strong-password-456', 'a-new-strong-password-456', { ip: '198.51.100.4' });
    assert.equal(await service.fromRequest(sessionRequest(beforeReset.token)), null);
    assert.equal((await service.fromRequest(sessionRequest(afterReset.token)))?.email, 'ivan@example.test');

    const telegramClaimedAt = new Date().toISOString();
    await pool.query(`
      INSERT INTO telegram_link_codes(code_hash,project_id,system_user_id,created_at,expires_at,used_at,claim_id)
      VALUES ('telegram-claim-test','project-a','user-1',$1,$2,NULL,NULL)
    `, [telegramClaimedAt, new Date(Date.now() + 60_000).toISOString()]);
    assert.equal(await claimTelegramBinding(database, {
      codeHash: 'telegram-claim-test', claimId: 'claim-test-id', now: telegramClaimedAt,
      telegramUserId: '777', projectId: 'project-a', systemUserId: 'user-1', privateChatId: '777',
      username: 'ivan_telegram', displayName: 'Иван Telegram', role: 'foreman',
    }), true);
    assert.equal((await pool.query("SELECT used_at FROM telegram_link_codes WHERE code_hash='telegram-claim-test'")).rows[0].used_at, telegramClaimedAt);
    assert.equal((await service.listProjectAccess('project-a')).find((item) => item.userId === 'user-1')?.telegram.status, 'connected');

    await service.setBlocked({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test', blocked: true });
    assert.equal(await service.fromRequest(sessionRequest(afterReset.token)), null);
    assert.equal((await pool.query("SELECT status FROM auth_memberships WHERE project_id='project-a'")).rows[0].status, 'disabled');
    const blockedState = JSON.parse((await pool.query("SELECT state_json FROM project_state WHERE project_id='project-a'")).rows[0].state_json);
    assert.equal(blockedState.settings.users[0].status, 'active');
    const binding = (await pool.query("SELECT * FROM telegram_bindings WHERE project_id='project-a' AND system_user_id='user-1'")).rows[0];
    assert.equal((await projectForBinding({ DB: database }, binding)).user.id, 'user-1');
    const blockedAccess = (await service.listProjectAccess('project-a')).find((item) => item.userId === 'user-1');
    assert.equal(blockedAccess?.web.status, 'blocked');
    assert.equal(blockedAccess?.telegram.status, 'connected');
    await assert.rejects(
      () => service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test', purpose: 'reset' }),
      (error: AccessError) => error.code === 'user_disabled',
    );
    const unlinked = await unlinkTelegramBinding(database, 'project-a', 'user-1');
    assert.equal(unlinked.removed, 1);
    assert.equal((await service.listProjectAccess('project-a')).find((item) => item.userId === 'user-1')?.telegram.status, 'not_connected');

    await service.setBlocked({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test', blocked: false });
    const existing = await service.issueToken({ projectId: 'project-b', userId: 'user-1', actorEmail: 'owner@example.test' });
    assert.equal(existing.existingAccount, true);
    assert.equal(existing.purpose, 'existing');
    assert.equal((await pool.query("SELECT status FROM auth_memberships WHERE project_id='project-b'")).rows[0].status, 'active');
    const resetAcrossA = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test', purpose: 'reset' });
    const resetAcrossAToken = new URL(resetAcrossA.url).pathname.split('/').pop()!;
    const resetAcrossB = await service.issueToken({ projectId: 'project-b', userId: 'user-1', actorEmail: 'owner@example.test', purpose: 'reset' });
    const resetAcrossBToken = new URL(resetAcrossB.url).pathname.split('/').pop()!;
    await assert.rejects(() => service.inspectToken(resetAcrossAToken), (error: AccessError) => error.code === 'invite_invalid');
    assert.equal((await service.inspectToken(resetAcrossBToken)).projectId, 'project-b');
    const supersedingReset = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test', purpose: 'reset' });
    const supersedingResetToken = new URL(supersedingReset.url).pathname.split('/').pop()!;
    await assert.rejects(() => service.inspectToken(resetAcrossBToken), (error: AccessError) => error.code === 'invite_invalid');
    assert.equal((await service.inspectToken(supersedingResetToken)).projectId, 'project-a');
    assert.equal((await service.authenticate('ivan@example.test', 'a-new-strong-password-456', { ip: '198.51.100.5' })).identity.email, 'ivan@example.test');

    const idleSession = await service.authenticate('ivan@example.test', 'a-new-strong-password-456', { ip: '198.51.100.6' });
    await pool.query("UPDATE auth_sessions SET last_seen_at='2000-01-01T00:00:00.000Z' WHERE token_hash=$1", [hashAccessToken(idleSession.token)]);
    assert.equal(await service.fromRequest(sessionRequest(idleSession.token)), null);

    const racingReset = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test', purpose: 'reset' });
    const racingResetToken = new URL(racingReset.url).pathname.split('/').pop()!;
    let observedOldPassword!: () => void;
    let releaseOldPassword!: () => void;
    const oldPasswordObserved = new Promise<void>((resolve) => { observedOldPassword = resolve; });
    const oldPasswordRelease = new Promise<void>((resolve) => { releaseOldPassword = resolve; });
    const racingLoginService = new UserAccessService({
      database,
      ownerEmail: 'owner@example.test', ownerName: 'Владелец', ownerUsername: 'owner',
      ownerPassword: 'owner-password-strong-123', publicUrl: 'https://stroios.example.test',
      passwordVerifier: async (candidate: string, encoded: string) => {
        const valid = await verifyAccessPassword(candidate, encoded);
        if (candidate === 'a-new-strong-password-456') {
          observedOldPassword();
          await oldPasswordRelease;
        }
        return valid;
      },
    });
    await racingLoginService.initialize();
    const staleLogin = racingLoginService.authenticate('ivan@example.test', 'a-new-strong-password-456', { ip: '198.51.100.7' });
    await oldPasswordObserved;
    const racingResetSession = await service.activate(racingResetToken, 'race-safe-password-789', 'race-safe-password-789', { ip: '198.51.100.8' });
    releaseOldPassword();
    await assert.rejects(() => staleLogin, (error: AccessError) => error.code === 'invalid_credentials');
    assert.equal((await service.fromRequest(sessionRequest(racingResetSession.token)))?.email, 'ivan@example.test');

    const firstAtomicReset = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test', purpose: 'reset' });
    const firstAtomicToken = new URL(firstAtomicReset.url).pathname.split('/').pop()!;
    let sessionStageReached!: () => void;
    let releaseSessionStage!: () => void;
    const atSessionStage = new Promise<void>((resolve) => { sessionStageReached = resolve; });
    const sessionStageRelease = new Promise<void>((resolve) => { releaseSessionStage = resolve; });
    const createSession = service.createSession.bind(service);
    service.createSession = async (identity, context, client) => {
      if (context?.holdSession) {
        sessionStageReached();
        await sessionStageRelease;
      }
      return createSession(identity, context, client);
    };
    const firstAtomicActivation = service.activate(
      firstAtomicToken,
      'atomic-first-password-123',
      'atomic-first-password-123',
      { ip: '198.51.100.9', holdSession: true },
    );
    await atSessionStage;
    const lockProbe = await pool.connect();
    try {
      await lockProbe.query('BEGIN');
      await lockProbe.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(
        () => lockProbe.query("SELECT project_id FROM project_state WHERE project_id='project-a' FOR UPDATE"),
        (error: { code?: string }) => error.code === '55P03',
      );
      await lockProbe.query('ROLLBACK');
    } finally {
      lockProbe.release();
      releaseSessionStage();
    }
    const firstAtomicSession = await firstAtomicActivation;
    service.createSession = createSession;
    const secondAtomicReset = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test', purpose: 'reset' });
    const secondAtomicToken = new URL(secondAtomicReset.url).pathname.split('/').pop()!;
    const secondAtomicSession = await service.activate(
      secondAtomicToken,
      'atomic-latest-password-456',
      'atomic-latest-password-456',
      { ip: '198.51.100.10' },
    );
    assert.equal(await service.fromRequest(sessionRequest(firstAtomicSession.token)), null);
    assert.equal((await service.fromRequest(sessionRequest(secondAtomicSession.token)))?.email, 'ivan@example.test');
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM auth_sessions WHERE auth_user_id=$1 AND revoked_at IS NULL", [account.id])).rows[0].count, 1);

    await pool.query(
      `INSERT INTO project_state VALUES ($1,$2,1,$3,$3,'owner','management')`,
      ['project-c', JSON.stringify(profileState('project-c', 'active')), new Date().toISOString()],
    );
    await pool.query(
      `INSERT INTO project_state VALUES ($1,$2,1,$3,$3,'owner','management')`,
      ['project-http', JSON.stringify({
        ...profileState('project-http', 'invited', {
          id: 'user-http', name: 'HTTP Пользователь', email: 'http.user@example.test', role: 'foreman',
        }),
        checkpoints: [{ id: 'checkpoint-http', title: 'HTTP контроль', photos: [], clientVisible: false }],
        documents: [],
        fieldReports: [],
      }), new Date().toISOString()],
    );
    await pool.query(`
      INSERT INTO system_meta (key,value,updated_at) VALUES
        ('battle_schema_version','17',$1),
        ('battle_v17_reset','done',$1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at
    `, [new Date().toISOString()]);

    const clientRoot = await mkdtemp(join(tmpdir(), 'stroios-auth-client-'));
    await writeFile(join(clientRoot, 'index.html'), '<!doctype html><title>test</title>');
    const port = 39_000 + Math.floor(Math.random() * 900);
    const origin = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ['server/index.js'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        PORT: String(port),
        CLIENT_ROOT: clientRoot,
        DATABASE_URL: connectionString,
        OWNER_EMAIL: 'owner@example.test',
        OWNER_NAME: 'Владелец',
        APP_USERNAME: 'owner',
        APP_PASSWORD: 'owner-password-strong-123',
        APP_PUBLIC_URL: 'https://stroios.example.test',
        FILE_STORAGE_PATH: clientRoot,
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_WEBHOOK_URL: '',
        TELEGRAM_WEBHOOK_SECRET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (chunk) => { serverLog += String(chunk); });
    server.stderr.on('data', (chunk) => { serverLog += String(chunk); });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          const response = await fetch(`${origin}/api/readiness`);
          if (response.ok) { ready = true; break; }
        } catch { /* Сервер ещё запускает scrypt и схемы. */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(ready, true, serverLog);
      const readiness = await (await fetch(`${origin}/api/readiness`)).json() as { authSchemaVersion: number; authSchemaReady: boolean };
      assert.equal(readiness.authSchemaVersion, ACCESS_SCHEMA_VERSION);
      assert.equal(readiness.authSchemaReady, true);

      const forged = await fetch(`${origin}/api/access/users?projectId=project-a`, {
        headers: { 'oai-authenticated-user-email': 'owner@example.test', Accept: 'application/json' },
      });
      assert.equal(forged.status, 401);

      const oversized = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `username=owner&password=${'x'.repeat(20_000)}`,
      });
      assert.equal(oversized.status, 413);

      const declaredOversizedPublicLead = await fetch(`${origin}/api/public/leads`, {
        method: 'POST',
        headers: { origin: 'https://ikioma.ru', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x'.repeat(40_000), phone: '+79990000000' }),
      });
      assert.equal(declaredOversizedPublicLead.status, 413);

      const publicLeadStream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new TextEncoder().encode(`{"name":"${'x'.repeat(9_000)}`);
          for (let index = 0; index < 5; index += 1) controller.enqueue(chunk);
          controller.close();
        },
      });
      const oversizedPublicLead = await fetch(`${origin}/api/public/leads`, {
        method: 'POST',
        headers: { origin: 'https://ikioma.ru', 'content-type': 'application/json' },
        body: publicLeadStream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      assert.equal(oversizedPublicLead.status, 413);

      const ownerLogin = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'owner', password: 'owner-password-strong-123' }),
      });
      assert.equal(ownerLogin.status, 303);
      const ownerCookie = (ownerLogin.headers.get('set-cookie') || '').split(';', 1)[0];
      assert.match(ownerCookie, /^stroios_session=/);
      const ownerAccess = await fetch(`${origin}/api/access/users?projectId=project-a`, { headers: { cookie: ownerCookie } });
      assert.equal(ownerAccess.status, 200);

      const httpProfileCreate = await fetch(`${origin}/api/access/users`, {
        method: 'POST',
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-http',
          user: { name: 'HTTP Новый', email: 'http.new@example.test', role: 'foreman', telegram: '@httpnew' },
        }),
      });
      assert.equal(httpProfileCreate.status, 201);
      const httpProfileBody = await httpProfileCreate.json() as { user: { id: string }; snapshot: { revision: number; state: ReturnType<typeof profileState> } };
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM auth_memberships WHERE project_id='project-http' AND system_user_id=$1", [httpProfileBody.user.id])).rows[0].count, 0);
      const httpProjectAccess = await fetch(
        `${origin}/api/access/users/${encodeURIComponent(httpProfileBody.user.id)}/projects?projectId=project-http`,
        { headers: { cookie: ownerCookie } },
      );
      assert.equal(httpProjectAccess.status, 200);
      const httpProjectAccessBody = await httpProjectAccess.json() as { projects: Array<{ id: string; selected: boolean }> };
      assert.equal(httpProjectAccessBody.projects.find((project) => project.id === 'project-http')?.selected, false);
      const httpProjectAccessUpdate = await fetch(
        `${origin}/api/access/users/${encodeURIComponent(httpProfileBody.user.id)}/projects`,
        {
          method: 'PUT',
          headers: { cookie: ownerCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: 'project-http', projectIds: ['project-http'] }),
        },
      );
      assert.equal(httpProjectAccessUpdate.status, 200);
      assert.equal((await pool.query(
        "SELECT status FROM auth_memberships WHERE project_id='project-http' AND system_user_id=$1",
        [httpProfileBody.user.id],
      )).rows[0].status, 'pending');
      const forgedRosterState = structuredClone(httpProfileBody.snapshot.state);
      const forgedRosterUser = forgedRosterState.settings.users.find((user) => user.id === httpProfileBody.user.id)!;
      forgedRosterUser.role = 'management';
      const genericRosterPut = await fetch(`${origin}/api/state?projectId=project-http`, {
        method: 'PUT',
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-http',
          expectedRevision: httpProfileBody.snapshot.revision,
          state: forgedRosterState,
          action: 'test.generic_roster_change',
          summary: 'Попытка изменить roster общим PUT',
        }),
      });
      assert.equal(genericRosterPut.status, 200);
      const genericRosterBody = await genericRosterPut.json() as { snapshot: { state: ReturnType<typeof profileState> } };
      assert.equal(genericRosterBody.snapshot.state.settings.users.find((user) => user.id === httpProfileBody.user.id)?.role, 'foreman');
      const httpProfilePatch = await fetch(`${origin}/api/access/users/${encodeURIComponent(httpProfileBody.user.id)}`, {
        method: 'PATCH',
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-http',
          user: { name: 'HTTP Новый', email: 'http.new@example.test', role: 'client', telegram: '' },
        }),
      });
      assert.equal(httpProfilePatch.status, 200);
      const httpProfilePatchBody = await httpProfilePatch.json() as { snapshot: { state: ReturnType<typeof profileState> } };
      assert.equal(httpProfilePatchBody.snapshot.state.settings.users.find((user) => user.id === httpProfileBody.user.id)?.role, 'client');

      const httpInvitation = await fetch(`${origin}/api/access/web/invitations`, {
        method: 'POST',
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-http', userId: 'user-http' }),
      });
      assert.equal(httpInvitation.status, 201);
      const invitationBody = await httpInvitation.json() as { url: string };
      const httpToken = new URL(invitationBody.url).pathname.split('/').pop()!;
      const inviteGet = await fetch(`${origin}/invite/${httpToken}`);
      assert.equal(inviteGet.status, 200);
      assert.equal(inviteGet.headers.get('referrer-policy'), 'no-referrer');
      const inviteHead = await fetch(`${origin}/invite/${httpToken}`, { method: 'HEAD' });
      assert.equal(inviteHead.status, 200);
      assert.equal((await pool.query('SELECT used_at FROM auth_tokens WHERE token_hash=$1', [hashAccessToken(httpToken)])).rows[0].used_at, null);

      const httpActivation = await fetch(`${origin}/api/auth/activate`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: httpToken,
          password: 'http-user-password-123',
          passwordConfirm: 'http-user-password-123',
        }),
      });
      assert.equal(httpActivation.status, 303);
      const httpUserCookie = (httpActivation.headers.get('set-cookie') || '').split(';', 1)[0];
      assert.match(httpUserCookie, /^stroios_session=/);
      const replayActivation = await fetch(`${origin}/api/auth/activate`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: httpToken,
          password: 'http-user-password-123',
          passwordConfirm: 'http-user-password-123',
        }),
      });
      assert.equal(replayActivation.status, 410);
      assert.equal((await fetch(`${origin}/invite/${httpToken}`)).status, 410);
      const activatedProject = await fetch(`${origin}/api/state?projectId=project-http`, { headers: { cookie: httpUserCookie } });
      assert.equal(activatedProject.status, 200);

      const oversizedState = await fetch(`${origin}/api/state?projectId=project-http`, {
        method: 'PUT',
        headers: { cookie: httpUserCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-http', padding: 'x'.repeat(6_100_000) }),
      });
      assert.equal(oversizedState.status, 413);
      const oversizedStateStream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new TextEncoder().encode('x'.repeat(1_100_000));
          for (let index = 0; index < 6; index += 1) controller.enqueue(chunk);
          controller.close();
        },
      });
      const chunkedOversizedState = await fetch(`${origin}/api/state?projectId=project-http`, {
        method: 'PUT',
        headers: { cookie: httpUserCookie, 'content-type': 'application/json' },
        body: oversizedStateStream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      assert.equal(chunkedOversizedState.status, 413);

      const oversizedPhotoBytes = new Uint8Array(12 * 1024 * 1024 + 300 * 1024);
      oversizedPhotoBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      const oversizedPhotoForm = new FormData();
      oversizedPhotoForm.append('file', new Blob([oversizedPhotoBytes], { type: 'image/png' }), 'oversized.png');
      const declaredOversizedPhoto = await fetch(`${origin}/api/quality/upload?projectId=project-http&checkpointId=checkpoint-http`, {
        method: 'POST', headers: { cookie: httpUserCookie }, body: oversizedPhotoForm,
      });
      assert.equal(declaredOversizedPhoto.status, 413);
      const uploadBoundary = 'stroios-body-limit-boundary';
      const uploadPrefix = new TextEncoder().encode(`--${uploadBoundary}\r\nContent-Disposition: form-data; name="file"; filename="oversized.png"\r\nContent-Type: image/png\r\n\r\n`);
      const uploadSuffix = new TextEncoder().encode(`\r\n--${uploadBoundary}--\r\n`);
      const chunkedPhotoStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(uploadPrefix);
          const chunk = new Uint8Array(1024 * 1024);
          chunk.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
          for (let index = 0; index < 13; index += 1) controller.enqueue(chunk);
          controller.enqueue(uploadSuffix);
          controller.close();
        },
      });
      const chunkedOversizedPhoto = await fetch(`${origin}/api/quality/upload?projectId=project-http&checkpointId=checkpoint-http`, {
        method: 'POST',
        headers: { cookie: httpUserCookie, 'content-type': `multipart/form-data; boundary=${uploadBoundary}` },
        body: chunkedPhotoStream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      assert.equal(chunkedOversizedPhoto.status, 413);
      assert.equal((await fetch(`${origin}/api/health`)).status, 200);

      const multipart = (body: BlobPart, name: string, type: string) => {
        const form = new FormData();
        form.append('file', new Blob([body], { type }), name);
        return form;
      };
      const svgUpload = await fetch(`${origin}/api/quality/upload?projectId=project-http&checkpointId=checkpoint-http`, {
        method: 'POST', headers: { cookie: httpUserCookie },
        body: multipart('<svg><script>fetch("/api/state")</script></svg>', 'attack.svg', 'image/svg+xml'),
      });
      assert.equal(svgUpload.status, 415);
      const disguisedPhoto = await fetch(`${origin}/api/quality/upload?projectId=project-http&checkpointId=checkpoint-http`, {
        method: 'POST', headers: { cookie: httpUserCookie },
        body: multipart('<html><script>alert(1)</script>', 'attack.jpg', 'image/jpeg'),
      });
      assert.equal(disguisedPhoto.status, 415);
      const validPngBytes = new Uint8Array(2_048);
      validPngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      const validPhotoUpload = await fetch(`${origin}/api/quality/upload?projectId=project-http&checkpointId=checkpoint-http`, {
        method: 'POST', headers: { cookie: httpUserCookie },
        body: multipart(validPngBytes, 'proof.png', 'image/png'),
      });
      assert.equal(validPhotoUpload.status, 201);
      const validPhotoBody = await validPhotoUpload.json() as { photo: { fileKey: string; [key: string]: unknown } };

      const disguisedDocument = await fetch(`${origin}/api/documents/upload?projectId=project-http`, {
        method: 'POST', headers: { cookie: httpUserCookie },
        body: multipart('<html><script>alert(1)</script>', 'invoice.pdf', 'text/html'),
      });
      assert.equal(disguisedDocument.status, 415);
      const validDocumentUpload = await fetch(`${origin}/api/documents/upload?projectId=project-http`, {
        method: 'POST', headers: { cookie: httpUserCookie },
        body: multipart('%PDF-1.7\n', 'contract.pdf', 'application/pdf'),
      });
      assert.equal(validDocumentUpload.status, 201);
      assert.equal(((await validDocumentUpload.json()) as { file: { type: string } }).file.type, 'application/pdf');

      const testBucket = new FileBucket(clientRoot);
      const legacyPhotoKey = 'project-http/quality/checkpoint-http/legacy.svg';
      const legacyDocumentKey = 'project-http/legacy-document.jpg';
      const legacyFieldKey = 'project-http/field/legacy.svg';
      await testBucket.put(legacyPhotoKey, '<svg><script>alert(1)</script></svg>', { httpMetadata: { contentType: 'image/svg+xml' } });
      await testBucket.put(legacyDocumentKey, '<html><script>alert(1)</script></html>', { httpMetadata: { contentType: 'text/html' } });
      await testBucket.put(legacyFieldKey, '<svg><script>alert(1)</script></svg>', { httpMetadata: { contentType: 'image/svg+xml' } });
      const httpStateRow = (await pool.query("SELECT state_json,revision FROM project_state WHERE project_id='project-http'")).rows[0];
      const httpState = JSON.parse(httpStateRow.state_json);
      httpState.checkpoints[0].photos = [
        { id: 'valid-photo', name: 'proof.png', fileName: 'proof.png', fileKey: validPhotoBody.photo.fileKey, mimeType: 'image/png' },
        { id: 'legacy-photo', name: 'legacy.svg', fileName: 'legacy.svg', fileKey: legacyPhotoKey, mimeType: 'image/svg+xml' },
      ];
      httpState.documents = [{ id: 'legacy-document', name: 'Legacy', fileName: 'legacy.jpg', fileKey: legacyDocumentKey, clientVisible: false }];
      httpState.fieldReports = [{ id: 'legacy-report', clientVisible: false, attachments: [{ id: 'legacy-field', name: 'legacy.svg', key: legacyFieldKey }] }];
      await pool.query(
        "UPDATE project_state SET state_json=$1,revision=$2 WHERE project_id='project-http'",
        [JSON.stringify(httpState), Number(httpStateRow.revision) + 1],
      );

      const validPhotoFile = await fetch(`${origin}/api/quality/file?projectId=project-http&key=${encodeURIComponent(validPhotoBody.photo.fileKey)}`, { headers: { cookie: httpUserCookie } });
      assert.equal(validPhotoFile.status, 200);
      assert.equal(validPhotoFile.headers.get('content-type'), 'image/png');
      assert.match(validPhotoFile.headers.get('content-disposition') || '', /^inline;/);
      assert.match(validPhotoFile.headers.get('content-security-policy') || '', /sandbox/);
      assert.deepEqual(new Uint8Array(await validPhotoFile.arrayBuffer()), validPngBytes);

      const legacyPhoto = await fetch(`${origin}/api/quality/file?projectId=project-http&key=${encodeURIComponent(legacyPhotoKey)}`, { headers: { cookie: httpUserCookie } });
      assert.equal(legacyPhoto.headers.get('content-type'), 'application/octet-stream');
      assert.match(legacyPhoto.headers.get('content-disposition') || '', /^attachment;/);
      await legacyPhoto.arrayBuffer();
      const legacyDocument = await fetch(`${origin}/api/documents/file?projectId=project-http&key=${encodeURIComponent(legacyDocumentKey)}`, { headers: { cookie: httpUserCookie } });
      assert.equal(legacyDocument.headers.get('content-type'), 'application/octet-stream');
      assert.match(legacyDocument.headers.get('content-disposition') || '', /^attachment;/);
      assert.match(legacyDocument.headers.get('content-security-policy') || '', /default-src 'none'/);
      const legacyField = await fetch(`${origin}/api/field-reports/file?projectId=project-http&key=${encodeURIComponent(legacyFieldKey)}`, { headers: { cookie: httpUserCookie } });
      assert.equal(legacyField.headers.get('content-type'), 'application/octet-stream');
      assert.match(legacyField.headers.get('content-disposition') || '', /^attachment;/);

      const staffLogin = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'ivan@example.test', password: 'atomic-latest-password-456' }),
      });
      assert.equal(staffLogin.status, 303);
      const staffCookie = (staffLogin.headers.get('set-cookie') || '').split(';', 1)[0];
      const staffAdmin = await fetch(`${origin}/api/access/users?projectId=project-a`, { headers: { cookie: staffCookie } });
      assert.equal(staffAdmin.status, 403);
      const staffProfilePatch = await fetch(`${origin}/api/access/users/${encodeURIComponent(httpProfileBody.user.id)}`, {
        method: 'PATCH',
        headers: { cookie: staffCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-http',
          user: { name: 'Подмена', email: 'http.new@example.test', role: 'management' },
        }),
      });
      assert.equal(staffProfilePatch.status, 403);
      const crossProject = await fetch(`${origin}/api/state?projectId=project-c`, { headers: { cookie: staffCookie } });
      assert.equal(crossProject.status, 403);

      const block = await fetch(`${origin}/api/access/users/user-1/block`, {
        method: 'POST',
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-b' }),
      });
      assert.equal(block.status, 200);
      const blockedProject = await fetch(`${origin}/api/state?projectId=project-b`, { headers: { cookie: staffCookie } });
      assert.equal(blockedProject.status, 401);

      const logout = await fetch(`${origin}/api/auth/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: staffCookie } });
      assert.equal(logout.status, 303);
      assert.match(logout.headers.get('clear-site-data') || '', /storage/);
      const afterLogout = await fetch(`${origin}/`, { redirect: 'manual', headers: { cookie: staffCookie, accept: 'text/html' } });
      assert.equal(afterLogout.status, 303);
    } finally {
      server.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (server.exitCode !== null) resolve();
        else server.once('exit', () => resolve());
      });
      await rm(clientRoot, { recursive: true, force: true });
    }

    const legacyMigrationReset = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test', purpose: 'reset' });
    const legacyMigrationToken = new URL(legacyMigrationReset.url).pathname.split('/').pop()!;
    await pool.query("UPDATE system_meta SET value='1',updated_at=$1 WHERE key='auth_schema_version'", [new Date().toISOString()]);
    await pool.query('UPDATE auth_tokens SET revoked_at=NULL WHERE token_hash=$1', [hashAccessToken(legacyMigrationToken)]);
    const migrationService = new UserAccessService({
      database,
      ownerEmail: 'owner@example.test', ownerName: 'Владелец', ownerUsername: 'owner',
      ownerPassword: 'owner-password-strong-123', publicUrl: 'https://stroios.example.test',
    });
    await migrationService.initialize();
    assert.equal((await pool.query("SELECT value FROM system_meta WHERE key='auth_schema_version'")).rows[0].value, String(ACCESS_SCHEMA_VERSION));
    assert.ok((await pool.query('SELECT revoked_at FROM auth_tokens WHERE token_hash=$1', [hashAccessToken(legacyMigrationToken)])).rows[0].revoked_at);
    await assert.rejects(() => migrationService.inspectToken(legacyMigrationToken), (error: AccessError) => error.code === 'invite_invalid');

    const restoredSession = await service.authenticate('ivan@example.test', 'atomic-latest-password-456', { ip: '198.51.100.251' });
    const restoredReset = await service.issueToken({ projectId: 'project-a', userId: 'user-1', actorEmail: 'owner@example.test', purpose: 'reset' });
    const restoredResetToken = new URL(restoredReset.url).pathname.split('/').pop()!;
    const restoreRevocation = await revokeRestoredAccess(pool);
    assert.ok(restoreRevocation.revokedSessions >= 1);
    assert.ok(restoreRevocation.revokedTokens >= 1);
    assert.equal(await service.fromRequest(sessionRequest(restoredSession.token)), null);
    await assert.rejects(() => service.inspectToken(restoredResetToken), (error: AccessError) => error.code === 'invite_invalid');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM auth_login_limits')).rows[0].count, 0);
  } finally {
    await database.close();
  }
});
