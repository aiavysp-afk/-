ALTER TABLE "Refund" ADD CONSTRAINT "Refund_review_required" CHECK (
  "status" = 'REQUESTED' OR (
    "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL AND
    (("status" = 'REJECTED' AND "reviewCode" IN ('INSUFFICIENT_EVIDENCE', 'DUPLICATE_REQUEST', 'POLICY_REVIEW_REQUIRED')) OR
     ("status" <> 'REJECTED' AND "reviewCode" = 'CONFIRMED'))
  )
);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_submission_required" CHECK (
  "status" IN ('REQUESTED', 'APPROVED', 'REJECTED') OR "submittedAt" IS NOT NULL
);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_success_identity_required" CHECK (
  "status" <> 'SUCCEEDED' OR "providerRefundId" IS NOT NULL
);
CREATE FUNCTION protect_refund_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."paymentId", NEW."merchantRefundNo", NEW."amountFen", NEW."reason", NEW."policyVersion", NEW."requestedById", NEW."idempotencyKey", NEW."requestFingerprint")
     IS DISTINCT FROM
     (OLD."paymentId", OLD."merchantRefundNo", OLD."amountFen", OLD."reason", OLD."policyVersion", OLD."requestedById", OLD."idempotencyKey", OLD."requestFingerprint") THEN
    RAISE EXCEPTION 'Refund request identity and amount are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'SUCCEEDED' AND NEW."status" <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'Successful refund cannot be reversed by status rewrite' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Refund_identity_guard" BEFORE UPDATE ON "Refund"
  FOR EACH ROW EXECUTE FUNCTION protect_refund_identity();
