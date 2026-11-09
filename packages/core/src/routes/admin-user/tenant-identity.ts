import { ConnectorError, ConnectorErrorCodes } from '@logto/connector-kit';
import { ConnectorType } from '@logto/schemas';
import { object, string } from 'zod';

import RequestError from '#src/errors/RequestError/index.js';
import koaGuard from '#src/middleware/koa-guard.js';
import assertThat from '#src/utils/assert-that.js';
import { decryptTokens, encryptTokens } from '#src/utils/secret-encryption.js';

import type { ManagementApiRouter, RouterInitArgs } from '../types.js';

export default function tenantIdentityRoutes<T extends ManagementApiRouter>(
  ...[router, { queries, connectors }]: RouterInitArgs<T>
) {
  router.post(
    '/users/:userId/identities/:target/tenant-identity',
    koaGuard({
      params: object({ userId: string(), target: string() }),
      body: object({ tenantId: string().uuid(), expectedIdentityId: string().min(1) }),
      response: object({ tenantId: string().uuid(), userId: string().min(1) }),
      status: [200, 403, 404, 422, 502],
    }),
    async (ctx, next) => {
      assertThat(ctx.auth.type === 'app', 'auth.forbidden', 403);
      const {
        params: { userId, target },
        body: { tenantId, expectedIdentityId },
      } = ctx.guard;
      const { identities } = await queries.users.findUserById(userId);
      assertThat(
        identities[target]?.userId === expectedIdentityId,
        new RequestError({ code: 'user.identity_not_exists_in_current_user', status: 422 })
      );
      const secret = await queries.secrets.findSocialTokenSetSecretByUserIdAndTarget(
        userId,
        target
      );
      assertThat(
        secret?.identityId === expectedIdentityId,
        new RequestError({ code: 'secrets.third_party_token_set.token_not_found', status: 422 })
      );
      const connector = await connectors.getLogtoConnectorById(secret.connectorId);
      assertThat(
        connector.type === ConnectorType.Social &&
          connector.metadata.target === target &&
          connector.metadata.isTokenStorageSupported &&
          connector.dbEntry.enableTokenStorage &&
          connector.getIdentityForTenant,
        new RequestError({ code: 'connector.token_storage_not_supported', status: 422 })
      );
      const tokens = decryptTokens(secret);
      assertThat(
        tokens.refresh_token,
        new RequestError({ code: 'secrets.third_party_token_set.token_not_found', status: 422 })
      );
      const resolved = await connector
        .getIdentityForTenant(tokens.refresh_token, {
          tenantId,
          userId: expectedIdentityId,
        })
        .catch((error: unknown) => {
          if (
            error instanceof ConnectorError &&
            error.code === ConnectorErrorCodes.SocialAccessTokenInvalid
          ) {
            throw new RequestError({ code: 'connector.social_invalid_access_token', status: 422 });
          }
          throw new RequestError({ code: 'connector.general', status: 502 });
        });
      assertThat(
        resolved.identity.tenantId.toLowerCase() === tenantId.toLowerCase(),
        new RequestError({ code: 'connector.invalid_response', status: 502 })
      );
      await queries.secrets.updateSocialTokenSetSecret(
        secret,
        encryptTokens({
          ...tokens,
          refresh_token: resolved.refreshToken,
        })
      );
      ctx.body = { tenantId: resolved.identity.tenantId, userId: resolved.identity.userId };
      return next();
    }
  );
}
