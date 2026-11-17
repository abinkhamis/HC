// Database schema. Every business table carries company_id NOT NULL, and every
// cross-table reference is a composite foreign key (company_id, id) so the
// database itself refuses to link a record to a record of another company.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { EMPLOYEE_NO_SQL } from './employees.js';

// Tables whose rows belong to exactly one company.
export const TENANT_TABLES = [
  'files',
  'employees',
  'consultants',
  'consulting_contracts',
  'contract_deliverables',
  'deliverable_payments',
  'contract_events',
  'certificate_issues',
  'payment_requests',
  'payment_request_items',
  'payment_request_payments',
  'attestation_policies',
  'chamber_attestations',
  'attestation_events',
  'air_ticket_policies',
  'air_ticket_profiles',
  'air_ticket_family_entitlements',
  'air_ticket_disbursements',
  'air_ticket_balance_approvals',
  'air_ticket_events',
  'proc_lists',
  'proc_checklist_steps',
  'proc_cases',
  'proc_case_steps',
  'proc_team_members',
  'proc_events',
  'employee_imports',
  'employee_events',
  'tickets',
  'attestations',
  'bank_accounts',
  'letter_templates',
  'brand_assets',
  'issued_letters',
];

// Consulting contracts (rebuilt in a migration for databases created before v0.3).
export function contractsTableSql(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id                 INTEGER PRIMARY KEY,
  company_id         INTEGER NOT NULL REFERENCES companies (id),
  contract_no        TEXT,
  consultant_id      INTEGER NOT NULL,
  project_name       TEXT,
  scope              TEXT,
  department         TEXT,
  supervisor_name    TEXT,
  contract_date      TEXT,
  start_date         TEXT,
  end_date           TEXT,
  duration_text      TEXT,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'active', 'terminated', 'closed')),
  sent_at            TEXT,
  signed_at          TEXT,
  signed_file_id     INTEGER,
  terminated_at      TEXT,
  termination_reason TEXT,
  generated_file_id  INTEGER,
  generated_at       TEXT,
  notes              TEXT,
  created_by         INTEGER REFERENCES users (id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, contract_no),
  FOREIGN KEY (company_id, consultant_id) REFERENCES consultants (company_id, id),
  FOREIGN KEY (company_id, signed_file_id) REFERENCES files (company_id, id),
  FOREIGN KEY (company_id, generated_file_id) REFERENCES files (company_id, id)
);`;
}

// Steps of an employee-procedures case (rebuilt in a migration for databases created before step owners).
export function procCaseStepsSql(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id                 INTEGER PRIMARY KEY,
  company_id         INTEGER NOT NULL REFERENCES companies (id),
  case_id            INTEGER NOT NULL,
  checklist_step_id  INTEGER,
  name_ar            TEXT NOT NULL,
  sort               INTEGER NOT NULL DEFAULT 0,
  applies_to         TEXT NOT NULL DEFAULT 'all',
  letter_type_id     INTEGER REFERENCES letter_types (id),
  na_reason_list     TEXT,
  date_label         TEXT,
  reference_label    TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'na')),
  na_reason          TEXT,
  na_reason_id       INTEGER,
  auto_na            INTEGER NOT NULL DEFAULT 0,
  party_id           INTEGER,
  owner_member_id    INTEGER,
  assignee_name      TEXT,
  due_date           TEXT,
  completed_on       TEXT,
  reference          TEXT,
  notes              TEXT,
  issued_letter_id   INTEGER,
  updated_by         INTEGER REFERENCES users (id),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, case_id) REFERENCES proc_cases (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, checklist_step_id) REFERENCES proc_checklist_steps (company_id, id),
  FOREIGN KEY (company_id, party_id) REFERENCES proc_lists (company_id, id),
  FOREIGN KEY (company_id, owner_member_id) REFERENCES proc_team_members (company_id, id),
  FOREIGN KEY (company_id, na_reason_id) REFERENCES proc_lists (company_id, id),
  FOREIGN KEY (company_id, issued_letter_id) REFERENCES issued_letters (company_id, id)
);`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id              INTEGER PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE CHECK (code GLOB '[a-z0-9]*' AND length(code) BETWEEN 2 AND 32),
  name_ar         TEXT NOT NULL,
  name_en         TEXT NOT NULL,
  legal_name_ar   TEXT,
  legal_name_en   TEXT,
  logo_file_id    INTEGER,
  color_primary   TEXT CHECK (color_primary   IS NULL OR color_primary   GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  color_secondary TEXT CHECK (color_secondary IS NULL OR color_secondary GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  color_accent    TEXT CHECK (color_accent    IS NULL OR color_accent    GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  color_ink       TEXT CHECK (color_ink       IS NULL OR color_ink       GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  color_source    TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (id, logo_file_id) REFERENCES files (company_id, id)
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'team')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which companies a non-admin account may work in. Admins see every company.
CREATE TABLE IF NOT EXISTS user_companies (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, company_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies (id),
  kind          TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  uploaded_by   INTEGER REFERENCES users (id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS employees (
  id           INTEGER PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies (id),
  employee_no  TEXT,
  full_name_ar TEXT NOT NULL,
  full_name_en TEXT,
  national_id  TEXT,
  job_title    TEXT,
  department   TEXT,
  hire_date    TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  created_by   INTEGER REFERENCES users (id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, employee_no)
);

CREATE TABLE IF NOT EXISTS consultants (
  id               INTEGER PRIMARY KEY,
  company_id       INTEGER NOT NULL REFERENCES companies (id),
  full_name_ar     TEXT NOT NULL,
  full_name_en     TEXT,
  gender           TEXT,
  nationality_ar   TEXT,
  nationality_en   TEXT,
  id_number        TEXT,
  mobile           TEXT,
  email            TEXT,
  bank_beneficiary TEXT,
  bank_name        TEXT,
  iban             TEXT,
  swift_code       TEXT,
  notes            TEXT,
  created_by       INTEGER REFERENCES users (id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, id_number)
);

${contractsTableSql('consulting_contracts')}

CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies (id),
  ticket_no   TEXT,
  subject     TEXT NOT NULL,
  employee_id INTEGER,
  category    TEXT,
  priority    TEXT NOT NULL DEFAULT 'normal',
  status      TEXT NOT NULL DEFAULT 'open',
  details     TEXT,
  created_by  INTEGER REFERENCES users (id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id)
);

CREATE TABLE IF NOT EXISTS attestations (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies (id),
  employee_id   INTEGER,
  document_type TEXT NOT NULL,
  issuing_body  TEXT,
  requested_at  TEXT,
  status        TEXT NOT NULL DEFAULT 'requested',
  notes         TEXT,
  created_by    INTEGER REFERENCES users (id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id)
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id             INTEGER PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies (id),
  employee_id    INTEGER,
  account_holder TEXT NOT NULL,
  bank_name      TEXT NOT NULL,
  iban           TEXT NOT NULL,
  is_primary     INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, iban),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id)
);

-- Global catalogue of letter kinds (salary certificate, experience letter...).
CREATE TABLE IF NOT EXISTS letter_types (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name_ar   TEXT NOT NULL,
  name_en   TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Each company keeps its own Word template per letter type, versioned.
CREATE TABLE IF NOT EXISTS letter_templates (
  id             INTEGER PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies (id),
  letter_type_id INTEGER NOT NULL REFERENCES letter_types (id),
  file_id        INTEGER NOT NULL,
  version        INTEGER NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,
  uploaded_by    INTEGER REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, letter_type_id, id),
  UNIQUE (company_id, letter_type_id, version),
  FOREIGN KEY (company_id, file_id) REFERENCES files (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_letter_templates_active
  ON letter_templates (company_id, letter_type_id) WHERE is_active = 1;

-- Approved signatures and stamps per company.
CREATE TABLE IF NOT EXISTS brand_assets (
  id              INTEGER PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies (id),
  kind            TEXT NOT NULL CHECK (kind IN ('signature', 'stamp')),
  label           TEXT NOT NULL,
  signatory_name  TEXT,
  signatory_title TEXT,
  file_id         INTEGER NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  uploaded_by     INTEGER REFERENCES users (id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, file_id) REFERENCES files (company_id, id)
);

-- Issued letters: the composite keys make it impossible at the database level
-- to combine a template, signature or stamp of one company with an employee of another.
CREATE TABLE IF NOT EXISTS issued_letters (
  id                 INTEGER PRIMARY KEY,
  company_id         INTEGER NOT NULL REFERENCES companies (id),
  employee_id        INTEGER NOT NULL,
  letter_type_id     INTEGER NOT NULL,
  template_id        INTEGER NOT NULL,
  signature_asset_id INTEGER,
  stamp_asset_id     INTEGER,
  include_logo       INTEGER NOT NULL DEFAULT 1,
  reference_no       TEXT,
  output_file_id     INTEGER,
  issued_by          INTEGER REFERENCES users (id),
  issued_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id),
  FOREIGN KEY (company_id, letter_type_id, template_id) REFERENCES letter_templates (company_id, letter_type_id, id),
  FOREIGN KEY (company_id, signature_asset_id) REFERENCES brand_assets (company_id, id),
  FOREIGN KEY (company_id, stamp_asset_id) REFERENCES brand_assets (company_id, id),
  FOREIGN KEY (company_id, output_file_id) REFERENCES files (company_id, id)
);

-- Deliverables of a consulting contract: own amount, due date, certificate and payments.
CREATE TABLE IF NOT EXISTS contract_deliverables (
  id                    INTEGER PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies (id),
  contract_id           INTEGER NOT NULL,
  seq                   INTEGER NOT NULL,
  title                 TEXT NOT NULL,
  amount                REAL NOT NULL CHECK (amount >= 0),
  due_date              TEXT NOT NULL,
  period_from           TEXT,
  period_to             TEXT,
  completion_date       TEXT,
  certificate_ref       TEXT,
  certificate_file_id   INTEGER,
  certificate_issued_at TEXT,
  certificate_issued_by INTEGER REFERENCES users (id),
  certificate_sent_at   TEXT,
  certificate_sent_to   TEXT,
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, certificate_ref),
  FOREIGN KEY (company_id, contract_id) REFERENCES consulting_contracts (company_id, id),
  FOREIGN KEY (company_id, certificate_file_id) REFERENCES files (company_id, id)
);

-- Payments are recorded only after the finance department confirms the actual transfer.
CREATE TABLE IF NOT EXISTS deliverable_payments (
  id                 INTEGER PRIMARY KEY,
  company_id         INTEGER NOT NULL REFERENCES companies (id),
  deliverable_id     INTEGER NOT NULL,
  amount             REAL NOT NULL CHECK (amount > 0),
  paid_at            TEXT NOT NULL,
  transfer_reference TEXT,
  note               TEXT,
  finance_confirmed  INTEGER NOT NULL CHECK (finance_confirmed = 1),
  recorded_by        INTEGER REFERENCES users (id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, deliverable_id) REFERENCES contract_deliverables (company_id, id)
);

-- Deliverables with their confirmed paid total.

-- Activity log of each contract (what happened, when, by whom).
CREATE TABLE IF NOT EXISTS contract_events (
  id             INTEGER PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies (id),
  contract_id    INTEGER NOT NULL,
  deliverable_id INTEGER,
  event          TEXT NOT NULL,
  detail         TEXT,
  user_id        INTEGER REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (company_id, contract_id) REFERENCES consulting_contracts (company_id, id)
);

-- Chamber of Commerce attestation policy, versioned per company. A new version
-- never changes existing requests: each request keeps the policy it was created under.
CREATE TABLE IF NOT EXISTS attestation_policies (
  id             INTEGER PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies (id),
  version        INTEGER NOT NULL,
  free_per_year  INTEGER NOT NULL CHECK (free_per_year >= 0),
  year_basis     TEXT NOT NULL CHECK (year_basis IN ('hire_anniversary', 'calendar')),
  default_fee    REAL CHECK (default_fee IS NULL OR default_fee >= 0),
  overdue_days   INTEGER NOT NULL DEFAULT 7 CHECK (overdue_days >= 1),
  note           TEXT,
  effective_from TEXT NOT NULL,
  created_by     INTEGER REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, version)
);

CREATE TABLE IF NOT EXISTS chamber_attestations (
  id                      INTEGER PRIMARY KEY,
  company_id              INTEGER NOT NULL REFERENCES companies (id),
  request_no              TEXT NOT NULL,
  employee_id             INTEGER NOT NULL,
  employee_name           TEXT NOT NULL,
  department              TEXT,
  hire_date               TEXT NOT NULL,
  document_type           TEXT NOT NULL,
  purpose                 TEXT,
  request_date            TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'in_progress', 'attested', 'delivered', 'cancelled')),
  submitted_at            TEXT,
  attested_at             TEXT,
  delivered_at            TEXT,
  cancelled_at            TEXT,
  cancel_reason           TEXT,
  chamber_reference       TEXT,
  fee_amount              REAL NOT NULL CHECK (fee_amount >= 0),
  policy_id               INTEGER NOT NULL,
  free_limit              INTEGER NOT NULL,
  year_basis              TEXT NOT NULL,
  contract_year_start     TEXT NOT NULL,
  contract_year_end       TEXT NOT NULL,
  seq_in_year             INTEGER,
  charged_to              TEXT CHECK (charged_to IN ('company', 'employee')),
  deduction_amount        REAL NOT NULL DEFAULT 0,
  deduction_status        TEXT NOT NULL DEFAULT 'not_applicable' CHECK (deduction_status IN ('not_applicable', 'pending', 'confirmed', 'waived')),
  deduction_confirmed_at  TEXT,
  deduction_payroll_month TEXT,
  deduction_confirmed_by  INTEGER REFERENCES users (id),
  deduction_note          TEXT,
  needs_review            INTEGER NOT NULL DEFAULT 0,
  review_reason           TEXT,
  notes                   TEXT,
  created_by              INTEGER REFERENCES users (id),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, request_no),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id),
  FOREIGN KEY (company_id, policy_id) REFERENCES attestation_policies (company_id, id)
);

