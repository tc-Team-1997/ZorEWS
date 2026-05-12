# auth-svc

JWT + TOTP MFA service for ZorEWS (T1.12 / FR-INT-4).

## Stack choice — Node.js + TypeScript (Fastify)

Picked over Python/FastAPI because:

1. **Same toolchain as the SPA** (`web/` is React + Vite + TS) — shared types possible.
2. **Lower memory + cold-start** than Python on small EKS pods (256 Mi limit).
3. **`jose`** has first-class support for KMS-signed JWTs via custom signers, matching FR-INT-4 + NFR-SEC-1 (no static signing key).
4. **`argon2`** native bindings are mature and cheap to maintain.

If a future requirement forces Python (e.g. shared lib with the AI services), the route layer in `src/routes/auth.ts` is intentionally thin and swappable.

## Endpoints

| Method | Path | Body | Notes |
|--------|------|------|-------|
| `POST` | `/auth/login` | `{username, password, totp}` | Returns `access_token` (15 min) + `refresh_token` (7 d). |
| `POST` | `/auth/refresh` | `{refresh_token}` | New `access_token`. |
| `GET`  | `/auth/me` | _Bearer header_ | Decoded sub/role/display_name. |
| `GET`  | `/healthz` | — | Liveness. |

## Security

- Password hashing: argon2id (default cost).
- TOTP: `otplib` `authenticator.check`, RFC 6238, 30-s window, ±1 step skew.
- Tokens: RS256 JWT, `kid="alias/apex-ews-secret"`. In prod, `loadSigner()` is replaced by a KMS-resident asymmetric key signer (no private key on disk).
- Logs redact `req.headers.authorization`, `req.body.password`, `req.body.totp`.
- TLS termination at the ALB; mTLS to upstream services via service mesh (out of scope here).

## Seed users

| Username           | Role                | TOTP secret (base32) |
|--------------------|---------------------|----------------------|
| alice.admin        | admin               | `JBSWY3DPEHPK3PXP`   |
| ravi.risk          | risk_analyst        | `KRSXG5CTMVRXEZLU`   |
| sue.super          | supervisor          | `MFRGGZDFMZTWQ2LK`   |
| carl.collect       | collection_officer  | `NBSWY3DPO5XXE3DE`   |
| fiona.field        | field_officer       | `ONSWG4TFOQQGW33O`   |

Passwords match each role: e.g. `Admin!Pass1` for admin, `RiskAnalyst!1`, `Super!Pass1`, `Collect!Pass1`, `Field!Pass1`. Local-dev only.

## Running

```bash
npm install
npm test            # unit tests
npm run dev         # http://localhost:8080
docker build -t apex-ews/auth-svc:dev .
```
