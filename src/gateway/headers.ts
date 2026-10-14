import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { IncomingHttpHeaders as Http2IncomingHttpHeaders } from 'node:http2';

import type {
  FastifyRequest,
  RawServerBase,
  RequestGenericInterface,
} from 'fastify';

export type ProxyHeaders = IncomingHttpHeaders | Http2IncomingHttpHeaders;
export type ProxyRequest = FastifyRequest<
  RequestGenericInterface,
  RawServerBase
>;

export function generateRequestId(request: IncomingMessage): string {
  const requestId = request.headers['x-request-id'];

  if (
    typeof requestId === 'string' &&
    requestId.length > 0 &&
    requestId.length <= 128
  ) {
    return requestId;
  }

  return randomUUID();
}

export function buildUpstreamHeaders(
  request: ProxyRequest,
  headers: ProxyHeaders,
  upstream: string,
): ProxyHeaders {
  const sanitizedHeaders = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !name.toLowerCase().startsWith('x-user-'),
    ),
  );
  const identityHeaders =
    request.authenticatedUser === null
      ? {}
      : {
          'x-user-id': request.authenticatedUser.id,
          'x-user-role': request.authenticatedUser.role,
        };

  return {
    ...sanitizedHeaders,
    ...identityHeaders,
    host: new URL(upstream).host,
    'x-forwarded-for': request.ip,
    'x-forwarded-host': request.headers.host,
    'x-forwarded-proto': request.protocol,
    'x-request-id': request.id,
  };
}