-- Change log; kept even after a request is deleted (no foreign key on attestation_id).
CREATE TABLE IF NOT EXISTS attestation_events (
  id             INTEGER PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies (id),
  attestation_id INTEGER,
  request_no     TEXT,
  event          TEXT NOT NULL,
  detail         TEXT,
  changes_json   TEXT,
  user_id        INTEGER REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every issued completion certificate, with the approvers' names entered at issue time.
CREATE TABLE IF NOT EXISTS certificate_issues (
  id               INTEGER PRIMARY KEY,
  company_id       INTEGER NOT NULL REFERENCES companies (id),
  deliverable_id   INTEGER NOT NULL,
  certificate_ref  TEXT NOT NULL,
  completion_date  TEXT NOT NULL,
  approvers_json   TEXT NOT NULL,
  file_id          INTEGER,
  template_version INTEGER,
  actor            TEXT NOT NULL DEFAULT 'user' CHECK (actor IN ('user', 'assistant')),
  issued_by        INTEGER REFERENCES users (id),
  issued_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, deliverable_id) REFERENCES contract_deliverables (company_id, id),
  FOREIGN KEY (company_id, file_id) REFERENCES files (company_id, id)
);

-- Consultant payment requests (amounts requested); actual payments stay in deliverable_payments.
CREATE TABLE IF NOT EXISTS payment_requests (
  id               INTEGER PRIMARY KEY,
  company_id       INTEGER NOT NULL REFERENCES companies (id),
  request_no       TEXT NOT NULL,
  contract_id      INTEGER NOT NULL,
  request_date     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'sent', 'cancelled')),
  approvers_json   TEXT,
  notes            TEXT,
  file_id          INTEGER,
  template_version INTEGER,
  issued_at        TEXT,
  issued_by        INTEGER REFERENCES users (id),
  sent_at          TEXT,
  sent_to          TEXT,
  cancelled_at     TEXT,
  cancel_reason    TEXT,
  created_by       INTEGER REFERENCES users (id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, request_no),
  FOREIGN KEY (company_id, contract_id) REFERENCES consulting_contracts (company_id, id),
  FOREIGN KEY (company_id, file_id) REFERENCES files (company_id, id)
);

