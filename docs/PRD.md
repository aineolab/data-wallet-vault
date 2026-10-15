# Product Requirements Document (PRD): Data Wallet Platform (v1.0)

**Document Owner:** Backlog Curator (Veteran GPM, B2B SaaS)

**Target Environment:** AI Coding Platform / Full-Stack Engineering Execution

**Architecture Paradigm:** Multi-Tenant B2B2C SaaS ("One Product, Two Motions" — SMB Self-Serve & Enterprise Control)

**Core Loop:** **Data In** (Social OAuth, GDPR Archives, AI Agent Memories, Canary Stream) $\rightarrow$ **Canonical Vault** (Encrypted Folder + Hybrid Graph/Vector Schema) $\rightarrow$ **Data Out** ("Spend" via MCP Agent Attachment, Scoped Data Buyer API, & Real-Time Egress Kill Switch).

---

## 1. Executive Summary & Strategic Problem Framing

### 1.1 The Problem

User identity, social graphs, and learned AI context are fragmented across social walled gardens (LinkedIn, Facebook) and isolated AI silos (Claude, ChatGPT).

* **For End Users & SMBs:** Starting a new AI session or onboarding into a new app requires repetitive context building ("cold-start problem").
* **For Data Buyers & Consuming Applications:** Collecting user-permissioned context requires maintaining brittle scrapers, navigating complex OAuth approvals, or parsing massive, unstructured GDPR/AI export files.
* **For Enterprise IT & Security:** Allowing users or applications to pipe personal and professional context into external AI agents or third-party platforms without field-level redaction, consent lineage, and an instant revocation "kill switch" is an unacceptable compliance and data-leakage risk.

### 1.2 The Solution: Data Wallet

A permissioned **Data Wallet** operating on a strict **"Data In / Data Out"** banking model:

1. **Data In (Deposits):** Users populate their Vault by connecting social accounts (LinkedIn/Facebook), uploading or streaming GDPR/DSAR archives, importing AI Agent memories (ChatGPT/Claude), and deploying asynchronous **Canary** collection workers. Raw payloads land in an encrypted, tenant-isolated storage "folder."
2. **Canonical Normalization:** Raw payloads are sanitized (secrets stripped) and distilled into a **Hybrid Canonical Schema** combining deterministic structured JSON (`Identity`, `WorkHistory`, `SocialGraph`) with semantic vector facts (`Episodic_Memories`, `Preferences`).
3. **Data Out (Spending):** Users or authorized workspaces "spend" their data by attaching scoped slices of their Wallet to external **AI Agents** (via Anthropic MCP or OpenAI Actions) or **External Data Buyers** (via Scoped Claims APIs & Webhooks), governed by an immutable **Egress Statement Ledger** and a 1-click **Revocation Kill Switch**.

### 1.3 Success Metrics (Baseline $\rightarrow$ V1 Target)

| Metric | Segment | Baseline | V1 Target | Business Impact |
| --- | --- | --- | --- | --- |
| **Time-to-First-Data-Out (Activation)** | SMB | Manual copy/paste (~30m) | **Less than 3 minutes** (Ingest $\rightarrow$ Attach to Agent) | Drives self-serve viral adoption. |
| **Canonical Distillation Success Rate** | Both | 0% (Unstructured dumps) | **Greater than 98%** clean parse rate | Reduces support tickets & downstream LLM token bloat by **80%**. |
| **Egress Kill-Switch Propagation** | ENT | No revocation exists | **Less than 5 seconds** global token invalidation | Unblocks Enterprise Security & GDPR Article 7/17 audits. |
| **Vault Read / MCP Query Latency (p95)** | Both | N/A | **Less than 200ms** | Ensures seamless real-time AI Agent tool calling. |

---

## 2. System Architecture & Technical Blueprint (For Coding Platform)

### 2.1 High-Level Component Stack

