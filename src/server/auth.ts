import type { IncomingHttpHeaders } from 'node:http';

import type { ResolvedConfig, ResolvedProfileConfig } from '../config/types.js';
import { AppError } from '../errors/AppError.js';

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

export function extractBearerToken(headers: IncomingHttpHeaders): string {
  const authorization = readHeaderValue(headers.authorization);

  if (!authorization) {
    throw new AppError('AUTH_MISSING', 'Missing Authorization header.', 401);
  }

  const [scheme, token] = authorization.split(/\s+/, 2);

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new AppError('AUTH_INVALID', 'Authorization header must use Bearer authentication.', 401);
  }

  return token;
}

export function authenticateRequest(headers: IncomingHttpHeaders, config: ResolvedConfig): ResolvedProfileConfig {
  const token = extractBearerToken(headers);
  const enabledProfiles = Object.values(config.profiles).filter((profile) => profile.enabled);
  const matchedProfiles = enabledProfiles.filter((profile) => profile.apiKey === token);

  if (matchedProfiles.length === 0) {
    throw new AppError('AUTH_INVALID', 'Unknown API key.', 401);
  }

  if (matchedProfiles.length > 1) {
    throw new AppError('AUTH_INVALID', 'API key resolved to multiple profiles.', 401);
  }

  const matchedProfile = matchedProfiles[0];

  if (!matchedProfile) {
    throw new AppError('AUTH_INVALID', 'Unknown API key.', 401);
  }

  if (!matchedProfile.enabled) {
    throw new AppError('PROFILE_DISABLED', `Profile ${matchedProfile.id} is disabled.`, 403);
  }

  return matchedProfile;
}