CREATE TABLE IF NOT EXISTS payment_request_items (
  id             INTEGER PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies (id),
  request_id     INTEGER NOT NULL,
  deliverable_id INTEGER NOT NULL,
  amount         REAL NOT NULL CHECK (amount > 0),
  UNIQUE (company_id, id),
  UNIQUE (company_id, request_id, deliverable_id),
  FOREIGN KEY (company_id, request_id) REFERENCES payment_requests (company_id, id),
  FOREIGN KEY (company_id, deliverable_id) REFERENCES contract_deliverables (company_id, id)
);

-- Which actual (finance-confirmed) payments settle which request.
CREATE TABLE IF NOT EXISTS payment_request_payments (
  id          INTEGER PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies (id),
  request_id  INTEGER NOT NULL,
  payment_id  INTEGER NOT NULL,
  UNIQUE (company_id, id),
  UNIQUE (company_id, payment_id),
  FOREIGN KEY (company_id, request_id) REFERENCES payment_requests (company_id, id),
  FOREIGN KEY (company_id, payment_id) REFERENCES deliverable_payments (company_id, id)
);
CREATE INDEX IF NOT EXISTS ix_pr_items_deliverable ON payment_request_items (company_id, deliverable_id);
CREATE INDEX IF NOT EXISTS ix_cert_issues_deliverable ON certificate_issues (company_id, deliverable_id);