* **API Gateway & Auth Layer:** REST API (`/v1/...`) + MCP (Model Context Protocol) SSE/Stdio Server + OAuth2 Provider (issues scoped `dw_out_...` tokens).
* **Encrypted Raw Vault ("The Folder"):** S3/GCS-compatible object storage with per-tenant KMS envelope encryption (`s3://data-wallet-vault/{tenant_id}/{user_id}/{source}/{job_id}.json.enc`).
* **Primary Database:** PostgreSQL 16+ with `pgvector` extension (stores relational tenancy, RBAC, immutable consent/egress ledgers, structured canonical profiles, and 1536-dim semantic memory embeddings).
* **Async Pipeline & "Canary" Workers:** Redis/BullMQ or Kafka event bus orchestrating:
1. `CanaryCollectorWorker`: Executes OAuth pulls, webhook listeners, and ATC (Async Task Collector) streaming jobs.
2. `SecretScrubberWorker`: Runs regex + Shannon entropy checks to redact API keys, passwords, and SSNs before canonical storage.
3. `CanonicalNormalizerWorker`: Transforms raw LinkedIn/Facebook/GDPR/ChatGPT/Claude payloads into the v2 Hybrid Schema.
4. `WebhookDispatcherWorker`: Delivers signed outbound notifications (`vault.data.ready`, `vault.access.revoked`) to Data Buyers.



---

### 2.2 Database Schema (PostgreSQL + `pgvector` DDL Spec)

Use this exact schema structure when scaffolding the backend models and migrations:

```sql
-- Enable vector extension for AI Memory semantic search
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- 1. TENANTS & USERS (Multi-Tenant Isolation)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    tier VARCHAR(50) NOT NULL DEFAULT 'SMB' CHECK (tier IN ('SMB', 'ENTERPRISE')),
    kms_key_arn VARCHAR(512) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'END_USER' CHECK (role IN ('END_USER', 'WORKSPACE_ADMIN', 'SECURITY_AUDITOR')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, email)
);

-- 2. IMMUTABLE CONSENT LEDGER ("Data In" & "Data Out" Permissions)
CREATE TABLE consent_grants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL REFERENCES users(id),
    direction VARCHAR(20) NOT NULL CHECK (direction IN ('DATA_IN', 'DATA_OUT')),
    provider_or_consumer VARCHAR(100) NOT NULL, -- e.g., 'linkedin', 'chatgpt', 'claude_mcp', 'buyer_acme'
    allowed_scopes TEXT[] NOT NULL DEFAULT '{}', -- Deny-by-default: e.g., ['work_profile', 'coding_prefs']
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    actor_ip VARCHAR(45) NOT NULL
);

-- 3. RAW VAULT ARTIFACTS ("The Folder" Index)
CREATE TABLE raw_vault_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL REFERENCES users(id),
    consent_grant_id UUID NOT NULL REFERENCES consent_grants(id),
    source_type VARCHAR(50) NOT NULL CHECK (source_type IN ('LINKEDIN_OAUTH', 'FACEBOOK_OAUTH', 'GDPR_ARCHIVE', 'CHATGPT_EXPORT', 'CLAUDE_EXPORT', 'CANARY_STREAM')),
    storage_uri VARCHAR(1024) NOT NULL, -- s3://vault-raw/{tenant_id}/{user_id}/...
    sha256_checksum VARCHAR(64) NOT NULL,
    sync_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (sync_status IN ('PENDING', 'PROCESSING', 'AVAILABLE', 'PARTIAL_OR_FAILED', 'QUARANTINED')),
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. CANONICAL SCHEMA PART A: Structured Identity & Social Graph
CREATE TABLE canonical_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL REFERENCES users(id) UNIQUE,
    schema_version VARCHAR(20) NOT NULL DEFAULT '2026-10-01',
    identity_card JSONB NOT NULL DEFAULT '{}',      -- {full_name, headline, location, avatar_url}
    work_history JSONB NOT NULL DEFAULT '[]',       -- [{company, role, start_date, end_date, skills[]}]
    social_graph_summary JSONB NOT NULL DEFAULT '{}', -- {connections_count, top_industries[], verified_accounts[]}
    source_extensions JSONB NOT NULL DEFAULT '{}',  -- Provider-specific unmapped fields
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. CANONICAL SCHEMA PART B: Distilled AI Memories & Semantic Facts
CREATE TABLE canonical_memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL REFERENCES users(id),
    raw_file_id UUID NOT NULL REFERENCES raw_vault_files(id) ON DELETE CASCADE,
    scope_category VARCHAR(50) NOT NULL CHECK (scope_category IN ('work_profile', 'coding_preferences', 'shopping_preferences', 'personal_memory', 'health_finance_restricted')),
    fact_assertion TEXT NOT NULL,                   -- e.g., "User prefers TypeScript, Fastify, and PostgreSQL for backend projects."
    confidence_score NUMERIC(3,2) NOT NULL DEFAULT 1.00,
    source_provider VARCHAR(50) NOT NULL,           -- 'chatgpt', 'claude', 'linkedin_gdpr'
    source_provenance_ref VARCHAR(255),             -- Original conversation_id or message_id
    is_quarantined BOOLEAN NOT NULL DEFAULT FALSE,  -- True if secret/PII scanner flagged item
    embedding vector(1536),                         -- For fast MCP / RAG semantic retrieval
    extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. "DATA OUT" CONNECTIONS & EGRESS STATEMENT LEDGER
CREATE TABLE data_out_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL REFERENCES users(id),
    consent_grant_id UUID NOT NULL REFERENCES consent_grants(id),
    consumer_name VARCHAR(100) NOT NULL,            -- e.g., 'Claude Desktop MCP', 'Acme Data Buyer'
    consumer_type VARCHAR(30) NOT NULL CHECK (consumer_type IN ('AI_AGENT_MCP', 'AI_AGENT_ACTION', 'DATA_BUYER_API')),
    token_hash VARCHAR(64) NOT NULL UNIQUE,         -- SHA-256 of bearer token
    allowed_scopes TEXT[] NOT NULL,                 -- Enforced at SQL WHERE clause
    expires_at TIMESTAMPTZ NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE egress_ledger_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL REFERENCES users(id),
    token_id UUID NOT NULL REFERENCES data_out_tokens(id),
    consumer_name VARCHAR(100) NOT NULL,
    operation VARCHAR(50) NOT NULL,                 -- 'MCP_SEARCH_MEMORIES', 'GET_IDENTITY_CARD', 'BUYER_CLAIM_PULL'
    scopes_accessed TEXT[] NOT NULL,
    records_returned_count INT NOT NULL DEFAULT 0,
    idempotency_key VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, idempotency_key)
);

CREATE INDEX idx_memories_user_scope ON canonical_memories(tenant_id, user_id, scope_category) WHERE is_quarantined = FALSE;
CREATE INDEX idx_egress_user_time ON egress_ledger_transactions(tenant_id, user_id, created_at DESC);

```

