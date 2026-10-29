import { createHash } from "crypto";
import {
  AuditLogModel,
  AuditLogDocument,
} from "../models/governance.model";
import { GovernanceDecision, GovernanceEvent } from "./types";

const GENESIS_HASH = "0".repeat(64);
let appendQueue: Promise<void> = Promise.resolve();

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function serialize(value: unknown) {
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

async function appendAuditRecord(
  event: GovernanceEvent,
  decision: GovernanceDecision,
) {
  const ts = new Date();
  const payloadHash = sha256(serialize(event.payload));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const previous = await AuditLogModel.findOne().sort({ seq: -1 }).lean();
    const seq = (previous?.seq || 0) + 1;
    const prevHash = previous?.hash || GENESIS_HASH;
    const record = {
      seq,
      ts,
      actor: event.agentId,
      jobId: event.jobId,
      repoId: event.repoId,
      event: event.type,
      action: event.action,
      policyIds: decision.policyIds,
      decision: decision.effect,
      reason: decision.reason,
      payloadHash,
      prevHash,
    };
    try {
      await AuditLogModel.create({ ...record, hash: hashAuditRecord(record) });
      return seq;
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000 || attempt === 4) throw error;
    }
  }
  throw new Error("Could not append governance audit entry after sequence conflicts.");
}

export function appendAudit(
  event: GovernanceEvent,
  decision: GovernanceDecision,
) {
  const result = appendQueue.then(() => appendAuditRecord(event, decision));
  appendQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function expectedHash(record: Pick<AuditLogDocument,
  "seq" | "ts" | "actor" | "jobId" | "repoId" | "event" | "action" |
  "policyIds" | "decision" | "reason" | "payloadHash" | "prevHash"
>) {
  return hashAuditRecord({
      seq: record.seq,
      ts: record.ts,
      actor: record.actor,
      jobId: record.jobId,
      repoId: record.repoId,
      event: record.event,
      action: record.action,
      policyIds: record.policyIds,
      decision: record.decision,
      reason: record.reason,
      payloadHash: record.payloadHash,
      prevHash: record.prevHash,
    });
}

export function hashAuditRecord(record: Pick<AuditLogDocument,
  "seq" | "ts" | "actor" | "jobId" | "repoId" | "event" | "action" |
  "policyIds" | "decision" | "reason" | "payloadHash" | "prevHash"
>) {
  return sha256(serialize(record));
}

export function verifyAuditRecords(records: Array<Pick<AuditLogDocument,
  "seq" | "ts" | "actor" | "jobId" | "repoId" | "event" | "action" |
  "policyIds" | "decision" | "reason" | "payloadHash" | "prevHash" | "hash"
>>) {
  let previousHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const record of records) {
    if (record.seq !== expectedSeq) {
      return { valid: false, checked: expectedSeq - 1, brokenAt: record.seq };
    }
    if (record.prevHash !== previousHash || record.hash !== expectedHash(record)) {
      return { valid: false, checked: expectedSeq - 1, brokenAt: record.seq };
    }
    previousHash = record.hash;
    expectedSeq += 1;
  }
  return { valid: true, checked: records.length };
}

export async function verifyChain() {
  const records = await AuditLogModel.find().sort({ seq: 1 }).lean();
  return verifyAuditRecords(records as unknown as Parameters<typeof verifyAuditRecords>[0]);
}

export async function getAuditSequenceRange(jobId: string) {
  const records = await AuditLogModel.find({ jobId })
    .sort({ seq: 1 })
    .select("seq")
    .lean();
  return {
    start: records[0]?.seq,
    end: records[records.length - 1]?.seq,
  };
}