CREATE INDEX IF NOT EXISTS ix_att_employee_year ON chamber_attestations (company_id, employee_id, contract_year_start);
CREATE INDEX IF NOT EXISTS ix_att_events ON attestation_events (company_id, attestation_id);

-- Air tickets for non-Saudi employees. Entitlements are never stored: they are
-- calculated from the hire date, the versioned policy and the recorded disbursements.
CREATE TABLE IF NOT EXISTS air_ticket_policies (
  id             INTEGER PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies (id),
  version        INTEGER NOT NULL,
  cycle_months   INTEGER NOT NULL CHECK (cycle_months BETWEEN 1 AND 60),
  due_soon_days  INTEGER NOT NULL DEFAULT 60 CHECK (due_soon_days BETWEEN 1 AND 365),
  tracking_start TEXT,
  note           TEXT,
  effective_from TEXT NOT NULL,
  created_by     INTEGER REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, version)
);

CREATE TABLE IF NOT EXISTS air_ticket_profiles (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies (id),
  employee_id   INTEGER NOT NULL,
  destination   TEXT,
  travel_class  TEXT,
  notes         TEXT,
  created_by    INTEGER REFERENCES users (id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, employee_id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id)
);

-- Number of family members covered with each periodic entitlement, effective-dated.
CREATE TABLE IF NOT EXISTS air_ticket_family_entitlements (
  id             INTEGER PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies (id),
  employee_id    INTEGER NOT NULL,
  family_count   INTEGER NOT NULL CHECK (family_count BETWEEN 0 AND 20),
  effective_from TEXT NOT NULL,
  note           TEXT,
  created_by     INTEGER REFERENCES users (id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, employee_id, effective_from),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id)
);

