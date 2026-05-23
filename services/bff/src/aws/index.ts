// services/bff/src/aws/index.ts
//
// AWS adapter interface registry — Phase 5 (future-readiness).
//
// PURE INTERFACES + NO-OP DEFAULTS. No live AWS calls. No `aws-sdk` import.
//
// Each adapter follows the existing env-gated factory convention used elsewhere
// in this codebase (makeCbsClient / makeIfrs9Adapter / makeFeatureStore /
// makeJwtVerifier / makeIndicatorProducer / makeAlertSource / etc.):
//
//   1. Interface declares the minimal contract a service needs
//   2. NoOp impl returns sentinel "unavailable" responses without throwing
//   3. makeXxx(env) factory probes for the live AWS adapter; returns NoOp
//      when the env var is missing
//   4. Production wires the real SDK adapter (separate package install)
//
// Today every factory below returns NoOp. When the production stack
// provisions AWS resources, swap NoOp for SDK-backed impls without
// changing any caller code.

// =============================================================================
// SECRETS MANAGER
// =============================================================================
export interface ISecretsManagerAdapter {
  getSecret(secret_id: string): Promise<{ ok: true; value: string } | { ok: false; reason: string }>;
  /** Idempotent — calls update when secret exists. */
  putSecret(secret_id: string, value: string, kms_key_id?: string): Promise<{ ok: boolean; reason?: string }>;
  rotateSecret(secret_id: string): Promise<{ ok: boolean; reason?: string }>;
}

class NoOpSecretsManager implements ISecretsManagerAdapter {
  async getSecret(secret_id: string) {
    return { ok: false as const, reason: `secrets-manager-not-wired: ${secret_id}` };
  }
  async putSecret(_secret_id: string, _value: string, _kms_key_id?: string) {
    return { ok: false, reason: "secrets-manager-not-wired" };
  }
  async rotateSecret(_secret_id: string) {
    return { ok: false, reason: "secrets-manager-not-wired" };
  }
}

export function makeSecretsManager(env: NodeJS.ProcessEnv = process.env): ISecretsManagerAdapter {
  if (env.AWS_SECRETS_MANAGER_ENABLED !== "true") return new NoOpSecretsManager();
  // PROD swap point: return new AwsSecretsManagerSdkAdapter(env.AWS_REGION!)
  return new NoOpSecretsManager();
}

// =============================================================================
// S3
// =============================================================================
export interface IS3Adapter {
  putObject(args: {
    bucket: string;
    key: string;
    body: Buffer | string;
    content_type?: string;
    metadata?: Record<string, string>;
    kms_key_id?: string;
  }): Promise<{ ok: boolean; etag?: string; reason?: string }>;

  getObject(bucket: string, key: string): Promise<{ ok: true; body: Buffer; content_type?: string } | { ok: false; reason: string }>;

  presignGet(bucket: string, key: string, expires_seconds?: number): Promise<{ ok: true; url: string } | { ok: false; reason: string }>;
  presignPut(bucket: string, key: string, expires_seconds?: number): Promise<{ ok: true; url: string } | { ok: false; reason: string }>;
}

class NoOpS3 implements IS3Adapter {
  async putObject(_args: Parameters<IS3Adapter["putObject"]>[0]) {
    return { ok: false, reason: "s3-not-wired" };
  }
  async getObject(_bucket: string, _key: string) {
    return { ok: false as const, reason: "s3-not-wired" };
  }
  async presignGet(_bucket: string, _key: string, _expires?: number) {
    return { ok: false as const, reason: "s3-not-wired" };
  }
  async presignPut(_bucket: string, _key: string, _expires?: number) {
    return { ok: false as const, reason: "s3-not-wired" };
  }
}

export function makeS3(env: NodeJS.ProcessEnv = process.env): IS3Adapter {
  if (env.AWS_S3_ENABLED !== "true") return new NoOpS3();
  // PROD swap point: return new AwsS3SdkAdapter(env.AWS_REGION!)
  return new NoOpS3();
}

// =============================================================================
// SES (transactional email)
// =============================================================================
export interface ISesAdapter {
  sendEmail(args: {
    from: string;
    to: string[];
    cc?: string[];
    subject: string;
    body_text?: string;
    body_html?: string;
    configuration_set?: string;
    tags?: Array<{ name: string; value: string }>;
  }): Promise<{ ok: true; message_id: string } | { ok: false; reason: string }>;
}

class NoOpSes implements ISesAdapter {
  async sendEmail(_args: Parameters<ISesAdapter["sendEmail"]>[0]) {
    return { ok: false as const, reason: "ses-not-wired" };
  }
}

export function makeSes(env: NodeJS.ProcessEnv = process.env): ISesAdapter {
  if (env.AWS_SES_ENABLED !== "true") return new NoOpSes();
  // PROD swap point: return new AwsSesSdkAdapter(env.AWS_REGION!)
  return new NoOpSes();
}

// =============================================================================
// MSK / Kafka producer (production wraps the existing event-bus package)
// =============================================================================
export interface IKafkaProducerAdapter {
  publish(args: {
    topic: string;
    key?: string;
    value: Buffer | string;
    headers?: Record<string, string>;
  }): Promise<{ ok: true; partition: number; offset: string } | { ok: false; reason: string }>;
  shutdown(): Promise<void>;
}

