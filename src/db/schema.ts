export const migrations: readonly string[] = [
  `
    CREATE TABLE campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      product_name TEXT NOT NULL CHECK (length(trim(product_name)) > 0),
      icp TEXT NOT NULL CHECK (length(trim(icp)) > 0),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'paused', 'completed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE companies (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      website TEXT NOT NULL CHECK (length(trim(website)) > 0),
      geography TEXT,
      employee_count_min INTEGER CHECK (employee_count_min IS NULL OR employee_count_min >= 0),
      employee_count_max INTEGER CHECK (employee_count_max IS NULL OR employee_count_max >= employee_count_min),
      fit_score INTEGER CHECK (fit_score IS NULL OR fit_score BETWEEN 0 AND 100),
      fit_rationale TEXT,
      source_urls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_urls)),
      approval_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (approval_status IN ('pending', 'approved', 'rejected')),
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (campaign_id, website)
    ) STRICT;

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
      job_title TEXT,
      role_priority INTEGER CHECK (role_priority IS NULL OR role_priority BETWEEN 1 AND 4),
      profile_url TEXT,
      email TEXT,
      email_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (email_status IN ('unknown', 'verified', 'not_found')),
      source_urls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_urls)),
      approval_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (approval_status IN ('pending', 'approved', 'rejected')),
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (email_status = 'verified' AND email IS NOT NULL AND length(trim(email)) > 0)
        OR (email_status != 'verified' AND email IS NULL)
      )
    ) STRICT;

    CREATE TABLE outreach (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('first_touch', 'follow_up')),
      sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
      subject TEXT NOT NULL CHECK (length(trim(subject)) > 0),
      body TEXT NOT NULL CHECK (length(trim(body)) > 0),
      reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN (
          'draft', 'pending_approval', 'approved', 'rejected',
          'sent', 'failed', 'replied', 'completed', 'cancelled'
        )),
      approved_at TEXT,
      sent_at TEXT,
      provider_draft_id TEXT,
      provider_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (campaign_id, contact_id, sequence_number),
      CHECK (
        (kind = 'first_touch' AND sequence_number = 0)
        OR (kind = 'follow_up' AND sequence_number > 0)
      ),
      CHECK (status NOT IN ('approved', 'sent', 'failed', 'replied', 'completed') OR approved_at IS NOT NULL),
      CHECK (status NOT IN ('sent', 'replied', 'completed') OR sent_at IS NOT NULL)
    ) STRICT;

    CREATE INDEX companies_campaign_status_idx ON companies(campaign_id, approval_status);
    CREATE INDEX contacts_company_status_idx ON contacts(company_id, approval_status);
    CREATE INDEX outreach_company_status_idx ON outreach(company_id, status);
    CREATE INDEX outreach_contact_sequence_idx ON outreach(contact_id, sequence_number);
  `,
];