---

### 2.3 API & MCP Interface Contracts

#### A) "Data In" Endpoints (Ingestion & Canary Control)

* `POST /v1/vault/connections/oauth` — Initiates OAuth2 flow for LinkedIn/Facebook; creates `DATA_IN` consent grant.
* `POST /v1/vault/ingest/archive` — Multipart upload or presigned S3 URL generator for **GDPR Exports** (`.zip`/`.json`) and **AI Agent Exports** (ChatGPT `conversations.json`, Claude memory dumps).
* `POST /v1/vault/canary/jobs` — Triggers an asynchronous **Canary ATC Streaming** job for a connected session; returns `job_id` and `sync_status: "PROCESSING"`.

#### B) "Data Out" Endpoints (External Spending, Buyers & Agent Attachment)

* `POST /v1/vault/tokens/issue` — Creates a scoped, time-bound **Data Out Token** (`dw_out_...`) with explicit scope toggles (`work_profile`, `coding_preferences`, etc.).
* `GET /v1/vault/data/profile` — Returns normalized `canonical_profiles` filtered strictly by the token's `allowed_scopes`. Supports `Idempotency-Key` header.
* `POST /v1/vault/data/memories/query` — Executes hybrid semantic + scope-filtered search against `canonical_memories`.
* `GET /v1/vault/egress-ledger` — Returns the chronological "Wallet Bank Statement" of all Data In deposits and Data Out withdrawals.
* `DELETE /v1/vault/tokens/{token_id}` — **The Kill Switch.** Invalidates the token in Redis/DB in **less than 5 seconds** and fires `vault.access.revoked` webhooks to external Data Buyers.

#### C) Native MCP (Model Context Protocol) Server Tools (For Claude / Cursor / AI Agents)

Expose an MCP SSE/Stdio endpoint (`/v1/mcp`) authenticated via a `dw_out_...` bearer token with two deterministic tools:

1. `wallet_get_identity_card()`: Returns the user's verified structured profile and work history within permitted scopes.
2. `wallet_search_memories(query: string, category?: string, limit?: number)`: Performs vector similarity search over `canonical_memories` where `scope_category = ANY(token.allowed_scopes)` and `is_quarantined = FALSE`.

---

## 3. Structured Backlog (Grouped by Strategic Theme)

### Theme 1: Admin, Security & Vault Foundation (ENT-Heavy / Platform)

