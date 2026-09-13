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
];
