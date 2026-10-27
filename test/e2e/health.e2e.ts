import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp } from '../helpers/test-app.js';

describe('health, errors and HTTP hardening', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await TestApp.create();
  });
  afterAll(async () => {
    await t.close();
  });

  it('reports liveness and readiness with real dependency checks', async () => {
    await t.http().get('/v1/health/live').expect(200);
    const ready = await t.http().get('/v1/health/ready').expect(200);
    expect(ready.body.status).toBe('ok');
    expect(ready.body.info.mongodb.status).toBe('up');
    expect(ready.body.info.redis.status).toBe('up');
  });

  it('returns RFC 9457 problem details for unknown routes with a request id', async () => {
    const res = await t.http().get('/v1/nope').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'route_not_found' });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('propagates a safe incoming request id and replaces unsafe ones', async () => {
    const ok = await t
      .http()
      .get('/v1/health/live')
      .set('x-request-id', 'abc12345-test')
      .expect(200);
    expect(ok.headers['x-request-id']).toBe('abc12345-test');
    const bad = await t.http().get('/v1/health/live').set('x-request-id', '<script>').expect(200);
    expect(bad.headers['x-request-id']).not.toBe('<script>');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await t.http().get('/v1/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('rejects malformed JSON and oversized bodies with problem details', async () => {
    const malformed = await t
      .http()
      .post('/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(malformed.body.code).toBe('malformed_body');
    const big = await t
      .http()
      .post('/v1/auth/login')
      .send({ email: 'a@b.co', password: 'x'.repeat(1_100_000) })
      .expect(413);
    expect(big.body.code).toBe('payload_too_large');
  });

  it('returns field-level validation errors', async () => {
    const res = await t
      .http()
      .post('/v1/auth/signup')
      .send({ email: 'not-an-email', password: 'short' })
      .expect(422);
    expect(res.body.code).toBe('validation_failed');
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(['body.email', 'body.password', 'body.name', 'body.acceptTerms']),
    );
  });

  it('protects metrics with a bearer token', async () => {
    await t.http().get('/metrics').expect(404);
    const res = await t
      .http()
      .get('/metrics')
      .set('authorization', 'Bearer test-metrics-token-123456')
      .expect(200);
    expect(res.text).toContain('sellora_http_request_duration_seconds');
  });

  it('allows CORS only for configured origins', async () => {
    const allowed = await t
      .http()
      .options('/v1/auth/login')
      .set('origin', 'http://localhost:3000')
      .set('access-control-request-method', 'POST');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const denied = await t
      .http()
      .options('/v1/auth/login')
      .set('origin', 'https://evil.example')
      .set('access-control-request-method', 'POST');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