* **DW-101: Tenant-Isolated KMS Vault & Encrypted Raw Storage ("The Folder")**
* **Type:** Feature | **Segment:** Both (ENT Critical) | **Persona:** Security / IT Admin
* **Outcome Hypothesis:** Unblocks 100% of Enterprise security reviews by encrypting all ingested social/GDPR/AI files with per-tenant keys and supporting instant GDPR crypto-shredding.
* **Effort:** M | **Key Risks:** KMS rate limits on bulk archive ingestion (solve with 5-minute data key caching).


* **DW-102: Immutable Consent Ledger (Data In & Data Out Lineage)**
* **Type:** Feature | **Segment:** ENT | **Persona:** Compliance Officer
* **Outcome Hypothesis:** Proves GDPR Article 7 compliance by linking every stored byte and every outbound read to a cryptographic `consent_grant_id`.
* **Effort:** S | **Key Risks:** Clock skew across distributed ingestion workers.


* **DW-601: Secret Scrubber & Context Firewall (DLP Redaction Engine)**
* **Type:** Feature | **Segment:** Both (ENT Blocker) | **Persona:** Security Admin / End User
* **Outcome Hypothesis:** Prevents accidental leakage of API keys, passwords, or SSNs buried in raw ChatGPT/Claude logs from ever entering the Canonical Memory store or being spent via "Data Out."
* **Effort:** M | **Key Risks:** False positives redacting benign technical identifiers.



### Theme 2: Onboarding & "Data In" Channels (SMB-Heavy)

* **DW-201: OAuth2 Account Connection Flow (LinkedIn & Facebook)**
* **Type:** Feature | **Segment:** Both (SMB Speed) | **Persona:** End User
* **Outcome Hypothesis:** Achieves **greater than 75%** onboarding completion for structured profile ingestion in under 60 seconds.
* **Effort:** M | **Key Risks:** Provider API scope deprecations.


* **DW-202: AI Agent Memory Ingestor (ChatGPT & Claude Exports/Sync)**
* **Type:** Feature | **Segment:** Both (SMB Viral Wedge) | **Persona:** End User
* **Outcome Hypothesis:** Increases initial Wallet activation by **40%** by turning years of ChatGPT/Claude conversation history into portable, structured memory facts.
* **Effort:** M | **Key Risks:** Multi-hundred-megabyte JSON files causing memory spikes (must use streaming JSON parsers like `stream-json`).


* **DW-303: "Canary" Worker v1 — Async ATC Streaming & GDPR Ingestor**
* **Type:** Feature | **Segment:** Both | **Persona:** Platform / End User
* **Outcome Hypothesis:** Automates background collection of deep historical data (GDPR archives & streaming web sessions) with **greater than 95%** job completion.
* **Effort:** L | **Key Risks:** Target site rate-limiting, MFA loops, and multi-day delays on official GDPR export generation.



### Theme 3: Core Platform & Canonical Schema (Both)

* **DW-305: Hybrid Canonical Schema v2 (Structured Graph + Vector Memory Facts)**
* **Type:** Feature | **Segment:** Both | **Persona:** Developer / AI Engineer
* **Outcome Hypothesis:** Cuts downstream Agent context token consumption by **80%** while improving retrieval precision via atomic fact distillation.
* **Effort:** M | **Key Risks:** LLM hallucination during chat-to-fact distillation (solve via strict temperature=0 extraction and mandatory `source_provenance_ref`).



### Theme 4: "Data Out" — External Spending, Agent Attachment & Governance (Both)

* **DW-801: Native AI Agent Connector (MCP Server & OpenAI Actions)**
* **Type:** Feature | **Segment:** Both (High SMB Virality) | **Persona:** End User / AI Developer
* **Outcome Hypothesis:** Drives weekly active "Data Out" usage by allowing 2-click attachment of the Data Wallet to Claude Desktop, Cursor, or Custom GPTs.
* **Effort:** S | **Key Risks:** Runaway agent loops calling MCP tools dozens of times per minute.


* **DW-802: Scoped "Data Out" Claims API & Webhook Dispatcher (For Data Buyers)**
* **Type:** Feature | **Segment:** Both | **Persona:** External Data Buyer / Developer
* **Outcome Hypothesis:** Enables external commercial applications to request permissioned user slices and receive async webhooks when Canary/GDPR jobs finish.
* **Effort:** M | **Key Risks:** Slow external buyer endpoints blocking webhook queues (requires per-tenant queue isolation).


