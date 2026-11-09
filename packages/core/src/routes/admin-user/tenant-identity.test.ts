import crypto from 'node:crypto';

import { ConnectorError, ConnectorErrorCodes } from '@logto/connector-kit';
import { ConnectorType, SecretType, type SocialTokenSetSecret } from '@logto/schemas';
import { createMockPool, createMockQueryResult } from '@silverhand/slonik';
import Sinon from 'sinon';

import {
  mockConnector0,
  mockLogtoConnector,
  mockMetadata0,
  mockUser,
} from '#src/__mocks__/index.js';
import { EnvSet } from '#src/env-set/index.js';
import koaErrorHandler from '#src/middleware/koa-error-handler.js';
import koaI18next from '#src/middleware/koa-i18next.js';
import SecretQueries from '#src/queries/secret.js';
import { MockTenant } from '#src/test-utils/tenant.js';
import { decryptTokens, encryptTokens } from '#src/utils/secret-encryption.js';
import { createRequester } from '#src/utils/test-utils.js';

import tenantIdentityRoutes from './tenant-identity.js';

const { jest } = import.meta;
const sourceId = '00000000-0000-4000-8000-000000000001';
const tenantId = '00000000-0000-4000-8000-000000000002';
const guestId = '00000000-0000-4000-8000-000000000003';
const body = { tenantId, expectedIdentityId: sourceId };
const route = '/users/example/identities/azuread/tenant-identity';

const harness = (actor: 'app' | 'user' = 'app') => {
  const state = { linkedId: jest.fn(() => sourceId), secretExists: jest.fn(() => true) };
  const secret: SocialTokenSetSecret = {
    id: 'example-secret',
    tenantId: 'default',
    userId: 'example',
    type: SecretType.FederatedTokenSet,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: { hasRefreshToken: true },
    connectorId: mockConnector0.id,
    identityId: sourceId,
    target: 'azuread',
    ...encryptTokens({ access_token: 'source-access-token', refresh_token: 'private-cache' }),
  };
  const resolve = jest.fn(async () => ({
    identity: { tenantId, userId: guestId },
    refreshToken: 'rotated-private-cache',
  }));
  const connector = {
    ...mockLogtoConnector,
    type: ConnectorType.Social as const,
    metadata: { ...mockMetadata0, target: 'azuread', isTokenStorageSupported: true },
    dbEntry: { ...mockConnector0, enableTokenStorage: true },
    getUserInfo: async () => ({ id: sourceId }),
    getAuthorizationUri: async () => '',
    getIdentityForTenant: resolve,
  };
  const getConnector = jest.fn(async () => connector);
  const vault = new SecretQueries(
    createMockPool({
      query: async (sql) => {
        if (sql.includes('for update')) {
          return createMockQueryResult(
            state.linkedId() === sourceId && state.secretExists() ? [{ id: 'example' }] : []
          );
        }
        return createMockQueryResult(state.secretExists() ? [{ id: secret.id }] : []);
      },
    })
  );
  const update = jest.spyOn(vault, 'updateSocialTokenSetSecret');
  const readSecret = jest.fn(async () => secret);
  const tenantContext = new MockTenant(
    undefined,
    {
      users: {
        findUserById: async () => ({
          ...mockUser,
          identities: { azuread: { userId: state.linkedId() } },
        }),
      },
      secrets: {
        findSocialTokenSetSecretByUserIdAndTarget: readSecret,
        updateSocialTokenSetSecret: vault.updateSocialTokenSetSecret.bind(vault),
      },
    },
    { getLogtoConnectorById: getConnector }
  );
  const request = createRequester({
    middlewares: [koaI18next(), koaErrorHandler()],
    authedRoutes: [
      (router) => {
        router.use(async (ctx, next) => {
          ctx.auth.type = actor;
          return next();
        });
      },
      tenantIdentityRoutes,
    ],
    tenantContext,
  });
  return { request, state, secret, resolve, update, readSecret, connector, getConnector };
};

beforeAll(() => {
  Sinon.stub(EnvSet, 'values').value({
    ...EnvSet.values,
    secretVaultKek: crypto.randomBytes(32).toString('base64'),
  });
});
afterAll(() => {
  Sinon.restore();
});

describe('Management API tenant identity proof', () => {
  it('returns only verified IDs and refreshes the encrypted cache without replacing the original access token', async () => {
    const { request, update, resolve } = harness();
    const response = await request.post(route).send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tenantId, userId: guestId });
    expect(resolve).toHaveBeenCalledWith('private-cache', { tenantId, userId: sourceId });
    expect(decryptTokens(update.mock.calls[0]![1])).toEqual({
      access_token: 'source-access-token',
      refresh_token: 'rotated-private-cache',
    });
  });

  it('denies human tokens before reading the vault', async () => {
    const { request, readSecret } = harness('user');
    const response = await request.post(route).send(body);
    expect(response.status).toBe(403);
    expect(readSecret).not.toHaveBeenCalled();
  });

  it.each(['source', 'vault', 'storage', 'tenant'])(
    'rejects inconsistent %s evidence',
    async (fault) => {
      const { request, state, secret, connector, resolve, update, readSecret, getConnector } =
        harness();
      if (fault === 'source') {
        state.linkedId.mockReturnValue(guestId);
      }
      if (fault === 'vault') {
        readSecret.mockResolvedValue({ ...secret, identityId: guestId });
      }
      if (fault === 'storage') {
        getConnector.mockResolvedValue({
          ...connector,
          dbEntry: { ...connector.dbEntry, enableTokenStorage: false },
        });
      }
      if (fault === 'tenant') {
        resolve.mockResolvedValue({
          identity: { tenantId: guestId, userId: guestId },
          refreshToken: 'wrong-cache',
        });
      }
      const response = await request.post(route).send(body);
      expect(response.status).toBe(fault === 'tenant' ? 502 : 422);
      expect(update).not.toHaveBeenCalled();
    }
  );

  it.each(['relink', 'same-identity-new-login'])(
    'rejects %s during provider resolution',
    async (change) => {
      const { request, state, resolve } = harness();
      resolve.mockImplementation(async () => {
        if (change === 'relink') {
          state.linkedId.mockReturnValue(guestId);
        }
        state.secretExists.mockReturnValue(false);
        return { identity: { tenantId, userId: guestId }, refreshToken: 'obsolete-cache' };
      });
      const response = await request.post(route).send(body);
      expect(response.status).toBe(422);
    }
  );

  it('distinguishes reauthentication from transient provider failure', async () => {
    const { request, resolve } = harness();
    resolve.mockRejectedValue(new ConnectorError(ConnectorErrorCodes.SocialAccessTokenInvalid));
    const retryLogin = await request.post(route).send(body);
    expect(retryLogin.status).toBe(422);
    expect(retryLogin.body.code).toBe('connector.social_invalid_access_token');
    resolve.mockRejectedValue(new Error('private-provider-detail'));
    const outage = await request.post(route).send(body);
    expect(outage.status).toBe(502);
    expect(JSON.stringify(outage.body)).not.toContain('private-provider-detail');
  });
});
