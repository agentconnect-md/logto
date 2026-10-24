import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPool,
  createUserQueries,
  SecretQueries,
  createSocialLibrary,
  SocialVerification,
  identifyUserByVerificationRecord,
  toUserSocialIdentityData,
  sql,
  VerificationType,
  ConnectorType,
} from '/etc/logto/packages/core/verification/identity-preservation-verification.js';

// Run only against a disposable database seeded by this exact fork image.
assert(
  process.env.DB_URL?.includes('logto-fork-db'),
  'A disposable logto-fork-db host is required'
);
const pool = await createPool(process.env.DB_URL, false, 3, 5000, 10000);
const users = createUserQueries(pool);
const secrets = new SecretQueries(pool);
const queries = { users, secrets };
const socials = createSocialLibrary(queries, {
  getLogtoConnectorById: async (id) => ({
    type: ConnectorType.Social,
    metadata: { target: id },
    dbEntry: { syncProfile: true },
  }),
});
const work = { id: 'google-work', email: 'alice@work.example.test', name: 'Work account' };
const personal = { id: 'google-personal', email: 'alice@example.test', name: 'Personal account' };
const identity = (info) => ({ userId: info.id, details: info });
const readUser = () => users.findUserById('verify-main');
const readToken = () => secrets.findSocialTokenSetSecretByUserIdAndTarget('verify-main', 'google');
const encrypted = (marker) => ({
  encryptedTokenSetBase64: Buffer.from(
    JSON.stringify(
      Object.fromEntries(
        ['encryptedDek', 'iv', 'authTag', 'ciphertext'].map((key) => [
          key,
          Buffer.from(marker).toString('base64'),
        ])
      )
    )
  ).toString('base64'),
  metadata: { scope: 'openid profile email', hasRefreshToken: true },
});
const token = (info, marker, target = 'google') => ({
  encryptedTokenSet: encrypted(marker),
  socialConnectorRelationPayload: { connectorId: target, target, identityId: info.id },
});
const saveToken = (info, marker) =>
  socials.upsertSocialTokenSetSecret('verify-main', token(info, marker));

async function identify(info, { target = 'google', autoLink = true } = {}) {
  const record = new SocialVerification({ socials }, queries, {
    id: 'verified-record',
    type: VerificationType.Social,
    connectorId: target,
    socialUserInfo: info,
    encryptedTokenSet: encrypted(`token-${info.id}`),
  });
  try {
    return await identifyUserByVerificationRecord(record, false);
  } catch (error) {
    if (!autoLink || error.code !== 'user.identity_not_exist' || !error.data?.relatedUser)
      throw error;
    return identifyUserByVerificationRecord(record, true);
  }
}

async function login(info, options) {
  const { user, syncedProfile = {} } = await identify(info, options);
  const { socialIdentity, socialConnectorTokenSetSecret, ...profile } = syncedProfile;
  const updated = await users.updateUserFromSignIn(user.id, {
    ...profile,
    ...(socialIdentity && { identities: toUserSocialIdentityData(socialIdentity) }),
    lastSignInAt: Date.now(),
  });
  if (socialConnectorTokenSetSecret)
    await socials.upsertSocialTokenSetSecret(user.id, socialConnectorTokenSetSecret);
  return updated;
}

async function raceWithLink(change, delayed) {
  let release;
  let locked;
  const ready = new Promise((resolve) => {
    locked = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const link = pool.transaction(async (connection) => {
    await change(connection);
    locked();
    await gate;
  });
  await ready;
  const pending = delayed().then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      const { waiting } = await pool.one(sql`
        select exists(select 1 from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock') as waiting
      `);
      if (waiting) break;
      assert(Date.now() < deadline, 'Delayed writer never waited for the user row lock');
      await delay(20);
    }
  } finally {
    release();
    await link;
  }
  return pending;
}