* **DW-602: "Data Out" Egress Statement Ledger & Instant Detach Kill Switch**
* **Type:** Feature | **Segment:** Both (ENT Critical) | **Persona:** End User / Security Officer
* **Outcome Hypothesis:** Delivers the core "Wallet" trust guarantee: a real-time statement of who accessed what data, paired with a **less than 5-second** revocation kill switch.
* **Effort:** S | **Key Risks:** Cached token validation at the edge (must use Redis active revocation list).



---

## 4. Prioritization Table (WSJF Sequencing for Engineering Build)

We sequence implementation using **WSJF (Weighted Shortest Job First)** so the coding platform builds foundational data contracts and security primitives before complex UI or scraping workers. *(Scale: 1–10).*

| Build Order | ID | Backlog Item | SMB Impact | ENT Blocker | Risk / Ops Reduction | **Total Cost of Delay (CoD)** | **Job Size** | **WSJF Score** | Engineering Sequencing Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **1** | **DW-101 / 102** | **Encrypted Raw Vault ("Folder") + Consent Ledger** | 7 | 10 | 10 | **27** | 4 | **6.75** | **Step 1 (Database & Storage):** Must exist before a single byte of user data or credentials is ingested. |
| **2** | **DW-305 / 601** | **Hybrid Canonical Schema v2 + Secret Scrubber** | 9 | 9 | 9 | **27** | 4 | **6.75** | **Step 2 (Core Pipeline):** Defines the PostgreSQL + `pgvector` models and DLP redaction pipeline. |
| **3** | **DW-602** | **"Data Out" Egress Ledger & Instant Kill Switch** | 8 | 10 | 9 | **27** | 3 | **9.00** | **Step 3 (Egress Middleware):** Wraps all outbound routes in scope verification, audit logging, and kill-switch checks. |
| **4** | **DW-202 / 201** | **AI Memory Ingestor (ChatGPT/Claude) + LinkedIn OAuth** | 10 | 6 | 6 | **22** | 4 | **5.50** | **Step 4 ("Data In" Wedge):** Populates the Vault immediately via fast OAuth and streaming JSON archive ingestion. |
| **5** | **DW-801** | **AI Agent Attachment (MCP Server & Actions API)** | 10 | 7 | 5 | **22** | 3 | **7.33** | **Step 5 ("Data Out" Magic):** Immediate end-to-end value: attach the populated Wallet to Claude/ChatGPT. |
| **6** | **DW-802** | **Data Buyer Claims API & Outbound Webhooks** | 7 | 9 | 6 | **22** | 5 | **4.40** | **Step 6 (B2B Egress):** Opens external consumption for third-party Data Buyers with idempotency and retries. |
| **7** | **DW-303** | **Canary Agent (Async ATC Streaming & GDPR Automation)** | 7 | 7 | 5 | **19** | 8 | **2.38** | **Step 7 (Background Scale):** Plugs into the already-working Raw Folder and Normalization pipeline without blocking launch. |

### Explicit De-Scopes (Do NOT Build in v1)

1. **No Plain-Text Third-Party Password Storage:** Never store raw user passwords for LinkedIn/Facebook/OpenAI to bypass 2FA. Use OAuth2 tokens, user-uploaded GDPR/AI exports, or client-authorized session cookies passed to the Canary worker.
2. **No Financial/Fiat Payment Ledger or Crypto Tokenomics:** "Spending" in v1 is strictly **permissioned context egress ("Data Out")** tracked via the Egress Statement Ledger.
3. **No Bi-Directional Write-Back to Source Walled Gardens:** The Wallet ingests from LinkedIn/ChatGPT/Claude and serves data out to consuming Agents/Buyers; it does not mutate external LinkedIn profiles.
4. **No Raw Unfiltered Dump Egress:** External Data Buyers and AI Agents can only query normalized **Canonical Profiles** and **Distilled Memory Facts**—never raw un-scrubbed archive files.

---

## 5. Sprint-Ready User Stories & Gherkin Specifications

### Story 1: Encrypted Raw Vault Storage ("The Folder") & Consent Lineage (DW-101 / DW-102)

* **Persona:** Enterprise Security Officer / Platform Engineer
* **User Story:** As a **Platform Engineer**, I want all "Data In" payloads (OAuth responses, GDPR zips, ChatGPT/Claude exports, Canary streams) stored in a tenant-isolated, KMS-encrypted object store path linked to an active `consent_grant_id`, so that we guarantee tenant isolation, GDPR crypto-shredding, and pipeline replayability.