class NoOpKafkaProducer implements IKafkaProducerAdapter {
  async publish(_args: Parameters<IKafkaProducerAdapter["publish"]>[0]) {
    return { ok: false as const, reason: "kafka-not-wired" };
  }
  async shutdown() {
    /* noop */
  }
}

export function makeKafkaProducer(env: NodeJS.ProcessEnv = process.env): IKafkaProducerAdapter {
  if (!env.KAFKA_BROKERS) return new NoOpKafkaProducer();
  // PROD swap point: return new KafkaJsAdapter(env.KAFKA_BROKERS, env.KAFKA_CLIENT_ID, ...)
  // Aligns with services/regulatory-svc/indicators/src/kafka_producer.ts existing pattern.
  return new NoOpKafkaProducer();
}

// =============================================================================
// MWAA (Airflow trigger / lookup)
// =============================================================================
export interface IMwaaAdapter {
  triggerDag(args: {
    environment: string;
    dag_id: string;
    conf?: Record<string, unknown>;
    run_id?: string;
  }): Promise<{ ok: true; run_id: string } | { ok: false; reason: string }>;

  getDagRun(environment: string, dag_id: string, run_id: string): Promise<
    | { ok: true; state: "queued" | "running" | "success" | "failed" }
    | { ok: false; reason: string }
  >;
}

class NoOpMwaa implements IMwaaAdapter {
  async triggerDag(_args: Parameters<IMwaaAdapter["triggerDag"]>[0]) {
    return { ok: false as const, reason: "mwaa-not-wired" };
  }
  async getDagRun(_env: string, _dag: string, _run: string) {
    return { ok: false as const, reason: "mwaa-not-wired" };
  }
}

export function makeMwaa(env: NodeJS.ProcessEnv = process.env): IMwaaAdapter {
  if (!env.MWAA_ENVIRONMENT_NAME) return new NoOpMwaa();
  // PROD swap point: return new AwsMwaaSdkAdapter(env.AWS_REGION!, env.MWAA_ENVIRONMENT_NAME!)
  return new NoOpMwaa();
}

// =============================================================================
// EKS environment config (resolves cluster identity for in-cluster code paths)
// =============================================================================
export interface IEksEnvAdapter {
  /** Whether we appear to be running inside an EKS pod (heuristic). */
  isInCluster(): boolean;
  clusterName(): string | null;
  region(): string | null;
  /** Reads service-account namespace mounted at /var/run/secrets/kubernetes.io/serviceaccount/namespace. */
  namespace(): string | null;
  /** Reads the AWS_ROLE_ARN env var injected by IRSA + EKS Pod Identity. */
  podIamRoleArn(): string | null;
}

class StaticEksEnv implements IEksEnvAdapter {
  constructor(private env: NodeJS.ProcessEnv) {}
  isInCluster(): boolean {
    return Boolean(this.env.KUBERNETES_SERVICE_HOST);
  }
  clusterName(): string | null {
    return this.env.EKS_CLUSTER_NAME ?? null;
  }
  region(): string | null {
    return this.env.AWS_REGION ?? this.env.AWS_DEFAULT_REGION ?? null;
  }
  namespace(): string | null {
    return this.env.POD_NAMESPACE ?? null;
  }
  podIamRoleArn(): string | null {
    return this.env.AWS_ROLE_ARN ?? null;
  }
}

export function makeEksEnv(env: NodeJS.ProcessEnv = process.env): IEksEnvAdapter {
  return new StaticEksEnv(env);
}

// =============================================================================
// Aggregator — single entry point that all consumers can pull from
// =============================================================================
export interface AwsAdapters {
  secretsManager: ISecretsManagerAdapter;
  s3: IS3Adapter;
  ses: ISesAdapter;
  kafka: IKafkaProducerAdapter;
  mwaa: IMwaaAdapter;
  eksEnv: IEksEnvAdapter;
}

export function makeAwsAdapters(env: NodeJS.ProcessEnv = process.env): AwsAdapters {
  return {
    secretsManager: makeSecretsManager(env),
    s3: makeS3(env),
    ses: makeSes(env),
    kafka: makeKafkaProducer(env),
    mwaa: makeMwaa(env),
    eksEnv: makeEksEnv(env),
  };
}

// =============================================================================
// Env-var contract — single source of truth for future-deploy operator runbook
// =============================================================================
//
// AWS_REGION                       — required for any AWS calls
// AWS_DEFAULT_REGION               — fallback for AWS_REGION
// AWS_SECRETS_MANAGER_ENABLED=true — enables live Secrets Manager
// AWS_S3_ENABLED=true              — enables live S3
// AWS_S3_AUDIT_BUCKET              — bucket name for audit chain artifacts
// AWS_S3_RAW_BUCKET                — bucket name for raw ingest dumps
// AWS_S3_CURATED_BUCKET            — bucket name for curated analytics
// AWS_SES_ENABLED=true             — enables live SES
// AWS_SES_FROM_DEFAULT             — default From address
// KAFKA_BROKERS                    — comma-separated bootstrap list (used by existing event-bus too)
// KAFKA_CLIENT_ID                  — defaults to "apex-ews-<svc>"
// MWAA_ENVIRONMENT_NAME            — Airflow environment name in AWS
// EKS_CLUSTER_NAME                 — populated via Downward API
// POD_NAMESPACE                    — populated via Downward API
// AWS_ROLE_ARN                     — populated by IRSA / Pod Identity automatically
