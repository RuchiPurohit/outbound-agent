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
  `
    CREATE TABLE prospect_research (
      contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('READY', 'NO_SIGNAL')),
      strongest_research_id INTEGER REFERENCES research(id),
      pain_hypothesis TEXT,
      relevance TEXT,
      notes TEXT,
      researched_at TEXT NOT NULL,
      CHECK ((status = 'READY' AND strongest_research_id IS NOT NULL
        AND pain_hypothesis IS NOT NULL AND relevance IS NOT NULL
        AND length(trim(pain_hypothesis)) > 0 AND length(trim(relevance)) > 0)
        OR (status = 'NO_SIGNAL' AND strongest_research_id IS NULL
          AND pain_hypothesis IS NULL AND relevance IS NULL))
    ) STRICT;
    CREATE TABLE prospect_research_signals (
      contact_id INTEGER NOT NULL REFERENCES prospect_research(contact_id) ON DELETE CASCADE,
      research_id INTEGER NOT NULL REFERENCES research(id),
      PRIMARY KEY (contact_id, research_id)
    ) STRICT;

    DROP TRIGGER outreach_status_transition;
    ALTER TABLE outreach RENAME TO outreach_v4;
    CREATE TABLE outreach (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      subject TEXT NOT NULL CHECK (length(trim(subject)) > 0),
      body TEXT NOT NULL CHECK (length(trim(body)) > 0),
      status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'APPROVED', 'READY_TO_SEND', 'SENT', 'REPLIED', 'REJECTED')),
      sent_at TEXT,
      gmail_thread_id TEXT,
      research_id INTEGER REFERENCES research(id),
      reviewed_at TEXT,
      CHECK (status NOT IN ('SENT', 'REPLIED') OR sent_at IS NOT NULL)
    ) STRICT;
    INSERT INTO outreach (id, contact_id, subject, body, status, sent_at, gmail_thread_id)
      SELECT id, contact_id, subject, body, status, sent_at, gmail_thread_id FROM outreach_v4;
    DROP TABLE outreach_v4;
    CREATE INDEX outreach_contact_status_idx ON outreach(contact_id, status);
    CREATE TRIGGER outreach_status_transition
    BEFORE UPDATE OF status ON outreach
    WHEN NOT (
      OLD.status = NEW.status
      OR (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'REJECTED'))
      OR (OLD.status = 'APPROVED' AND NEW.status = 'READY_TO_SEND')
      OR (OLD.status = 'READY_TO_SEND' AND NEW.status = 'SENT')
      OR (OLD.status = 'SENT' AND NEW.status = 'REPLIED')
    )
    BEGIN SELECT RAISE(ABORT, 'invalid outreach status transition'); END;

    ALTER TABLE workflow_runs RENAME TO workflow_runs_v4;
    CREATE TABLE workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('COMPANY_DISCOVERY', 'CONTACT_DISCOVERY',
        'EMAIL_DISCOVERY', 'PROSPECT_RESEARCH', 'EMAIL_GENERATION', 'DRAFT_REWRITE')),
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
    INSERT INTO workflow_runs SELECT * FROM workflow_runs_v4;
    DROP TABLE workflow_runs_v4;
    CREATE INDEX workflow_runs_campaign_requested_idx ON workflow_runs(campaign_id, requested_at DESC);
    CREATE INDEX workflow_runs_status_idx ON workflow_runs(status);
  `,
  `
    ALTER TABLE outreach ADD COLUMN approved_recipient TEXT;
    ALTER TABLE outreach ADD COLUMN approved_subject TEXT;
    ALTER TABLE outreach ADD COLUMN approved_body TEXT;

    CREATE TABLE email_deliveries (
      id TEXT PRIMARY KEY,
      outreach_id INTEGER REFERENCES outreach(id),
      kind TEXT NOT NULL CHECK (kind IN ('OUTREACH', 'TEST')),
      from_email TEXT NOT NULL,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PREPARING'
        CHECK (status IN ('PREPARING', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN')),
      gmail_message_id TEXT,
      gmail_thread_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      CHECK ((kind = 'OUTREACH' AND outreach_id IS NOT NULL)
        OR (kind = 'TEST' AND outreach_id IS NULL)),
      CHECK (status != 'SENT' OR (gmail_message_id IS NOT NULL AND gmail_thread_id IS NOT NULL))
    ) STRICT;
    CREATE INDEX email_deliveries_created_idx ON email_deliveries(created_at DESC);
    CREATE UNIQUE INDEX email_deliveries_outreach_guard_idx ON email_deliveries(outreach_id)
      WHERE outreach_id IS NOT NULL AND status IN ('PREPARING', 'SENDING', 'SENT', 'UNCERTAIN');

    DROP TRIGGER outreach_status_transition;
    CREATE TRIGGER outreach_status_transition
    BEFORE UPDATE OF status ON outreach
    WHEN NOT (
      OLD.status = NEW.status
      OR (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'REJECTED'))
      OR (OLD.status = 'APPROVED' AND NEW.status IN ('READY_TO_SEND', 'DRAFT'))
      OR (OLD.status = 'READY_TO_SEND' AND NEW.status IN ('SENT', 'DRAFT'))
      OR (OLD.status = 'SENT' AND NEW.status = 'REPLIED')
    )
    BEGIN SELECT RAISE(ABORT, 'invalid outreach status transition'); END;
  `,
  `
    ALTER TABLE companies ADD COLUMN chat_feature_status TEXT NOT NULL DEFAULT 'UNKNOWN'
      CHECK (chat_feature_status IN ('PRESENT', 'NO_PUBLIC_EVIDENCE', 'UNKNOWN'));
    ALTER TABLE companies ADD COLUMN chat_feature_source_url TEXT;
  `,
  `
    ALTER TABLE companies ADD COLUMN employee_count_range TEXT;
    ALTER TABLE companies ADD COLUMN employee_count_source_url TEXT;
    ALTER TABLE companies ADD COLUMN engineering_headcount INTEGER
      CHECK (engineering_headcount IS NULL OR engineering_headcount >= 0);
    ALTER TABLE companies ADD COLUMN engineering_headcount_source_url TEXT;
    ALTER TABLE companies ADD COLUMN location_source_url TEXT;
    ALTER TABLE companies ADD COLUMN score_breakdown TEXT;
    ALTER TABLE companies ADD COLUMN sales_thesis TEXT;
    ALTER TABLE companies ADD COLUMN chat_implementation TEXT NOT NULL DEFAULT 'UNKNOWN'
      CHECK (chat_implementation IN ('HOMEGROWN', 'VENDOR', 'EXTERNAL', 'NONE_FOUND', 'UNKNOWN'));
    ALTER TABLE companies ADD COLUMN chat_vendor_name TEXT;
    ALTER TABLE companies ADD COLUMN chat_implementation_source_url TEXT;
  `,
  `
    ALTER TABLE contacts ADD COLUMN guessed_email TEXT;
    ALTER TABLE contacts ADD COLUMN guessed_email_pattern TEXT
      CHECK (guessed_email_pattern IS NULL OR guessed_email_pattern IN
        ('firstname', 'firstname.lastname', 'firstnamelastname',
         'firstinitiallastname', 'firstname_lastname'));
    ALTER TABLE contacts ADD COLUMN guessed_email_confidence TEXT
      CHECK (guessed_email_confidence IS NULL OR guessed_email_confidence IN
        ('PATTERN_SUPPORTED', 'COMMON_PATTERN', 'AMBIGUOUS'));
    ALTER TABLE contacts ADD COLUMN guessed_email_basis TEXT;
    ALTER TABLE contacts ADD COLUMN guessed_email_source_url TEXT;
  `,
  `
    ALTER TABLE email_deliveries ADD COLUMN provider TEXT NOT NULL DEFAULT 'gmail'
      CHECK (length(trim(provider)) > 0);
  `,
  `
    DROP INDEX email_deliveries_created_idx;
    DROP INDEX email_deliveries_outreach_guard_idx;
    ALTER TABLE email_deliveries RENAME TO email_deliveries_v10;

    CREATE TABLE email_deliveries (
      id TEXT PRIMARY KEY,
      outreach_id INTEGER REFERENCES outreach(id),
      kind TEXT NOT NULL CHECK (kind IN ('OUTREACH', 'TEST')),
      provider TEXT NOT NULL DEFAULT 'gmail' CHECK (length(trim(provider)) > 0),
      from_email TEXT NOT NULL,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PREPARING'
        CHECK (status IN ('PREPARING', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN')),
      provider_receipt TEXT,
      gmail_message_id TEXT,
      gmail_thread_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      CHECK ((kind = 'OUTREACH' AND outreach_id IS NOT NULL)
        OR (kind = 'TEST' AND outreach_id IS NULL)),
      CHECK (status != 'SENT' OR provider_receipt IS NOT NULL)
    ) STRICT;
    INSERT INTO email_deliveries
      (id, outreach_id, kind, provider, from_email, to_email, subject, body, status,
       provider_receipt, gmail_message_id, gmail_thread_id, error, created_at, finished_at)
    SELECT id, outreach_id, kind, provider, from_email, to_email, subject, body, status,
      CASE WHEN status = 'SENT' THEN gmail_message_id ELSE NULL END,
      gmail_message_id, gmail_thread_id, error, created_at, finished_at
    FROM email_deliveries_v10;
    DROP TABLE email_deliveries_v10;
    CREATE INDEX email_deliveries_created_idx ON email_deliveries(created_at DESC);
    CREATE UNIQUE INDEX email_deliveries_outreach_guard_idx ON email_deliveries(outreach_id)
      WHERE outreach_id IS NOT NULL AND status IN ('PREPARING', 'SENDING', 'SENT', 'UNCERTAIN');
  `,
];