```gherkin
Feature: Tenant-Isolated Encrypted Raw Vault Ingestion ("Data In")

  Scenario: Valid payload ingested with active DATA_IN consent
    Given an authenticated user "user_123" in "tenant_A" with active consent grant "cg_in_001" for source "CHATGPT_EXPORT"
    When the ingestion endpoint receives a streaming payload
    Then the payload is encrypted using "tenant_A" KMS envelope key
    And written to "s3://vault-raw/tenant_A/user_123/CHATGPT_EXPORT/{job_id}.json.enc"
    And a record is created in "raw_vault_files" with status "PROCESSING" and a SHA-256 checksum
    And a "RAW_DATA_SAVED" event is emitted to the normalization queue

  Scenario: Ingestion rejected when consent is missing or revoked (Negative Case)
    Given "user_123" has a "REVOKED" or non-existent consent grant for source "LINKEDIN_OAUTH"
    When the Canary worker or API attempts to write a payload to the raw vault
    Then the service aborts the stream before writing to object storage
    And returns HTTP 403 Forbidden with error code "CONSENT_GRANT_INVALID"
    And logs a security event "UNAUTHORIZED_INGEST_BLOCKED"

```

* **Definition of Done:**
* Streaming upload handler (Node.js/Python stream or presigned URL) capable of handling 250MB+ GDPR/ChatGPT archives without exceeding 512MB container RAM.
* Crypto-shredding helper endpoint (`DELETE /v1/vault/user/{user_id}/purge`) that destroys the user's KMS key alias and cascades deletes across Postgres.



---

### Story 2: AI Memory & Social Normalization with Secret Scrubbing (DW-202 / DW-305 / DW-601)

* **Persona:** End User / AI Engineer
* **User Story:** As an **End User**, I want my imported LinkedIn data and ChatGPT/Claude conversation archives automatically scrubbed of accidental secrets and distilled into categorized Canonical Facts (`work_profile`, `coding_preferences`, `personal_memory`), so that my context is safe and structured for AI Agents and Data Buyers.

```gherkin
Feature: Canonical Normalization & Secret Scrubbing Pipeline

  Scenario: ChatGPT/Claude export distilled into Canonical Memory Facts
    Given a raw archive "raw_file_99" is saved in the Vault for "user_123"
    When the "CanonicalNormalizerWorker" processes the file
    Then it extracts atomic memory assertions with a category, confidence score, and "source_provenance_ref"
    And generates a 1536-dimension vector embedding for each fact
    And upserts structured career/identity fields into "canonical_profiles"
    And marks "raw_file_99" status as "AVAILABLE"

  Scenario: Accidental API key or password detected in chat history (Security / DLP Case)
    Given a user's raw ChatGPT conversation contains "sk-proj-12345abcde..." or a high-entropy bearer token
    When the "SecretScrubberWorker" inspects the text prior to canonical extraction
    Then it replaces the sensitive token with "[REDACTED_SECRET]"
    And sets "is_quarantined = TRUE" on any memory fact primarily derived from that secret block
    And ensures quarantined facts are excluded from all "Data Out" queries

  Scenario: Re-importing an overlapping export archive (Idempotency Case)
    Given "user_123" previously imported a ChatGPT archive containing conversation "conv_abc"
    When "user_123" uploads a newer export containing the unchanged "conv_abc" plus 5 new conversations
    Then the worker skips re-extracting "conv_abc" based on checksum/provenance match
    And only processes the 5 delta conversations

```

* **Definition of Done:**
* Adapters implemented for: (1) OpenAI `conversations.json`, (2) Claude memory/chat JSON export, (3) LinkedIn OAuth v2 profile + GDPR archive JSON.
* Secret scrubber unit-tested against AWS keys, OpenAI/Anthropic keys, GitHub PATs, JWTs, and SSN patterns.



---

### Story 3: "Data Out" — Attaching Wallet to External AI Agents via MCP & Scoped API (DW-801 / DW-802)

* **Persona:** End User / External Data Buyer / AI Agent
* **User Story:** As an **End User or Data Buyer**, I want to attach a Data Wallet to an external AI Agent (like Claude via MCP) or third-party application using a strictly scoped token, so that the consumer can retrieve authorized context in under 200ms without accessing private out-of-scope memories.

