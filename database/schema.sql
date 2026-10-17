-- MySQL-oriented persistence schema aligned with the submitted BMS SAD.
CREATE TABLE users (
  id VARCHAR(40) PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  role ENUM('CUSTOMER','STAFF','ADMIN','AUDITOR') NOT NULL,
  phone VARCHAR(20) NOT NULL,
  password_salt VARCHAR(64) NOT NULL,
  password_hash VARCHAR(128) NOT NULL,
  kyc_status VARCHAR(30) NOT NULL,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE accounts (
  id VARCHAR(40) PRIMARY KEY,
  account_number VARCHAR(20) NOT NULL UNIQUE,
  user_id VARCHAR(40) NOT NULL,
  account_type VARCHAR(30) NOT NULL,
  status ENUM('ACTIVE','FROZEN','CLOSED') NOT NULL DEFAULT 'ACTIVE',
  balance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_accounts_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE beneficiaries (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  account_number VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_beneficiaries_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE transactions (
  id VARCHAR(40) PRIMARY KEY,
  account_id VARCHAR(40) NOT NULL,
  counterparty_account_id VARCHAR(40) NULL,
  type VARCHAR(30) NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  balance_after DECIMAL(15,2) NOT NULL,
  description VARCHAR(255),
  status VARCHAR(30) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_transactions_account FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE notifications (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  title VARCHAR(150) NOT NULL,
  message VARCHAR(500) NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE audit_logs (
  id VARCHAR(40) PRIMARY KEY,
  action VARCHAR(100) NOT NULL,
  user_id VARCHAR(40),
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json JSON NULL
);


CREATE TABLE loans (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  purpose VARCHAR(240) NOT NULL,
  tenure_months SMALLINT UNSIGNED NOT NULL,
  status ENUM('PENDING','APPROVED','REJECTED','PAID') NOT NULL DEFAULT 'PENDING',
  annual_rate_percent DECIMAL(5,2) NULL,
  repayment_amount DECIMAL(15,2) NULL,
  outstanding_balance DECIMAL(15,2) NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decision_at TIMESTAMP NULL,
  last_repayment_at TIMESTAMP NULL,
  CONSTRAINT fk_loans_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT chk_loan_amount_positive CHECK (amount > 0),
  CONSTRAINT chk_loan_tenure_positive CHECK (tenure_months BETWEEN 1 AND 360)
);

CREATE TABLE loan_repayments (
  id VARCHAR(40) PRIMARY KEY,
  loan_id VARCHAR(40) NOT NULL,
  account_id VARCHAR(40) NOT NULL,
  user_id VARCHAR(40) NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  outstanding_after DECIMAL(15,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_loan_repayments_loan FOREIGN KEY (loan_id) REFERENCES loans(id),
  CONSTRAINT fk_loan_repayments_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT fk_loan_repayments_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT chk_repayment_amount_positive CHECK (amount > 0)
);

-- Key uniqueness is essential when this design is used with a transactional MySQL backend.
-- Store a hash of the client key rather than the raw idempotency key.
CREATE TABLE idempotency_keys (
  user_id VARCHAR(40) NOT NULL,
  operation VARCHAR(80) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  response_status SMALLINT NOT NULL,
  response_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, operation, key_hash),
  CONSTRAINT fk_idempotency_user FOREIGN KEY (user_id) REFERENCES users(id)
);