-- What was actually disbursed. entitlements_used counts the employee's periodic
-- entitlements consumed; family_count counts family tickets separately.
CREATE TABLE IF NOT EXISTS air_ticket_disbursements (
  id                INTEGER PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies (id),
  employee_id       INTEGER NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('historical', 'current')),
  disbursed_on      TEXT NOT NULL,
  entitlements_used INTEGER NOT NULL CHECK (entitlements_used BETWEEN 0 AND 10),
  employee_included INTEGER NOT NULL CHECK (employee_included IN (0, 1)),
  family_count      INTEGER NOT NULL DEFAULT 0 CHECK (family_count BETWEEN 0 AND 20),
  ticket_amount     REAL CHECK (ticket_amount IS NULL OR ticket_amount >= 0),
  exit_reentry_fee  REAL CHECK (exit_reentry_fee IS NULL OR exit_reentry_fee >= 0),
  reference         TEXT,
  notes             TEXT,
  created_by        INTEGER REFERENCES users (id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by        INTEGER REFERENCES users (id),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id)
);

-- Admin approval of an employee's opening balance (snapshot as of a date).
CREATE TABLE IF NOT EXISTS air_ticket_balance_approvals (
  id               INTEGER PRIMARY KEY,
  company_id       INTEGER NOT NULL REFERENCES companies (id),
  employee_id      INTEGER NOT NULL,
  as_of            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  accrued          INTEGER NOT NULL,
  used             INTEGER NOT NULL,
  remaining        INTEGER NOT NULL,
  family_accrued   INTEGER NOT NULL,
  family_used      INTEGER NOT NULL,
  family_remaining INTEGER NOT NULL,
  hire_date        TEXT NOT NULL,
  note             TEXT,
  approved_by      INTEGER REFERENCES users (id),
  approved_at      TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_by       INTEGER REFERENCES users (id),
  revoked_at       TEXT,
  revoke_reason    TEXT,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_air_ticket_active_approval ON air_ticket_balance_approvals (company_id, employee_id) WHERE status = 'active';

-- Change log; kept even after a disbursement is deleted.
CREATE TABLE IF NOT EXISTS air_ticket_events (
  id              INTEGER PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies (id),
  employee_id     INTEGER,
  disbursement_id INTEGER,
  event           TEXT NOT NULL,
  detail          TEXT,
  changes_json    TEXT,
  user_id         INTEGER REFERENCES users (id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_air_disb_employee ON air_ticket_disbursements (company_id, employee_id);
CREATE INDEX IF NOT EXISTS ix_air_events ON air_ticket_events (company_id, employee_id);

-- Employee procedures tracking (onboarding / offboarding).
-- Admin-managed lookup lists per company: responsible parties, projects,
-- offboarding reasons and support "not added" reasons.
CREATE TABLE IF NOT EXISTS proc_lists (
  id          INTEGER PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies (id),
  list        TEXT NOT NULL CHECK (list IN ('party', 'project', 'offboarding_reason', 'support_reason')),
  label       TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, list, label)
);

-- Checklist template per company and case type. Steps are deactivated, never deleted.
CREATE TABLE IF NOT EXISTS proc_checklist_steps (
  id               INTEGER PRIMARY KEY,
  company_id       INTEGER NOT NULL REFERENCES companies (id),
  case_type        TEXT NOT NULL CHECK (case_type IN ('onboarding', 'offboarding')),
  code             TEXT,
  name_ar          TEXT NOT NULL,
  sort             INTEGER NOT NULL DEFAULT 0,
  applies_to       TEXT NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all', 'saudi', 'non_saudi')),
  deadline_days    INTEGER CHECK (deadline_days IS NULL OR deadline_days BETWEEN -365 AND 365),
  letter_type_id   INTEGER REFERENCES letter_types (id),
  na_reason_list   TEXT CHECK (na_reason_list IS NULL OR na_reason_list = 'support_reason'),
  date_label       TEXT,
  reference_label  TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS proc_cases (
  id                    INTEGER PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies (id),
  case_no               TEXT NOT NULL,
  case_type             TEXT NOT NULL CHECK (case_type IN ('onboarding', 'offboarding')),
  employee_id           INTEGER NOT NULL,
  employee_no           TEXT,
  employee_name         TEXT NOT NULL,
  department            TEXT,
  job_title             TEXT,
  nationality           TEXT,
  nationality_class     TEXT NOT NULL CHECK (nationality_class IN ('saudi', 'non_saudi', 'unknown')),
  key_date              TEXT NOT NULL,
  project_id            INTEGER,
  offboarding_reason_id INTEGER,
  notice_date           TEXT,
  owner_name            TEXT,
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  closed_on             TEXT,
  closed_by             INTEGER REFERENCES users (id),
  close_note            TEXT,
  cancel_reason         TEXT,
  notes                 TEXT,
  created_by            INTEGER REFERENCES users (id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, case_no),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES proc_lists (company_id, id),
  FOREIGN KEY (company_id, offboarding_reason_id) REFERENCES proc_lists (company_id, id)
);

-- Team members who can own individual steps (Admin-managed, per company).
CREATE TABLE IF NOT EXISTS proc_team_members (
  id          INTEGER PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies (id),
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, name)
);

-- Steps of one case: a copy of the checklist at creation (plus steps added to the case).
${procCaseStepsSql('proc_case_steps')}

-- Change log (kept after a case is deleted). actor = 'user' now; 'assistant' is reserved
-- for Maha later, always together with the user who confirmed the action.
CREATE TABLE IF NOT EXISTS proc_events (
  id          INTEGER PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies (id),
  case_id     INTEGER,
  case_no     TEXT,
  step_id     INTEGER,
  event       TEXT NOT NULL,
  detail      TEXT,
  changes_json TEXT,
  actor       TEXT NOT NULL DEFAULT 'user' CHECK (actor IN ('user', 'assistant')),
  user_id     INTEGER REFERENCES users (id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Imports of the company's active-employees Excel file (the file itself is not kept).
CREATE TABLE IF NOT EXISTS employee_imports (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies (id),
  filename      TEXT,
  sha256        TEXT NOT NULL,
  rows_total    INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  linked_count  INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  mapping_json  TEXT,
  user_id       INTEGER REFERENCES users (id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, id)
);

-- History of each directory record (kept forever; nothing here is ever deleted).
CREATE TABLE IF NOT EXISTS employee_events (
  id           INTEGER PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies (id),
  employee_id  INTEGER NOT NULL,
  event        TEXT NOT NULL,
  detail       TEXT,
  changes_json TEXT,
  import_id    INTEGER,
  user_id      INTEGER REFERENCES users (id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id),
  FOREIGN KEY (company_id, import_id) REFERENCES employee_imports (company_id, id)
);
CREATE INDEX IF NOT EXISTS ix_employee_events ON employee_events (company_id, employee_id);
CREATE INDEX IF NOT EXISTS ix_proc_cases_employee ON proc_cases (company_id, employee_id, case_type);
CREATE INDEX IF NOT EXISTS ix_proc_steps_case ON proc_case_steps (company_id, case_id);
CREATE INDEX IF NOT EXISTS ix_proc_events_case ON proc_events (company_id, case_id);
CREATE INDEX IF NOT EXISTS ix_consultants_company ON consultants (company_id);
CREATE INDEX IF NOT EXISTS ix_deliverables_contract ON contract_deliverables (company_id, contract_id);
CREATE INDEX IF NOT EXISTS ix_deliverables_due ON contract_deliverables (company_id, due_date);
CREATE INDEX IF NOT EXISTS ix_payments_deliverable ON deliverable_payments (company_id, deliverable_id);
CREATE INDEX IF NOT EXISTS ix_events_contract ON contract_events (company_id, contract_id);
CREATE INDEX IF NOT EXISTS ix_employees_company ON employees (company_id);
CREATE INDEX IF NOT EXISTS ix_contracts_company ON consulting_contracts (company_id);
CREATE INDEX IF NOT EXISTS ix_tickets_company ON tickets (company_id);
CREATE INDEX IF NOT EXISTS ix_attestations_company ON attestations (company_id);
CREATE INDEX IF NOT EXISTS ix_bank_accounts_company ON bank_accounts (company_id);
`;

// A record can never be moved to another company after creation.
function immutabilityTriggers() {
  return TENANT_TABLES.map(
    (t) => `
CREATE TRIGGER IF NOT EXISTS trg_${t}_company_immutable
BEFORE UPDATE OF company_id ON ${t}
WHEN NEW.company_id IS NOT OLD.company_id
BEGIN
  SELECT RAISE(ABORT, 'company_id is immutable');
END;`,
  ).join('\n');
}

// Additive migrations: columns added after the first release.
const ADDED_COLUMNS = {
  employees: {
    gender: 'TEXT', nationality_ar: 'TEXT', nationality_en: 'TEXT', job_title_en: 'TEXT', end_date: 'TEXT',
    basic_salary: 'REAL', housing_allowance: 'REAL', transport_allowance: 'REAL', other_allowance: 'REAL',
  },
  // certificate templates: draft → trial → approved (never activated automatically)
  letter_templates: { placeholders: 'TEXT', review_state: 'TEXT', mapping_json: 'TEXT', source_template_id: 'INTEGER', checks_json: 'TEXT', trial_docx_id: 'INTEGER', trial_pdf_id: 'INTEGER', trial_at: 'TEXT', approved_at: 'TEXT', approved_by: 'INTEGER' },
  letter_types: { category: "TEXT NOT NULL DEFAULT 'letter'" },
  issued_letters: { addressee_ar: 'TEXT', addressee_en: 'TEXT', values_json: 'TEXT' },
  // Payments are never deleted: a cancelled or corrected payment is voided with a reason.
  deliverable_payments: { voided_at: 'TEXT', voided_by: 'INTEGER REFERENCES users (id)', void_reason: 'TEXT', replaces_payment_id: 'INTEGER' },
  contract_events: { actor: "TEXT NOT NULL DEFAULT 'user'", payment_request_id: 'INTEGER' },
};

function migrate(db) {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) {
      if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_issued_letters_ref ON issued_letters (company_id, reference_no)');
  rebuildLegacyContracts(db);
  db.exec(`DROP VIEW IF EXISTS v_deliverables;
CREATE VIEW v_deliverables AS
SELECT d.*, COALESCE((SELECT SUM(p.amount) FROM deliverable_payments p
                      WHERE p.company_id = d.company_id AND p.deliverable_id = d.id AND p.voided_at IS NULL), 0) AS paid_total
FROM contract_deliverables d;`);
  addStepOwners(db);
  employeeIdentityRules(db);
  // Document kinds used by the consulting tool (templates are uploaded per company by the Admin).
  const docTypes = [
    ['consulting_contract', 'عقد خدمات استشارية', 'Consulting Services Contract', 'contract'],
    ['completion_certificate', 'شهادة إنجاز خدمات استشارية', 'Consulting Services Completion Certificate', 'certificate'],
    ['consultant_payment_request', 'طلب دفعة استشاري', 'Consultant Payment Request', 'payment_request'],
  ];
  for (const [code, ar, en, cat] of docTypes) {
    db.prepare('INSERT OR IGNORE INTO letter_types (code, name_ar, name_en, category) VALUES (?, ?, ?, ?)').run(code, ar, en, cat);
  }
}

// v0.1/v0.2 stored the consultant name inside each contract. SQLite cannot add a
// composite foreign key to an existing table, so the table is rebuilt once and
// each legacy name becomes a consultant record of the same company.
function rebuildLegacyContracts(db) {
  const cols = db.prepare('PRAGMA table_info(consulting_contracts)').all().map((c) => c.name);
  if (cols.includes('consultant_id')) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(db, () => {
      db.exec(contractsTableSql('consulting_contracts_v3'));
      const rows = db.prepare('SELECT * FROM consulting_contracts').all();
      const statusMap = { draft: 'draft', active: 'active', ended: 'closed' };
      for (const r of rows) {
        let c = db.prepare('SELECT id FROM consultants WHERE company_id = ? AND full_name_ar = ?').get(r.company_id, r.consultant_name);
        if (!c) {
          const id = db.prepare('INSERT INTO consultants (company_id, full_name_ar, created_by) VALUES (?, ?, ?)').run(r.company_id, r.consultant_name, r.created_by).lastInsertRowid;
          c = { id: Number(id) };
        }
        db.prepare(`INSERT INTO consulting_contracts_v3 (id, company_id, contract_no, consultant_id, scope, start_date, end_date, status, created_by, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.id, r.company_id, r.contract_no, c.id, r.scope, r.start_date, r.end_date,
          statusMap[r.status] || 'draft', r.created_by, r.created_at, r.updated_at);
        if (r.amount) {
          db.prepare(`INSERT INTO contract_deliverables (company_id, contract_id, seq, title, amount, due_date) VALUES (?, ?, 1, ?, ?, ?)`)
            .run(r.company_id, r.id, 'القيمة الإجمالية (مُرحَّلة من النسخة السابقة)', r.amount, r.end_date || r.start_date || new Date().toISOString().slice(0, 10));
        }
      }
      db.exec('DROP TABLE consulting_contracts');
      db.exec('ALTER TABLE consulting_contracts_v3 RENAME TO consulting_contracts');
      db.exec('CREATE INDEX IF NOT EXISTS ix_contracts_company ON consulting_contracts (company_id)');
      db.exec('DROP TRIGGER IF EXISTS trg_consulting_contracts_company_immutable');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Adds the per-step owner (a team member of the same company). SQLite cannot add a
// composite foreign key to an existing table, so proc_case_steps is rebuilt once,
// keeping every row as it is.
function addStepOwners(db) {
  const cols = db.prepare('PRAGMA table_info(proc_case_steps)').all().map((c) => c.name);
  if (!cols.length || cols.includes('owner_member_id')) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(db, () => {
      db.exec(procCaseStepsSql('proc_case_steps_v2'));
      db.exec(`INSERT INTO proc_case_steps_v2 (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM proc_case_steps`);
      db.exec('DROP TABLE proc_case_steps');
      db.exec('ALTER TABLE proc_case_steps_v2 RENAME TO proc_case_steps');
      db.exec('CREATE INDEX IF NOT EXISTS ix_proc_steps_case ON proc_case_steps (company_id, case_id)');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// One employee number per company at the database level, whatever the status, compared
// without spaces and case (the app stores numbers already normalised the same way).
// Empty numbers are allowed (recruitment may add a person before a number exists).
// Statuses are limited to the three stored ones. Existing rows are never modified here.
function employeeIdentityRules(db) {
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_employees_no_norm ON employees (company_id, ${EMPLOYEE_NO_SQL})
             WHERE employee_no IS NOT NULL AND trim(employee_no) <> ''`);
  } catch (e) {
    // existing data already holds two forms of one number: the app-level check still applies
    console.error('ux_employees_no_norm not created (existing duplicate employee numbers):', e.message);
  }
  for (const op of ['INSERT', 'UPDATE OF status']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_employees_status_${op === 'INSERT' ? 'ins' : 'upd'}
BEFORE ${op} ON employees WHEN NEW.status NOT IN ('onboarding', 'active', 'inactive')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: employee status'); END;`);
  }
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  db.exec(immutabilityTriggers());
  return db;
}

let savepointSeq = 0;
export function tx(db, fn) {
  // Nested calls (e.g. a dry-run import wrapping normal creates) use savepoints.
  if (db.isTransaction) {
    const sp = `sp_${++savepointSeq}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const r = fn();
      db.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
      throw e;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
