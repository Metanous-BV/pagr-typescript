import { describe, expect, it } from 'vitest';
import {
  ApiError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  PagrConnectionError,
  PagrDecodeError,
  PagrError,
  PagrTimeoutError,
  PayloadTooLargeError,
  RateLimitError,
  STATUS_TO_ERROR,
  ValidationFailedError,
} from '../src/errors.js';

describe('PagrError hierarchy', () => {
  it('carries statusCode and code', () => {
    const err = new AuthenticationError('bad key', 401, 'InvalidApiKey');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('InvalidApiKey');
    expect(err.message).toBe('bad key');
  });

  it('every subclass is an instanceof PagrError and Error', () => {
    const subclasses = [
      new AuthenticationError('x'),
      new ForbiddenError('x'),
      new NotFoundError('x'),
      new PayloadTooLargeError('x'),
      new ValidationFailedError('x'),
      new RateLimitError('x'),
      new ApiError('x'),
      new PagrConnectionError('x'),
      new PagrDecodeError('x'),
      new PagrTimeoutError('x'),
    ];
    for (const err of subclasses) {
      expect(err).toBeInstanceOf(PagrError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('transport failures carry no statusCode/code and preserve the cause', () => {
    const cause = new Error('ECONNREFUSED');
    const conn = new PagrConnectionError('could not reach', { cause });
    expect(conn.statusCode).toBeUndefined();
    expect(conn.code).toBeUndefined();
    expect(conn.cause).toBe(cause);

    const timeout = new PagrTimeoutError('timed out');
    expect(timeout).toBeInstanceOf(PagrError);
    expect(timeout.statusCode).toBeUndefined();
  });

  it('PagrDecodeError carries the originating status code', () => {
    const err = new PagrDecodeError('bad body', 200);
    expect(err.statusCode).toBe(200);
    expect(err.code).toBeUndefined();
  });

  it('RateLimitError exposes a parsed retryAfter', () => {
    const err = new RateLimitError('slow down', 429, 'RateLimited', 7);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfter).toBe(7);
    expect(new RateLimitError('x').retryAfter).toBeUndefined();
  });

  it('a bare PagrError has no statusCode/code (network/parse failures)', () => {
    const err = new PagrError('network error');
    expect(err.statusCode).toBeUndefined();
    expect(err.code).toBeUndefined();
  });

  it('STATUS_TO_ERROR maps every documented status code', () => {
    expect(STATUS_TO_ERROR[401]).toBe(AuthenticationError);
    expect(STATUS_TO_ERROR[403]).toBe(ForbiddenError);
    expect(STATUS_TO_ERROR[404]).toBe(NotFoundError);
    expect(STATUS_TO_ERROR[413]).toBe(PayloadTooLargeError);
    expect(STATUS_TO_ERROR[422]).toBe(ValidationFailedError);
    expect(STATUS_TO_ERROR[429]).toBe(RateLimitError);
    expect(STATUS_TO_ERROR[400]).toBeUndefined();
    expect(STATUS_TO_ERROR[503]).toBeUndefined();
  });
});
