-- Deferred checks see the final transaction state, not intermediate counter updates.
CREATE FUNCTION check_refund_payment_consistency() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  target_payment TEXT;
  reserved BIGINT;
  refunded BIGINT;
  expected_reserved BIGINT;
  expected_refunded BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'Payment' THEN
    target_payment := NEW."id";
  ELSE
    target_payment := COALESCE(NEW."paymentId", OLD."paymentId");
  END IF;
  SELECT "refundReservedFen", "refundedFen" INTO reserved, refunded FROM "Payment" WHERE "id" = target_payment;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT
    COALESCE(SUM("amountFen") FILTER (WHERE "status" NOT IN ('SUCCEEDED', 'REJECTED')), 0),
    COALESCE(SUM("amountFen") FILTER (WHERE "status" = 'SUCCEEDED'), 0)
  INTO expected_reserved, expected_refunded FROM "Refund" WHERE "paymentId" = target_payment;
  IF reserved <> expected_reserved OR refunded <> expected_refunded THEN
    RAISE EXCEPTION 'Refund budget counters must match refund records' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "Payment_refund_consistency"
  AFTER INSERT OR UPDATE ON "Payment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_refund_payment_consistency();
CREATE CONSTRAINT TRIGGER "Refund_payment_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "Refund" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_refund_payment_consistency();

CREATE FUNCTION check_refund_posting_consistency() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  target_refund TEXT;
  refund_status "RefundStatus";
  refund_amount BIGINT;
  posting_amount BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'Refund' THEN
    target_refund := COALESCE(NEW."id", OLD."id");
  ELSE
    target_refund := COALESCE(NEW."refundId", OLD."refundId");
  END IF;
  SELECT "status", "amountFen" INTO refund_status, refund_amount FROM "Refund" WHERE "id" = target_refund;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT "amountFen" INTO posting_amount FROM "RefundLedgerPosting" WHERE "refundId" = target_refund;
  IF refund_status = 'SUCCEEDED' THEN
    IF posting_amount IS NULL OR posting_amount <> refund_amount THEN
      RAISE EXCEPTION 'Successful refund requires an equal-amount posting' USING ERRCODE = '23514';
    END IF;
  ELSIF posting_amount IS NOT NULL THEN
    RAISE EXCEPTION 'Only successful refunds may have a posting' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "Refund_posting_consistency"
  AFTER INSERT OR UPDATE OR DELETE ON "Refund" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_refund_posting_consistency();
CREATE CONSTRAINT TRIGGER "RefundLedgerPosting_consistency"
  AFTER INSERT OR DELETE ON "RefundLedgerPosting" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_refund_posting_consistency();
CREATE FUNCTION prevent_refund_posting_rewrite() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Refund postings are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "RefundLedgerPosting_no_rewrite"
  BEFORE UPDATE ON "RefundLedgerPosting" FOR EACH ROW EXECUTE FUNCTION prevent_refund_posting_rewrite();
