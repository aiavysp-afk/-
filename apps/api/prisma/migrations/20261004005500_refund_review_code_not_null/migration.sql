-- PostgreSQL CHECK accepts NULL, so the review code must be explicitly non-null.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_review_code_not_null" CHECK (
  "status" = 'REQUESTED' OR "reviewCode" IS NOT NULL
);
