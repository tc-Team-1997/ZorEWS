// services/bff/__tests__/jwks_client.test.ts
//
// Coverage for the BFF JWT verifier (T4.24 Phase 7).
//
// The BFF tenant middleware uses two verifier modes:
//   - InsecureDecodeVerifier: base64-decode only, no signature check.
//     Default for hermetic tests + dev. (Documented Phase 3 shim.)
//   - JwksVerifier: real RS256 verification against a remote JWKS.
//     Production / integration. Tested here with an in-process JWKS
//     served by jose's generated keypair.
//
// We don't test JwksVerifier against a real auth-svc instance — that's
// the integration suite's job. Instead we generate a keypair locally,
// sign a token with the private half, expose the public half via a
// minimal in-memory HTTP server, and verify that JwksVerifier fetches
// + caches + validates correctly.

import express from 'express';
import * as http from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import {
  InsecureDecodeVerifier,
  JwksVerifier,
  makeJwtVerifier,
} from '../src/jwks_client';

describe('InsecureDecodeVerifier', () => {
  test('decodes a well-formed JWT payload without verifying', async () => {
    const v = new InsecureDecodeVerifier();
    const payload = { sub: 'u-1', tenant_id: 'BANK_DEMO', role: 'admin' };
    const token =
      Buffer.from(JSON.stringify({ alg: 'none' }))
        .toString('base64url') +
      '.' +
      Buffer.from(JSON.stringify(payload)).toString('base64url') +
      '.' +
      'fake-signature';
    const decoded = await v.verify(token);
    expect(decoded?.tenant_id).toBe('BANK_DEMO');
    expect(decoded?.role).toBe('admin');
  });

  test('returns undefined for malformed input', async () => {
    const v = new InsecureDecodeVerifier();
    expect(await v.verify('not-a-jwt')).toBeUndefined();
    expect(await v.verify('')).toBeUndefined();
    expect(await v.verify('a.b')).toBeUndefined(); // 2 parts, not 3
  });
});

describe('JwksVerifier', () => {
  let server: http.Server;
  let baseUrl: string;
  let privateKey: KeyLike;
  const KID = 'test-key-1';

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256', { extractable: true });
    privateKey = kp.privateKey;
    const publicJwk = await exportJWK(kp.publicKey);

    // Minimal JWKS server — exposes our generated public key.
    const app = express();
    app.get('/.well-known/jwks.json', (_req, res) => {
      res.json({
        keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }],
      });
    });
    server = app.listen(0); // random port
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server.close();
  });

  function makeToken(
    claims: Record<string, unknown>,
    opts: { expiresInSec?: number; kid?: string } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? KID })
      .setIssuer('apex-ews-auth')
      .setAudience('apex-ews')
      .setIssuedAt()
      .setExpirationTime(`${opts.expiresInSec ?? 900}s`)
      .sign(privateKey);
  }

  test('verifies a properly signed token', async () => {
    const v = new JwksVerifier(`${baseUrl}/.well-known/jwks.json`);
    const token = await makeToken({
      sub: 'u-1',
      role: 'admin',
      tenant_id: 'BANK_DEMO',
    });
    const decoded = await v.verify(token);
    expect(decoded?.tenant_id).toBe('BANK_DEMO');
    expect(decoded?.role).toBe('admin');
  });

  test('rejects a forged signature (token signed with a different key)', async () => {
    const v = new JwksVerifier(`${baseUrl}/.well-known/jwks.json`);
    // Generate a new keypair and sign with it — the JWKS server doesn't
    // know about this key, so verification must fail.
    const evil = await generateKeyPair('RS256', { extractable: true });
    const forged = await new SignJWT({
      sub: 'u-evil',
      tenant_id: 'BIL', // an attacker pretending to be BIL
      role: 'admin',
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer('apex-ews-auth')
      .setAudience('apex-ews')
      .setIssuedAt()
      .setExpirationTime('900s')
      .sign(evil.privateKey);
    expect(await v.verify(forged)).toBeUndefined();
  });

  test('rejects an expired token', async () => {
    const v = new JwksVerifier(`${baseUrl}/.well-known/jwks.json`);
    const token = await new SignJWT({ sub: 'u-1', tenant_id: 'BANK_DEMO' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer('apex-ews-auth')
      .setAudience('apex-ews')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 10_000)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1) // expired 1s ago
      .sign(privateKey);
    expect(await v.verify(token)).toBeUndefined();
  });

  test('rejects a token with the wrong issuer', async () => {
    const v = new JwksVerifier(`${baseUrl}/.well-known/jwks.json`);
    const token = await new SignJWT({ tenant_id: 'BANK_DEMO' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer('rogue-issuer')
      .setAudience('apex-ews')
      .setIssuedAt()
      .setExpirationTime('900s')
      .sign(privateKey);
    expect(await v.verify(token)).toBeUndefined();
  });

  test('rejects a token with the wrong audience', async () => {
    const v = new JwksVerifier(`${baseUrl}/.well-known/jwks.json`);
    const token = await new SignJWT({ tenant_id: 'BANK_DEMO' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer('apex-ews-auth')
      .setAudience('different-aud')
      .setIssuedAt()
      .setExpirationTime('900s')
      .sign(privateKey);
    expect(await v.verify(token)).toBeUndefined();
  });

  test('tampered claim — signature fails because the body changed', async () => {
    const v = new JwksVerifier(`${baseUrl}/.well-known/jwks.json`);
    const token = await makeToken({
      sub: 'u-1',
      tenant_id: 'BANK_DEMO',
      role: 'risk_analyst',
    });
    // Replace the middle (payload) segment with a tampered one — keep
    // header + signature so the signature won't match the new payload.
    const parts = token.split('.');
    const tampered = JSON.stringify({
      sub: 'u-1',
      tenant_id: 'BIL', // attacker hopes to escalate from BANK_DEMO -> BIL
      role: 'admin', // and to admin
    });
    parts[1] = Buffer.from(tampered).toString('base64url');
    const evilToken = parts.join('.');
    expect(await v.verify(evilToken)).toBeUndefined();
  });
});

describe('makeJwtVerifier factory', () => {
  test('BFF_JWKS_URL set → JwksVerifier', () => {
    const v = makeJwtVerifier({ BFF_JWKS_URL: 'http://example.test/jwks.json' });
    expect(v).toBeInstanceOf(JwksVerifier);
  });

  test('BFF_JWKS_URL unset → InsecureDecodeVerifier', () => {
    const v = makeJwtVerifier({});
    expect(v).toBeInstanceOf(InsecureDecodeVerifier);
  });
});
