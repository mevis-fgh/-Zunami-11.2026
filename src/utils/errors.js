/**
 * HTTP-ошибки и вспомогательные обёртки для Express.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {unknown} [details]
   * @param {string} [code]
   */
  constructor(status, message, details, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
    this.code = code || `HTTP_${status}`;
    this.expose = status < 500;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details, 'BAD_REQUEST');
export const unauthorized = (message = 'Unauthorized') => new HttpError(401, message, undefined, 'UNAUTHORIZED');
export const forbidden = (message = 'Forbidden', details) => new HttpError(403, message, details, 'FORBIDDEN');
export const notFound = (message = 'Not found') => new HttpError(404, message, undefined, 'NOT_FOUND');
export const conflict = (message, details) => new HttpError(409, message, details, 'CONFLICT');
export const payloadTooLarge = (message = 'Payload too large') => new HttpError(413, message, undefined, 'PAYLOAD_TOO_LARGE');
export const badGateway = (message, details) => new HttpError(502, message, details, 'BAD_GATEWAY');
export const gatewayTimeout = (message = 'Upstream timeout') => new HttpError(504, message, undefined, 'GATEWAY_TIMEOUT');

/**
 * Оборачивает async-обработчик, чтобы отклонённый промис попал в error middleware.
 * @param {import('express').RequestHandler} handler
 * @returns {import('express').RequestHandler}
 */
export function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * @param {unknown} error
 */
export function errorPayload(error) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : 'Internal server error';
  const payload = { error: { message, code: error?.code || 'INTERNAL_ERROR', status } };
  if (error?.details !== undefined) payload.error.details = error.details;
  return payload;
}
