import { createHash } from "node:crypto";

export type ApprovalRole = "technical" | "medical";
export type BundleStatus = "draft_unapproved" | "approval_pending" | "approved_not_published";

export interface BundleApproval {
  readonly role: ApprovalRole;
  readonly actorId: string;
  readonly approvedAt: string;
  readonly bundleDigest: string;
}

export interface RuleBundleDraft {
  readonly version: string;
  readonly contentHash: string;
  readonly status: BundleStatus;
  readonly approvals: readonly BundleApproval[];
}

type ApprovalRequest = Omit<BundleApproval, "bundleDigest">;

const trustedBundles = new WeakSet<RuleBundleDraft>();

function digestBundle(bundle: Pick<RuleBundleDraft, "version" | "contentHash">): string {
  return createHash("sha256").update(`${bundle.version}:${bundle.contentHash}`, "utf8").digest("hex");
}

function freezeBundle(bundle: RuleBundleDraft): RuleBundleDraft {
  const frozen = Object.freeze({ ...bundle, approvals: Object.freeze([...bundle.approvals]) });
  trustedBundles.add(frozen);
  return frozen;
}

export function createDraftBundle(version: string, contentHash: string): RuleBundleDraft {
  if (!version || !/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error("Rule bundle identity is invalid");
  }
  return freezeBundle({ version, contentHash, status: "draft_unapproved", approvals: [] });
}

export function approveBundle(
  bundle: RuleBundleDraft,
  approval: ApprovalRequest,
): RuleBundleDraft {
  if (!trustedBundles.has(bundle) || !Object.isFrozen(bundle) || !Object.isFrozen(bundle.approvals)) {
    throw new Error("Rule bundle is not a trusted immutable draft");
  }
  if (
    (approval.role !== "technical" && approval.role !== "medical") ||
    !approval.actorId ||
    Number.isNaN(Date.parse(approval.approvedAt))
  ) {
    throw new Error("Rule bundle approval is invalid");
  }
  if (bundle.approvals.some((item) => item.role === approval.role)) {
    throw new Error(`Rule bundle already has ${approval.role} approval`);
  }
  if (bundle.approvals.some((item) => item.actorId === approval.actorId)) {
    throw new Error("Medical and technical approvals require distinct actors");
  }
  const boundApproval = Object.freeze({ ...approval, bundleDigest: digestBundle(bundle) });
  const approvals = [...bundle.approvals, boundApproval];
  return freezeBundle({
    ...bundle,
    approvals,
    status: approvals.length === 2 ? "approved_not_published" : "approval_pending",
  });
}

export function isPublishable(bundle: RuleBundleDraft): boolean {
  const digest = digestBundle(bundle);
  return trustedBundles.has(bundle) &&
    Object.isFrozen(bundle) &&
    Object.isFrozen(bundle.approvals) &&
    bundle.status === "approved_not_published" &&
    bundle.approvals.length === 2 &&
    bundle.approvals.every((approval) => Object.isFrozen(approval) && approval.bundleDigest === digest) &&
    bundle.approvals.some((approval) => approval.role === "technical") &&
    bundle.approvals.some((approval) => approval.role === "medical") &&
    new Set(bundle.approvals.map((approval) => approval.actorId)).size === 2;
}
