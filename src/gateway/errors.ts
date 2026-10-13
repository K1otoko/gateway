import { STATUS_CODES } from 'node:http';

import type { FastifyInstance } from 'fastify';

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'No gateway route matches this request',
      requestId: request.id,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const errorCode =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined;
    const errorStatusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : undefined;
    let statusCode = 500;

    if (errorCode === 'FST_REPLY_FROM_INTERNAL_SERVER_ERROR') {
      statusCode = 502;
    } else if (
      errorStatusCode &&
      errorStatusCode >= 400 &&
      errorStatusCode < 600
    ) {
      statusCode = errorStatusCode;
    }

    const errorName = STATUS_CODES[statusCode] ?? 'Error';
    const message = error instanceof Error ? error.message : errorName;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.warn({ err: error }, 'request rejected');
    }

    return reply.status(statusCode).send({
      statusCode,
      error: errorName,
      message: statusCode >= 500 ? errorName : message,
      requestId: request.id,
    });
  });
}