```gherkin
Feature: Scoped "Data Out" Consumption via MCP & Claims API

  Scenario: Claude MCP Agent queries permitted memory scopes
    Given a valid Data Out Token "dw_out_777" scoped ONLY to "['work_profile', 'coding_preferences']"
    When the MCP server receives tool call "wallet_search_memories(query: 'backend architecture')"
    Then the database query enforces "WHERE scope_category = ANY(ARRAY['work_profile', 'coding_preferences']) AND is_quarantined = FALSE"
    And returns the top-K matching canonical memory facts in less than 200ms
    And writes an immutable entry to "egress_ledger_transactions"

  Scenario: Prompt injection or Data Buyer attempts to read unauthorized scope (Negative Case)
    Given a Data Out Token "dw_out_777" scoped ONLY to "['shopping_preferences']"
    When the caller requests category "health_finance_restricted" or passes a prompt injection string
    Then the SQL scope filter hard-blocks access to unauthorized categories
    And returns 0 unauthorized records with a "SCOPE_RESTRICTED" metadata notice
    And logs the blocked attempt in the audit trail

  Scenario: Idempotent Data Buyer API retry (Edge Case)
    Given Data Buyer "buyer_acme" calls "GET /v1/vault/data/profile" with header "Idempotency-Key: req_001"
    When "buyer_acme" repeats the exact request within 24 hours due to network retry
    Then the API returns the identical HTTP 200 payload
    And does not create a duplicate row in "egress_ledger_transactions"

```

* **Definition of Done:**
* Working MCP Server endpoint (`/v1/mcp`) exposing `wallet_get_identity_card` and `wallet_search_memories`.
* Working REST Claims API (`/v1/vault/data/profile` and `/v1/vault/data/memories/query`) with OpenAPI 3.1 spec.
* Token-bucket rate limiter (60 req/min per token) protecting against runaway AI agent loops.



---

### Story 4: "Data Out" Egress Statement Ledger & Instant Kill Switch (DW-602)

* **Persona:** End User / Enterprise Security Admin
* **User Story:** As a **Data Wallet Owner**, I want a real-time "Wallet Statement" showing every Data In deposit and Data Out withdrawal, paired with a 1-click "Revoke / Detach" Kill Switch, so that I can cut off any AI Agent or Data Buyer in under 5 seconds.

```gherkin
Feature: Egress Statement Ledger & Instant Detach Kill Switch

  Scenario: User inspects their Data Wallet Statement
    Given "Claude Desktop" and "Acme Data Buyer" have executed Data Out queries today
    When the user calls "GET /v1/vault/egress-ledger"
    Then the response returns paginated transactions detailing Consumer Name, Operation, Scopes Accessed, Record Count, and Timestamp

  Scenario: User triggers the Kill Switch on an attached AI Agent or Data Buyer
    Given an active token "dw_out_777" held by "Claude Desktop" or "Acme Data Buyer"
    When the user calls "DELETE /v1/vault/tokens/{token_id}"
    Then "data_out_tokens.is_revoked" is set to TRUE and pushed to the Redis revocation cache within 5 seconds
    And the associated "consent_grants.status" transitions to "REVOKED"
    And any subsequent MCP tool call or API request using "dw_out_777" fails with HTTP 401/403 "WALLET_ACCESS_REVOKED"
    And an HMAC-signed webhook "vault.access.revoked" is dispatched to registered Data Buyer callback URLs

```

---

### Story 5: "Canary" Async Collector & ATC Streaming Worker (DW-303)

* **Persona:** Platform Engineer / End User
* **User Story:** As a **Platform Engineer**, I want an asynchronous Canary worker framework that ingests streaming session data and delayed GDPR exports into the Encrypted Raw Vault with automatic backoff and dead-letter queueing, so that slow or rate-limited external sources never block the core API.

```gherkin
Feature: Canary Async ATC Streaming & Collector Worker

  Scenario: Canary worker streams data and triggers outbound Data Ready webhook
    Given a scheduled Canary collection job "job_555" for "user_123"
    When the Canary worker completes streaming fragments into the Encrypted Raw Vault
    And the Normalizer Worker updates the record status to "AVAILABLE"
    Then the Webhook Dispatcher sends a signed "vault.data.ready" event to subscribed Data Buyers

  Scenario: External source rate-limits or blocks the Canary worker (Error / Retry Case)
    Given the target provider returns HTTP 429 Too Many Requests during an ATC stream
    When the Canary worker catches the rate-limit signal
    Then it checkpoints the stream offset in Redis
    And schedules an exponential backoff retry with jitter
    And if retries fail after 5 attempts, moves the job to the Dead Letter Queue without leaking session credentials in logs

```

