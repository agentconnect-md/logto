import nock from 'nock';

import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import createConnector from './index.js';

const homeTenant = '00000000-0000-4000-8000-000000000011';
const guestTenant = '00000000-0000-4000-8000-000000000012';
const homeId = '00000000-0000-4000-8000-000000000013';
const guestId = '00000000-0000-4000-8000-000000000014';
const clientId = '00000000-0000-4000-8000-000000000015';
const authority = 'https://login.microsoftonline.com';
const json64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenResponse = (tenantId: string, userId: string, accessToken: string) => ({
  access_token: accessToken,
  refresh_token: 'example-refresh-token',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'User.Read',
  client_info: json64({ uid: homeId, utid: homeTenant }),
  id_token: `${json64({ alg: 'RS256', typ: 'JWT' })}.${json64({ aud: clientId, iss: `${authority}/${tenantId}/v2.0`, tid: tenantId, oid: userId, sub: 'example-subject', name: 'Alex', preferred_username: 'alex@example.test', exp: Math.floor(Date.now() / 1000) + 3600 })}.example-signature`,
});

afterEach(() => {
  nock.cleanAll();
});
beforeAll(() => {
  nock.disableNetConnect();
});
afterAll(() => {
  nock.enableNetConnect();
});

it('uses the real MSAL cache to refresh the same account in a guest tenant', async () => {
  nock(authority)
    .persist()
    .get(/\/v2\.0\/\.well-known\/openid-configuration/)
    .reply(200, (uri) => {
      const tenant = uri.split('/')[1];
      return {
        authorization_endpoint: `${authority}/${tenant}/oauth2/v2.0/authorize`,
        token_endpoint: `${authority}/${tenant}/oauth2/v2.0/token`,
        issuer: `${authority}/${tenant}/v2.0`,
        jwks_uri: `${authority}/${tenant}/discovery/v2.0/keys`,
        end_session_endpoint: `${authority}/${tenant}/oauth2/v2.0/logout`,
      };
    });
  nock(authority)
    .persist()
    .get('/common/discovery/instance')
    .query(true)
    .reply(200, {
      tenant_discovery_endpoint: `${authority}/organizations/v2.0/.well-known/openid-configuration`,
      metadata: [
        {
          preferred_network: 'login.microsoftonline.com',
          preferred_cache: 'login.windows.net',
          aliases: [
            'login.microsoftonline.com',
            'login.windows.net',
            'login.microsoft.com',
            'sts.windows.net',
          ],
        },
      ],
    });
  const login = nock(authority)
    .post('/organizations/oauth2/v2.0/token')
    .reply(200, tokenResponse(homeTenant, homeId, 'source-token'));
  const refresh = nock(authority)
    .post(`/${guestTenant}/oauth2/v2.0/token`, (body: string) => {
      const params = new URLSearchParams(body);
      return (
        params.get('grant_type') === 'refresh_token' &&
        (params
          .get('scope')
          ?.split(' ')
          .every((scope) => ['User.Read', 'openid', 'profile', 'offline_access'].includes(scope)) ??
          false)
      );
    })
    .reply(200, tokenResponse(guestTenant, guestId, 'guest-token'));
  const sourceRefresh = nock(authority)
    .post(`/${homeTenant}/oauth2/v2.0/token`)
    .reply(200, tokenResponse(homeTenant, homeId, 'source-token'));
  nock('https://graph.microsoft.com')
    .get('/v1.0/me')
    .matchHeader('authorization', 'Bearer source-token')
    .twice()
    .reply(200, { id: homeId, mail: 'alex@example.test' });
  nock('https://graph.microsoft.com')
    .get('/v1.0/me')
    .matchHeader('authorization', 'Bearer guest-token')
    .reply(200, { id: guestId, mail: 'alex@example.test' });
  const connector = await createConnector({
    getConfig: async () => ({
      clientId,
      clientSecret: 'example-secret',
      tenantId: 'organizations',
      cloudInstance: authority,
      disableEmailSync: true,
    }),
  });
  const signedIn = await connector.getTokenResponseAndUserInfo!(
    { code: 'example-code', redirectUri: 'https://login.example.test/callback' },
    vi.fn()
  );
  const resolved = await connector.getIdentityForTenant!(signedIn.tokenResponse!.refresh_token!, {
    userId: homeId,
    tenantId: guestTenant,
  });
  expect(signedIn.userInfo.id).toBe(homeId);
  expect(resolved.identity).toEqual({ tenantId: guestTenant, userId: guestId });
  expect(login.isDone()).toBe(true);
  expect(refresh.isDone()).toBe(true);
  const refreshed = await connector.getAccessTokenByRefreshToken!(resolved.refreshToken);
  expect(refreshed.access_token).toBe('source-token');
  expect(sourceRefresh.isDone()).toBe(true);
});