try {
  await users.insertUser({
    id: 'verify-main',
    primaryEmail: personal.email,
    identities: { google: identity(work), github: { userId: 'github-main' } },
  });
  for (const target of ['google', 'gitlab']) {
    await pool.query(sql`insert into connectors(id, connector_id) values (${target}, ${target})`);
  }
  await saveToken(work, 'work-token-before-login');
  const before = await readToken();
  const bound = (await readUser()).identities;
  for (let i = 0; i < 2; i++) assert.equal((await login(personal)).id, 'verify-main');
  assert.deepEqual((await readUser()).identities, bound);
  assert.deepEqual(await readToken(), before);
  assert.equal((await login(work)).id, 'verify-main');
  assert.equal((await readToken()).identityId, work.id);
  assert.notEqual((await readToken()).id, before.id);
  console.log(
    'PASS: both verified Google accounts sign in to the same user; alternate login preserves binding and token bytes; bound login refreshes its own token'
  );

  const afterWork = await readToken();
  await assert.rejects(saveToken(personal, 'wrong-account-token'), {
    code: 'user.identity_not_exists_in_current_user',
  });
  assert.deepEqual(await readToken(), afterWork);
  await assert.rejects(identify(personal, { autoLink: false }), {
    code: 'user.identity_not_exist',
  });
  await assert.rejects(identify({ id: 'unknown', email: 'unknown@example.test' }), {
    code: 'user.identity_not_exist',
  });
  await users.insertUser({
    id: 'verify-other',
    primaryEmail: 'other@example.test',
    identities: { google: { userId: 'google-other' } },
  });
  assert.equal((await login({ id: 'google-other', email: personal.email })).id, 'verify-other');
  await login({ id: 'gitlab-main', email: personal.email }, { target: 'gitlab' });
  assert.equal((await readUser()).identities.gitlab.userId, 'gitlab-main');
  assert.equal((await readUser()).identities.github.userId, 'github-main');
  console.log(
    'PASS: unrelated email and disabled auto-link reject; exact identity owner wins; first provider link still works'
  );

  const replacement = { id: 'google-new-work', email: 'alice@new-work.example.test' };
  const concurrentSignIn = await raceWithLink(
    (connection) =>
      createUserQueries(connection).updateUserById('verify-main', {
        identities: { google: identity(replacement) },
      }),
    () => users.updateUserFromSignIn('verify-main', { identities: { google: identity(personal) } })
  );
  assert.ifError(concurrentSignIn.error);
  assert.equal((await readUser()).identities.google.userId, replacement.id);
  assert.equal((await readUser()).identities.gitlab.userId, 'gitlab-main');
  await users.updateUserById('verify-main', { identities: { google: identity(work) } });
  await saveToken(work, 'before-concurrent-link');
  const concurrentToken = await raceWithLink(
    async (connection) => {
      await createUserQueries(connection).updateUserById('verify-main', {
        identities: { google: identity(replacement) },
      });
      await createSocialLibrary(
        { users, secrets: new SecretQueries(connection) },
        {}
      ).upsertSocialTokenSetSecret('verify-main', token(replacement, 'new-work-token'));
    },
    () => saveToken(work, 'stale-work-token')
  );
  assert.equal(concurrentToken.error?.code, 'user.identity_not_exists_in_current_user');
  assert.equal((await readToken()).identityId, replacement.id);
  assert.equal((await readToken()).ciphertext.toString(), 'new-work-token');
  const afterUnlink = await raceWithLink(
    (connection) => createUserQueries(connection).deleteUserIdentity('verify-main', 'google'),
    () => saveToken(replacement, 'late-after-unlink')
  );
  assert.equal(afterUnlink.error?.code, 'user.identity_not_exists_in_current_user');
  assert.equal(await readToken(), null);
  assert.equal((await readUser()).identities.google, undefined);
  console.log(
    'PASS: real concurrent Link and Unlink serialize against sign-in/token writes; stale tokens cannot overwrite or return after Unlink'
  );
} finally {
  await pool.end();
}
