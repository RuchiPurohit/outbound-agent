export const migrations: readonly string[] = [
  `
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      segment TEXT NOT NULL CHECK (length(trim(segment)) > 0),
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED'))
    ) STRICT;

    CREATE TABLE companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      domain TEXT NOT NULL CHECK (length(trim(domain)) > 0),
      location TEXT,
      employee_count INTEGER CHECK (employee_count IS NULL OR employee_count >= 0),
      score INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 100),
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'DISCOVERED'
        CHECK (status IN ('DISCOVERED', 'APPROVED', 'REJECTED')),
      created_at TEXT NOT NULL,
      UNIQUE (campaign_id, domain)
    ) STRICT;

    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      title TEXT,
      role_category TEXT,
      role_score INTEGER CHECK (role_score IS NULL OR role_score BETWEEN 0 AND 100),
      linkedin_url TEXT,
      email TEXT,
      email_status TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (email_status IN ('UNKNOWN', 'VERIFIED', 'EMAIL_NOT_FOUND')),
      status TEXT NOT NULL DEFAULT 'DISCOVERED'
        CHECK (status IN ('DISCOVERED', 'APPROVED', 'REJECTED')),
      CHECK (
        (email_status = 'VERIFIED' AND email IS NOT NULL AND length(trim(email)) > 0)
        OR (email_status != 'VERIFIED' AND email IS NULL)
      )
    ) STRICT;

    CREATE TABLE research (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      signal TEXT NOT NULL CHECK (length(trim(signal)) > 0),
      source_url TEXT NOT NULL CHECK (length(trim(source_url)) > 0),
      notes TEXT
    ) STRICT;

    CREATE TABLE outreach (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      subject TEXT NOT NULL CHECK (length(trim(subject)) > 0),
      body TEXT NOT NULL CHECK (length(trim(body)) > 0),
      status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'APPROVED', 'READY_TO_SEND', 'SENT', 'REPLIED')),
      sent_at TEXT,
      gmail_thread_id TEXT,
      CHECK (status NOT IN ('SENT', 'REPLIED') OR sent_at IS NOT NULL)
    ) STRICT;

    CREATE INDEX companies_campaign_status_idx ON companies(campaign_id, status);
    CREATE INDEX contacts_company_status_idx ON contacts(company_id, status);
    CREATE INDEX research_company_contact_idx ON research(company_id, contact_id);
    CREATE INDEX outreach_contact_status_idx ON outreach(contact_id, status);
  `,
  `
    CREATE UNIQUE INDEX contacts_company_id_id_idx ON contacts(company_id, id);

    ALTER TABLE research RENAME TO research_v1;
    CREATE TABLE research (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      contact_id INTEGER,
      signal TEXT NOT NULL CHECK (length(trim(signal)) > 0),
      source_url TEXT NOT NULL CHECK (length(trim(source_url)) > 0),
      notes TEXT,
      FOREIGN KEY (company_id, contact_id)
        REFERENCES contacts(company_id, id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO research (id, company_id, contact_id, signal, source_url, notes)
      SELECT id, company_id, contact_id, signal, source_url, notes FROM research_v1;
    DROP TABLE research_v1;
    CREATE INDEX research_company_contact_idx ON research(company_id, contact_id);

    CREATE TRIGGER outreach_status_transition
    BEFORE UPDATE OF status ON outreach
    WHEN NOT (
      OLD.status = NEW.status
      OR (OLD.status = 'DRAFT' AND NEW.status = 'APPROVED')
      OR (OLD.status = 'APPROVED' AND NEW.status = 'READY_TO_SEND')
      OR (OLD.status = 'READY_TO_SEND' AND NEW.status = 'SENT')
      OR (OLD.status = 'SENT' AND NEW.status = 'REPLIED')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid outreach status transition');
    END;
  `,
  `
    CREATE TABLE contacts_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      title TEXT,
      role_category TEXT,
      role_score INTEGER CHECK (role_score IS NULL OR role_score BETWEEN 0 AND 100),
      linkedin_url TEXT,
      email TEXT,
      email_status TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (email_status IN ('UNKNOWN', 'PUBLICLY_LISTED', 'VERIFIED', 'EMAIL_NOT_FOUND')),
      status TEXT NOT NULL DEFAULT 'DISCOVERED'
        CHECK (status IN ('DISCOVERED', 'APPROVED', 'REJECTED')),
      UNIQUE (company_id, id),
      CHECK (
        (email_status IN ('PUBLICLY_LISTED', 'VERIFIED')
          AND email IS NOT NULL AND length(trim(email)) > 0)
        OR (email_status IN ('UNKNOWN', 'EMAIL_NOT_FOUND') AND email IS NULL)
      )
    ) STRICT;
    INSERT INTO contacts_v3 (
      id, company_id, name, title, role_category, role_score, linkedin_url,
      email, email_status, status
    ) SELECT
      id, company_id, name, title, role_category, role_score, linkedin_url,
      email, email_status, status
    FROM contacts;

    CREATE TABLE research_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      contact_id INTEGER,
      signal TEXT NOT NULL CHECK (length(trim(signal)) > 0),
      source_url TEXT NOT NULL CHECK (length(trim(source_url)) > 0),
      notes TEXT,
      FOREIGN KEY (company_id, contact_id)
        REFERENCES contacts_v3(company_id, id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO research_v3 (id, company_id, contact_id, signal, source_url, notes)
      SELECT id, company_id, contact_id, signal, source_url, notes FROM research;

    CREATE TABLE outreach_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts_v3(id) ON DELETE CASCADE,
      subject TEXT NOT NULL CHECK (length(trim(subject)) > 0),
      body TEXT NOT NULL CHECK (length(trim(body)) > 0),
      status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'APPROVED', 'READY_TO_SEND', 'SENT', 'REPLIED')),
      sent_at TEXT,
      gmail_thread_id TEXT,
      CHECK (status NOT IN ('SENT', 'REPLIED') OR sent_at IS NOT NULL)
    ) STRICT;
    INSERT INTO outreach_v3 (
      id, contact_id, subject, body, status, sent_at, gmail_thread_id
    ) SELECT id, contact_id, subject, body, status, sent_at, gmail_thread_id FROM outreach;

    DROP TABLE research;
    DROP TABLE outreach;
    DROP TABLE contacts;
    ALTER TABLE contacts_v3 RENAME TO contacts;
    ALTER TABLE research_v3 RENAME TO research;
    ALTER TABLE outreach_v3 RENAME TO outreach;

    CREATE INDEX contacts_company_status_idx ON contacts(company_id, status);
    CREATE UNIQUE INDEX contacts_company_id_id_idx ON contacts(company_id, id);
    CREATE INDEX research_company_contact_idx ON research(company_id, contact_id);
    CREATE INDEX outreach_contact_status_idx ON outreach(contact_id, status);

    CREATE TRIGGER outreach_status_transition
    BEFORE UPDATE OF status ON outreach
    WHEN NOT (
      OLD.status = NEW.status
      OR (OLD.status = 'DRAFT' AND NEW.status = 'APPROVED')
      OR (OLD.status = 'APPROVED' AND NEW.status = 'READY_TO_SEND')
      OR (OLD.status = 'READY_TO_SEND' AND NEW.status = 'SENT')
      OR (OLD.status = 'SENT' AND NEW.status = 'REPLIED')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid outreach status transition');
    END;
  `,
  `
    CREATE TABLE workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      kind TEXT NOT NULL
        CHECK (kind IN ('COMPANY_DISCOVERY', 'CONTACT_DISCOVERY', 'EMAIL_DISCOVERY')),
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
      details TEXT,
      output TEXT NOT NULL DEFAULT '',
      error TEXT,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      CHECK (status != 'RUNNING' OR started_at IS NOT NULL),
      CHECK (status NOT IN ('COMPLETED', 'FAILED') OR finished_at IS NOT NULL)
    ) STRICT;

    CREATE INDEX workflow_runs_campaign_requested_idx
      ON workflow_runs(campaign_id, requested_at DESC);
    CREATE INDEX workflow_runs_status_idx ON workflow_runs(status);
  `,
];
