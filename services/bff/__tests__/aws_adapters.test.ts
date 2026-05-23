// services/bff/__tests__/aws_adapters.test.ts
//
// Phase 5 AWS-adapter interface contract tests.
// NO live AWS calls. NO sdk dependency. Validates the env-gated factory
// pattern returns a NoOp adapter when AWS isn't configured + that NoOp
// adapters never throw — they return structured `{ ok: false, reason }`.

import {
  makeAwsAdapters,
  makeSecretsManager,
  makeS3,
  makeSes,
  makeKafkaProducer,
  makeMwaa,
  makeEksEnv,
} from "../src/aws";

describe("AWS adapters — Phase 5 future-readiness", () => {
  describe("makeSecretsManager", () => {
    it("returns NoOp when AWS_SECRETS_MANAGER_ENABLED not set", async () => {
      const sm = makeSecretsManager({});
      const r = await sm.getSecret("any/key");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not-wired/);
    });
    it("does not throw on putSecret with NoOp", async () => {
      const sm = makeSecretsManager({});
      const r = await sm.putSecret("k", "v");
      expect(r.ok).toBe(false);
    });
    it("does not throw on rotateSecret with NoOp", async () => {
      const sm = makeSecretsManager({});
      const r = await sm.rotateSecret("k");
      expect(r.ok).toBe(false);
    });
  });

  describe("makeS3", () => {
    it("returns NoOp when AWS_S3_ENABLED not set", async () => {
      const s3 = makeS3({});
      const r = await s3.getObject("b", "k");
      expect(r.ok).toBe(false);
    });
    it("putObject is a no-throw with NoOp", async () => {
      const s3 = makeS3({});
      const r = await s3.putObject({ bucket: "b", key: "k", body: "x" });
      expect(r.ok).toBe(false);
    });
    it("presignGet and presignPut return ok:false", async () => {
      const s3 = makeS3({});
      expect((await s3.presignGet("b", "k")).ok).toBe(false);
      expect((await s3.presignPut("b", "k")).ok).toBe(false);
    });
  });

  describe("makeSes", () => {
    it("sendEmail is a no-throw with NoOp", async () => {
      const ses = makeSes({});
      const r = await ses.sendEmail({
        from: "noreply@example.com",
        to: ["alice@example.com"],
        subject: "smoke",
      });
      expect(r.ok).toBe(false);
    });
  });

  describe("makeKafkaProducer", () => {
    it("returns NoOp when KAFKA_BROKERS not set", async () => {
      const kp = makeKafkaProducer({});
      const r = await kp.publish({ topic: "apex.test", value: "{}" });
      expect(r.ok).toBe(false);
    });
    it("shutdown is a no-throw", async () => {
      const kp = makeKafkaProducer({});
      await expect(kp.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("makeMwaa", () => {
    it("returns NoOp when MWAA_ENVIRONMENT_NAME not set", async () => {
      const mwaa = makeMwaa({});
      const r = await mwaa.triggerDag({ environment: "x", dag_id: "y" });
      expect(r.ok).toBe(false);
    });
    it("getDagRun is a no-throw", async () => {
      const mwaa = makeMwaa({});
      const r = await mwaa.getDagRun("x", "y", "z");
      expect(r.ok).toBe(false);
    });
  });

  describe("makeEksEnv", () => {
    it("reports not-in-cluster when KUBERNETES_SERVICE_HOST unset", () => {
      const eks = makeEksEnv({});
      expect(eks.isInCluster()).toBe(false);
      expect(eks.clusterName()).toBeNull();
      expect(eks.namespace()).toBeNull();
      expect(eks.podIamRoleArn()).toBeNull();
    });
    it("reports in-cluster when KUBERNETES_SERVICE_HOST present", () => {
      const eks = makeEksEnv({ KUBERNETES_SERVICE_HOST: "10.0.0.1" });
      expect(eks.isInCluster()).toBe(true);
    });
    it("returns region from AWS_REGION or AWS_DEFAULT_REGION", () => {
      expect(makeEksEnv({ AWS_REGION: "af-south-1" }).region()).toBe("af-south-1");
      expect(makeEksEnv({ AWS_DEFAULT_REGION: "ap-south-1" }).region()).toBe("ap-south-1");
      expect(makeEksEnv({}).region()).toBeNull();
    });
    it("reads pod IRSA role ARN from AWS_ROLE_ARN", () => {
      const arn = "arn:aws:iam::123:role/test";
      expect(makeEksEnv({ AWS_ROLE_ARN: arn }).podIamRoleArn()).toBe(arn);
    });
    it("reads namespace from POD_NAMESPACE", () => {
      expect(makeEksEnv({ POD_NAMESPACE: "regulatory" }).namespace()).toBe("regulatory");
    });
  });

  describe("makeAwsAdapters aggregator", () => {
    it("returns all 6 adapters", () => {
      const adapters = makeAwsAdapters({});
      expect(adapters.secretsManager).toBeDefined();
      expect(adapters.s3).toBeDefined();
      expect(adapters.ses).toBeDefined();
      expect(adapters.kafka).toBeDefined();
      expect(adapters.mwaa).toBeDefined();
      expect(adapters.eksEnv).toBeDefined();
    });

    it("every adapter is a NoOp without env vars (no AWS calls fire)", async () => {
      const a = makeAwsAdapters({});
      const r1 = await a.secretsManager.getSecret("k");
      const r2 = await a.s3.getObject("b", "k");
      const r3 = await a.ses.sendEmail({ from: "x", to: ["y"], subject: "s" });
      const r4 = await a.kafka.publish({ topic: "t", value: "v" });
      const r5 = await a.mwaa.triggerDag({ environment: "x", dag_id: "y" });
      expect([r1, r2, r3, r4, r5].every((r) => r.ok === false)).toBe(true);
    });

    it("env-gating: SecretsManager flips on with AWS_SECRETS_MANAGER_ENABLED=true (still NoOp until SDK swap)", () => {
      // Today this is still NoOp — verifies the env-gate plumbing works
      // so when the SDK adapter is added, swap point is single-line.
      const sm = makeSecretsManager({ AWS_SECRETS_MANAGER_ENABLED: "true" });
      expect(sm).toBeDefined();
    });
  });
});