---

## 6. B2B SaaS "Gotchas" Verification Checklist (Mandatory Engineering Guardrails)

Ensure the coding platform enforces these 9 architectural invariants across every module:

1. **RBAC & Deny-by-Default Scopes:** Every `data_out_tokens` record starts with `allowed_scopes = '{}'`. If a scope is not explicitly present in the token's array, the SQL query **must** filter it out at the database layer (`WHERE scope_category = ANY($1)`). Never use an LLM prompt to enforce security boundaries.
2. **Strict Tenant Isolation:** Every table includes `tenant_id UUID NOT NULL`, and every repository query or ORM scope must mandate `tenant_id` in the `WHERE` clause. Cross-tenant queries must return `HTTP 404 Not Found` (to prevent enumeration).
3. **Auditability ("Who Did What, When"):** Both `consent_grants` and `egress_ledger_transactions` are **append-only**. No `UPDATE` or `DELETE` statements are permitted on ledger rows (except GDPR crypto-shredding of an entire user).
4. **Noisy Neighbor & Runaway Agent Protection:** Enforce per-token rate limiting (60 requests/min for MCP Agent tools; 100 requests/min for Data Buyer APIs). When rate-limited, MCP tools must return a structured tool message: `"RATE_LIMIT_EXCEEDED: Pause tool calling and synthesize answer from existing context."`
5. **API Versioning & Backward Compatibility:** Prefix all routes with `/v1/` and stamp canonical payloads with `schema_version: "2026-10-01"`. Unmapped provider fields go into `source_extensions` JSONB so schema evolution never breaks consumers.
6. **Idempotency:** All ingestion jobs checksum raw files (`sha256_checksum`), and all Data Out claims support the `Idempotency-Key` header.
7. **Webhook Delivery Guarantees:** Outbound webhooks (`vault.data.ready`, `vault.access.revoked`) must be signed with `X-DataWallet-Signature` (HMAC-SHA256), never contain raw PII in the notification body (send a claim URL instead), and retry 5 times with exponential backoff before landing in a tenant-visible DLQ.
8. **Zero-Secret Logging:** Configure logger middleware (Pino/Winston/Structlog) to redact `Authorization` headers, `dw_out_*` tokens, OAuth secrets, and raw payload bodies from stdout/stderr.
9. **Feature Flags & Kill Switches:** Gate major subsystems behind environment/config flags:
* `FF_ENABLE_AI_MEMORY_INGEST` (Default: `true`)
* `FF_ENABLE_MCP_SERVER` (Default: `true`)
* `FF_ENABLE_CANARY_STREAM_WORKER` (Default: `false` until core vault passes integration tests)



---

## 7. Implementation Execution Order (Prompt Instructions for Coding Platform)

When feeding this PRD into your coding agent (Cursor, Claude Code, Windsurf, Replit, etc.), instruct it to execute in **4 sequential phases**:

1. **Phase 1 — Database & Security Foundation:** Scaffold the PostgreSQL + `pgvector` schema (Section 2.2), KMS encryption wrapper, and tenant/scope middleware. Run migrations and seed 1 SMB tenant and 1 Enterprise tenant.
2. **Phase 2 — "Data In" & Normalization Pipeline:** Build the streaming archive upload endpoint (`/v1/vault/ingest/archive`), the `SecretScrubberWorker`, and the `CanonicalNormalizerWorker` for ChatGPT/Claude JSON exports and LinkedIn profiles.
3. **Phase 3 — "Data Out" (MCP Server, Buyer API & Kill Switch):** Build the token issuance endpoint (`/v1/vault/tokens/issue`), the MCP Server tools (`wallet_get_identity_card`, `wallet_search_memories`), the REST Claims API, the Egress Ledger (`/v1/vault/egress-ledger`), and the instant `DELETE /v1/vault/tokens/{id}` Kill Switch.
4. **Phase 4 — "Wallet Dashboard" UI & Canary Worker Stub:** Build a clean developer/user dashboard showing:
* **Data In Tab:** Connect LinkedIn OAuth, Upload ChatGPT/Claude/GDPR Archive, Trigger Canary Sync.
* **Canonical Vault Explorer:** View structured Identity Card + searchable Semantic Memory Facts (with quarantined secret badges).
* **Data Out ("Spend") Tab:** Generate scoped MCP/Buyer connection tokens, view the live **Wallet Activity Statement**, and click the red **"Revoke / Detach Kill Switch"** button.