-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "access_requests" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'google',
    "email" TEXT NOT NULL,
    "provider_user_id" TEXT,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "last_attempt_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "attempt_count" INTEGER NOT NULL DEFAULT 1,
    "reviewed_by" TEXT,
    "reviewed_at" INTEGER,
    "review_note" TEXT,
    "approved_user_id" INTEGER,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" INTEGER NOT NULL,
    "actor" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "data" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adapter_configs" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "framework" TEXT NOT NULL,
    "config" TEXT DEFAULT '{}',
    "enabled" INTEGER NOT NULL DEFAULT 1,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "adapter_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_api_keys" (
    "id" SERIAL NOT NULL,
    "agent_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '[]',
    "expires_at" INTEGER,
    "revoked_at" INTEGER,
    "last_used_at" INTEGER,
    "created_by" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "agent_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_trust_scores" (
    "id" SERIAL NOT NULL,
    "agent_name" TEXT NOT NULL,
    "trust_score" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "auth_failures" INTEGER NOT NULL DEFAULT 0,
    "injection_attempts" INTEGER NOT NULL DEFAULT 0,
    "rate_limit_hits" INTEGER NOT NULL DEFAULT 0,
    "secret_exposures" INTEGER NOT NULL DEFAULT 0,
    "successful_tasks" INTEGER NOT NULL DEFAULT 0,
    "failed_tasks" INTEGER NOT NULL DEFAULT 0,
    "last_anomaly_at" INTEGER,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "agent_trust_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "session_key" TEXT,
    "soul_content" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "last_seen" INTEGER,
    "last_activity" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "config" TEXT,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT DEFAULT 'manual',
    "content_hash" TEXT,
    "workspace_path" TEXT,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" INTEGER NOT NULL DEFAULT 1,
    "entity_type" TEXT NOT NULL,
    "condition_field" TEXT NOT NULL,
    "condition_operator" TEXT NOT NULL,
    "condition_value" TEXT NOT NULL,
    "action_type" TEXT NOT NULL DEFAULT 'notification',
    "action_config" TEXT NOT NULL DEFAULT '{}',
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
    "last_triggered_at" INTEGER,
    "trigger_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "scopes" TEXT,
    "expires_at" INTEGER,
    "last_used_at" INTEGER,
    "last_used_ip" TEXT,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "tenant_id" INTEGER NOT NULL DEFAULT 1,
    "is_revoked" INTEGER NOT NULL DEFAULT 0,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_id" INTEGER,
    "target_type" TEXT,
    "target_id" INTEGER,
    "detail" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claude_sessions" (
    "id" SERIAL NOT NULL,
    "session_id" TEXT NOT NULL,
    "project_slug" TEXT NOT NULL,
    "project_path" TEXT,
    "model" TEXT,
    "git_branch" TEXT,
    "user_messages" INTEGER NOT NULL DEFAULT 0,
    "assistant_messages" INTEGER NOT NULL DEFAULT 0,
    "tool_uses" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "first_message_at" TEXT,
    "last_message_at" TEXT,
    "last_user_prompt" TEXT,
    "is_active" INTEGER NOT NULL DEFAULT 0,
    "scanned_at" INTEGER NOT NULL,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "claude_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "author" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "parent_id" INTEGER,
    "mentions" TEXT,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "direct_connections" (
    "id" SERIAL NOT NULL,
    "agent_id" INTEGER NOT NULL,
    "tool_name" TEXT NOT NULL,
    "tool_version" TEXT,
    "connection_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "last_heartbeat" INTEGER,
    "metadata" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "direct_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_golden_sets" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "entries" TEXT NOT NULL DEFAULT '[]',
    "created_by" TEXT,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "eval_golden_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" SERIAL NOT NULL,
    "agent_name" TEXT NOT NULL,
    "eval_layer" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "passed" INTEGER,
    "detail" TEXT,
    "golden_dataset_id" INTEGER,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_traces" (
    "id" SERIAL NOT NULL,
    "agent_name" TEXT NOT NULL,
    "task_id" INTEGER,
    "trace" TEXT NOT NULL DEFAULT '[]',
    "convergence_score" DOUBLE PRECISION,
    "total_steps" INTEGER,
    "optimal_steps" INTEGER,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "eval_traces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_health_logs" (
    "id" SERIAL NOT NULL,
    "gateway_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "latency" INTEGER,
    "probed_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "error" TEXT,

    CONSTRAINT "gateway_health_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateways" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL DEFAULT '127.0.0.1',
    "port" INTEGER NOT NULL DEFAULT 18789,
    "token" TEXT NOT NULL DEFAULT '',
    "is_primary" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "last_seen" INTEGER,
    "latency" INTEGER,
    "sessions_count" INTEGER NOT NULL DEFAULT 0,
    "agents_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_syncs" (
    "id" SERIAL NOT NULL,
    "repo" TEXT NOT NULL,
    "last_synced_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "issue_count" INTEGER NOT NULL DEFAULT 0,
    "sync_direction" TEXT NOT NULL DEFAULT 'inbound',
    "status" TEXT NOT NULL DEFAULT 'success',
    "error" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "project_id" INTEGER,
    "changes_pushed" INTEGER NOT NULL DEFAULT 0,
    "changes_pulled" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "github_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_call_log" (
    "id" SERIAL NOT NULL,
    "agent_name" TEXT,
    "mcp_server" TEXT,
    "tool_name" TEXT,
    "success" INTEGER NOT NULL DEFAULT 1,
    "duration_ms" INTEGER,
    "error" TEXT,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "mcp_call_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "from_agent" TEXT NOT NULL,
    "to_agent" TEXT,
    "content" TEXT NOT NULL,
    "message_type" TEXT DEFAULT 'text',
    "metadata" TEXT,
    "read_at" INTEGER,
    "created_at" INTEGER DEFAULT floor(extract(epoch from now())),
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "recipient" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "source_type" TEXT,
    "source_id" INTEGER,
    "read_at" INTEGER,
    "delivered_at" INTEGER,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_runs" (
    "id" SERIAL NOT NULL,
    "pipeline_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "steps_snapshot" TEXT NOT NULL DEFAULT '[]',
    "started_at" INTEGER,
    "completed_at" INTEGER,
    "triggered_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pipeline_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_agent_assignments" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "agent_name" TEXT NOT NULL,
    "role" TEXT DEFAULT 'member',
    "assigned_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "project_agent_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "ticket_prefix" TEXT NOT NULL,
    "ticket_counter" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "github_repo" TEXT,
    "deadline" INTEGER,
    "color" TEXT,
    "metadata" TEXT,
    "github_sync_enabled" INTEGER NOT NULL DEFAULT 0,
    "github_labels_initialized" INTEGER NOT NULL DEFAULT 0,
    "github_default_branch" TEXT DEFAULT 'main',

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provision_events" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "step_key" TEXT,
    "message" TEXT NOT NULL,
    "data" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "provision_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provision_jobs" (
    "id" SERIAL NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "job_type" TEXT NOT NULL DEFAULT 'bootstrap',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "dry_run" INTEGER NOT NULL DEFAULT 1,
    "requested_by" TEXT NOT NULL DEFAULT 'system',
    "approved_by" TEXT,
    "runner_host" TEXT,
    "idempotency_key" TEXT,
    "request_json" TEXT NOT NULL DEFAULT '{}',
    "plan_json" TEXT NOT NULL DEFAULT '[]',
    "result_json" TEXT,
    "error_text" TEXT,
    "started_at" INTEGER,
    "completed_at" INTEGER,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "provision_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_reviews" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "reviewer" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "quality_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schema_migrations" (
    "id" TEXT NOT NULL,
    "applied_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "schema_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" SERIAL NOT NULL,
    "event_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "source" TEXT,
    "agent_name" TEXT,
    "detail" TEXT,
    "ip_address" TEXT,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "tenant_id" INTEGER NOT NULL DEFAULT 1,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "updated_by" TEXT,
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "description" TEXT,
    "content_hash" TEXT,
    "registry_slug" TEXT,
    "registry_version" TEXT,
    "security_status" TEXT DEFAULT 'unchecked',
    "installed_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
    "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standup_reports" (
    "date" TEXT NOT NULL,
    "report" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "standup_reports_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "task_subscriptions" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "agent_name" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "task_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'inbox',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "assigned_to" TEXT,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "due_date" INTEGER,
    "estimated_hours" INTEGER,
    "actual_hours" INTEGER,
    "tags" TEXT,
    "metadata" TEXT,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "project_id" INTEGER,
    "project_ticket_no" INTEGER,
    "outcome" TEXT,
    "error_message" TEXT,
    "resolution" TEXT,
    "feedback_rating" INTEGER,
    "feedback_notes" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "completed_at" INTEGER,
    "github_issue_number" INTEGER,
    "github_repo" TEXT,
    "github_synced_at" INTEGER,
    "github_branch" TEXT,
    "github_pr_number" INTEGER,
    "github_pr_state" TEXT,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "linux_user" TEXT NOT NULL,
    "plan_tier" TEXT NOT NULL DEFAULT 'standard',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "openclaw_home" TEXT NOT NULL,
    "workspace_root" TEXT NOT NULL,
    "gateway_port" INTEGER,
    "dashboard_port" INTEGER,
    "config" TEXT NOT NULL DEFAULT '{}',
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "owner_gateway" TEXT,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_usage" (
    "id" SERIAL NOT NULL,
    "model" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "task_id" INTEGER,
    "cost_usd" DOUBLE PRECISION,
    "agent_name" TEXT,

    CONSTRAINT "token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "expires_at" INTEGER NOT NULL,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "ip_address" TEXT,
    "user_agent" TEXT,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,
    "tenant_id" INTEGER,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'operator',
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "last_login_at" INTEGER,
    "provider" TEXT NOT NULL DEFAULT 'local',
    "provider_user_id" TEXT,
    "email" TEXT,
    "avatar_url" TEXT,
    "is_approved" INTEGER NOT NULL DEFAULT 1,
    "approved_by" TEXT,
    "approved_at" INTEGER,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" SERIAL NOT NULL,
    "webhook_id" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status_code" INTEGER,
    "response_body" TEXT,
    "error" TEXT,
    "duration_ms" INTEGER,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" INTEGER,
    "is_retry" INTEGER NOT NULL DEFAULT 0,
    "parent_delivery_id" INTEGER,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "events" TEXT NOT NULL DEFAULT '["*"]',
    "enabled" INTEGER NOT NULL DEFAULT 1,
    "last_fired_at" INTEGER,
    "last_status" INTEGER,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_pipelines" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "steps" TEXT NOT NULL DEFAULT '[]',
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" INTEGER,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflow_pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "model" TEXT NOT NULL DEFAULT 'sonnet',
    "task_prompt" TEXT NOT NULL,
    "timeout_seconds" INTEGER NOT NULL DEFAULT 300,
    "agent_role" TEXT,
    "tags" TEXT,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "last_used_at" INTEGER,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "workspace_id" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "created_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),
    "updated_at" INTEGER NOT NULL DEFAULT floor(extract(epoch from now())),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_access_requests_status" ON "access_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "idx_access_requests_email_provider" ON "access_requests"("email", "provider");

-- CreateIndex
CREATE INDEX "idx_activities_workspace_id" ON "activities"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_activities_entity" ON "activities"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "idx_activities_actor" ON "activities"("actor");

-- CreateIndex
CREATE INDEX "idx_activities_type" ON "activities"("type");

-- CreateIndex
CREATE INDEX "idx_activities_created_at" ON "activities"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idx_adapter_configs_workspace_framework" ON "adapter_configs"("workspace_id", "framework");

-- CreateIndex
CREATE INDEX "idx_agent_api_keys_revoked_at" ON "agent_api_keys"("revoked_at");

-- CreateIndex
CREATE INDEX "idx_agent_api_keys_expires_at" ON "agent_api_keys"("expires_at");

-- CreateIndex
CREATE INDEX "idx_agent_api_keys_workspace_id" ON "agent_api_keys"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_agent_api_keys_agent_id" ON "agent_api_keys"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_agent_api_keys_1" ON "agent_api_keys"("workspace_id", "key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_agent_trust_scores_1" ON "agent_trust_scores"("agent_name", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_agents_1" ON "agents"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_agents_2" ON "agents"("session_key");

-- CreateIndex
CREATE INDEX "idx_agents_source" ON "agents"("source");

-- CreateIndex
CREATE INDEX "idx_agents_workspace_id" ON "agents"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_agents_status" ON "agents"("status");

-- CreateIndex
CREATE INDEX "idx_agents_session_key" ON "agents"("session_key");

-- CreateIndex
CREATE INDEX "idx_alert_rules_workspace_id" ON "alert_rules"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_alert_rules_entity_type" ON "alert_rules"("entity_type");

-- CreateIndex
CREATE INDEX "idx_alert_rules_enabled" ON "alert_rules"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_api_keys_1" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "idx_api_keys_prefix" ON "api_keys"("key_prefix");

-- CreateIndex
CREATE INDEX "idx_api_keys_workspace_id" ON "api_keys"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_api_keys_user_id" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "idx_api_keys_key_hash" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "idx_audit_log_created_at" ON "audit_log"("created_at");

-- CreateIndex
CREATE INDEX "idx_audit_log_actor" ON "audit_log"("actor");

-- CreateIndex
CREATE INDEX "idx_audit_log_action" ON "audit_log"("action");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_claude_sessions_1" ON "claude_sessions"("session_id");

-- CreateIndex
CREATE INDEX "idx_claude_sessions_project" ON "claude_sessions"("project_slug");

-- CreateIndex
CREATE INDEX "idx_claude_sessions_active" ON "claude_sessions"("is_active") WHERE (is_active = 1);

-- CreateIndex
CREATE INDEX "idx_comments_workspace_id" ON "comments"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_comments_created_at" ON "comments"("created_at");

-- CreateIndex
CREATE INDEX "idx_comments_task_id" ON "comments"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_direct_connections_1" ON "direct_connections"("connection_id");

-- CreateIndex
CREATE INDEX "idx_direct_connections_workspace_id" ON "direct_connections"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_direct_connections_status" ON "direct_connections"("status");

-- CreateIndex
CREATE INDEX "idx_direct_connections_connection_id" ON "direct_connections"("connection_id");

-- CreateIndex
CREATE INDEX "idx_direct_connections_agent_id" ON "direct_connections"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_eval_golden_sets_1" ON "eval_golden_sets"("name", "workspace_id");

-- CreateIndex
CREATE INDEX "idx_eval_runs_created_at" ON "eval_runs"("created_at");

-- CreateIndex
CREATE INDEX "idx_eval_runs_eval_layer" ON "eval_runs"("eval_layer");

-- CreateIndex
CREATE INDEX "idx_eval_runs_agent_name" ON "eval_runs"("agent_name");

-- CreateIndex
CREATE INDEX "idx_eval_traces_task_id" ON "eval_traces"("task_id");

-- CreateIndex
CREATE INDEX "idx_eval_traces_agent_name" ON "eval_traces"("agent_name");

-- CreateIndex
CREATE INDEX "idx_gateway_health_logs_probed_at" ON "gateway_health_logs"("probed_at");

-- CreateIndex
CREATE INDEX "idx_gateway_health_logs_gateway_id" ON "gateway_health_logs"("gateway_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_gateways_1" ON "gateways"("name");

-- CreateIndex
CREATE INDEX "idx_github_syncs_project" ON "github_syncs"("project_id");

-- CreateIndex
CREATE INDEX "idx_github_syncs_workspace_id" ON "github_syncs"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_github_syncs_created_at" ON "github_syncs"("created_at");

-- CreateIndex
CREATE INDEX "idx_github_syncs_repo" ON "github_syncs"("repo");

-- CreateIndex
CREATE INDEX "idx_mcp_call_log_tool_name" ON "mcp_call_log"("tool_name");

-- CreateIndex
CREATE INDEX "idx_mcp_call_log_created_at" ON "mcp_call_log"("created_at");

-- CreateIndex
CREATE INDEX "idx_mcp_call_log_agent_name" ON "mcp_call_log"("agent_name");

-- CreateIndex
CREATE INDEX "idx_messages_workspace_id" ON "messages"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_messages_read_at" ON "messages"("read_at");

-- CreateIndex
CREATE INDEX "idx_messages_agents" ON "messages"("from_agent", "to_agent");

-- CreateIndex
CREATE INDEX "idx_messages_conversation" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_notifications_workspace_id" ON "notifications"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_notifications_recipient_read" ON "notifications"("recipient", "read_at");

-- CreateIndex
CREATE INDEX "idx_notifications_read_at" ON "notifications"("read_at");

-- CreateIndex
CREATE INDEX "idx_notifications_created_at" ON "notifications"("created_at");

-- CreateIndex
CREATE INDEX "idx_notifications_recipient" ON "notifications"("recipient");

-- CreateIndex
CREATE INDEX "idx_pipeline_runs_workspace_id" ON "pipeline_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_pipeline_runs_status" ON "pipeline_runs"("status");

-- CreateIndex
CREATE INDEX "idx_pipeline_runs_pipeline_id" ON "pipeline_runs"("pipeline_id");

-- CreateIndex
CREATE INDEX "idx_paa_agent" ON "project_agent_assignments"("agent_name");

-- CreateIndex
CREATE INDEX "idx_paa_project" ON "project_agent_assignments"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_project_agent_assignments_1" ON "project_agent_assignments"("project_id", "agent_name");

-- CreateIndex
CREATE INDEX "idx_projects_workspace_status" ON "projects"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_projects_2" ON "projects"("workspace_id", "ticket_prefix");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_projects_1" ON "projects"("workspace_id", "slug");

-- CreateIndex
CREATE INDEX "idx_provision_events_created_at" ON "provision_events"("created_at");

-- CreateIndex
CREATE INDEX "idx_provision_events_job_id" ON "provision_events"("job_id");

-- CreateIndex
CREATE INDEX "idx_provision_jobs_created_at" ON "provision_jobs"("created_at");

-- CreateIndex
CREATE INDEX "idx_provision_jobs_status" ON "provision_jobs"("status");

-- CreateIndex
CREATE INDEX "idx_provision_jobs_tenant_id" ON "provision_jobs"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_quality_reviews_workspace_id" ON "quality_reviews"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_quality_reviews_reviewer" ON "quality_reviews"("reviewer");

-- CreateIndex
CREATE INDEX "idx_quality_reviews_task_id" ON "quality_reviews"("task_id");

-- CreateIndex
CREATE INDEX "idx_security_events_workspace_id" ON "security_events"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_security_events_agent_name" ON "security_events"("agent_name");

-- CreateIndex
CREATE INDEX "idx_security_events_created_at" ON "security_events"("created_at");

-- CreateIndex
CREATE INDEX "idx_security_events_severity" ON "security_events"("severity");

-- CreateIndex
CREATE INDEX "idx_security_events_event_type" ON "security_events"("event_type");

-- CreateIndex
CREATE INDEX "idx_settings_category" ON "settings"("category");

-- CreateIndex
CREATE INDEX "idx_skills_registry_slug" ON "skills"("registry_slug");

-- CreateIndex
CREATE INDEX "idx_skills_source" ON "skills"("source");

-- CreateIndex
CREATE INDEX "idx_skills_name" ON "skills"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_skills_1" ON "skills"("source", "name");

-- CreateIndex
CREATE INDEX "idx_standup_reports_workspace_id" ON "standup_reports"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_standup_reports_created_at" ON "standup_reports"("created_at");

-- CreateIndex
CREATE INDEX "idx_task_subscriptions_agent_name" ON "task_subscriptions"("agent_name");

-- CreateIndex
CREATE INDEX "idx_task_subscriptions_task_id" ON "task_subscriptions"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_task_subscriptions_1" ON "task_subscriptions"("task_id", "agent_name");

-- CreateIndex
CREATE INDEX "idx_tasks_recurring" ON "tasks"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_tasks_workspace_outcome" ON "tasks"("workspace_id", "outcome", "completed_at");

-- CreateIndex
CREATE INDEX "idx_tasks_completed_at" ON "tasks"("completed_at");

-- CreateIndex
CREATE INDEX "idx_tasks_outcome" ON "tasks"("outcome");

-- CreateIndex
CREATE INDEX "idx_tasks_workspace_project" ON "tasks"("workspace_id", "project_id");

-- CreateIndex
CREATE INDEX "idx_tasks_workspace_id" ON "tasks"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_tasks_created_at" ON "tasks"("created_at");

-- CreateIndex
CREATE INDEX "idx_tasks_assigned_to" ON "tasks"("assigned_to");

-- CreateIndex
CREATE INDEX "idx_tasks_status" ON "tasks"("status");

-- CreateIndex
CREATE UNIQUE INDEX "idx_tasks_github_issue" ON "tasks"("workspace_id", "github_repo", "github_issue_number");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_tenants_1" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_tenants_2" ON "tenants"("linux_user");

-- CreateIndex
CREATE INDEX "idx_tenants_owner_gateway" ON "tenants"("owner_gateway");

-- CreateIndex
CREATE INDEX "idx_tenants_status" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "idx_tenants_slug" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "idx_token_usage_workspace_task_time" ON "token_usage"("workspace_id", "task_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_token_usage_task_id" ON "token_usage"("task_id");

-- CreateIndex
CREATE INDEX "idx_token_usage_workspace_id" ON "token_usage"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_token_usage_model" ON "token_usage"("model");

-- CreateIndex
CREATE INDEX "idx_token_usage_created_at" ON "token_usage"("created_at");

-- CreateIndex
CREATE INDEX "idx_token_usage_session_id" ON "token_usage"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_user_sessions_1" ON "user_sessions"("token");

-- CreateIndex
CREATE INDEX "idx_user_sessions_workspace_tenant" ON "user_sessions"("workspace_id", "tenant_id");

-- CreateIndex
CREATE INDEX "idx_user_sessions_tenant_id" ON "user_sessions"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_user_sessions_workspace_id" ON "user_sessions"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_user_sessions_expires_at" ON "user_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "idx_user_sessions_user_id" ON "user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "idx_user_sessions_token" ON "user_sessions"("token");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_users_1" ON "users"("username");

-- CreateIndex
CREATE INDEX "idx_users_workspace_id" ON "users"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_users_email" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_users_provider" ON "users"("provider");

-- CreateIndex
CREATE INDEX "idx_users_username" ON "users"("username");

-- CreateIndex
CREATE INDEX "idx_webhook_deliveries_workspace_id" ON "webhook_deliveries"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_webhook_deliveries_retry" ON "webhook_deliveries"("next_retry_at") WHERE (next_retry_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_webhook_deliveries_created_at" ON "webhook_deliveries"("created_at");

-- CreateIndex
CREATE INDEX "idx_webhook_deliveries_webhook_id" ON "webhook_deliveries"("webhook_id");

-- CreateIndex
CREATE INDEX "idx_webhooks_workspace_id" ON "webhooks"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_webhooks_enabled" ON "webhooks"("enabled");

-- CreateIndex
CREATE INDEX "idx_workflow_pipelines_workspace_id" ON "workflow_pipelines"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_workflow_pipelines_name" ON "workflow_pipelines"("name");

-- CreateIndex
CREATE INDEX "idx_workflow_templates_workspace_id" ON "workflow_templates"("workspace_id");

-- CreateIndex
CREATE INDEX "idx_workflow_templates_created_by" ON "workflow_templates"("created_by");

-- CreateIndex
CREATE INDEX "idx_workflow_templates_name" ON "workflow_templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_workspaces_1" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "idx_workspaces_tenant_id" ON "workspaces"("tenant_id");

-- CreateIndex
CREATE INDEX "idx_workspaces_slug" ON "workspaces"("slug");

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_approved_user_id_fkey" FOREIGN KEY ("approved_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "adapter_configs" ADD CONSTRAINT "adapter_configs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "direct_connections" ADD CONSTRAINT "direct_connections_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "workflow_pipelines"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "project_agent_assignments" ADD CONSTRAINT "project_agent_assignments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provision_events" ADD CONSTRAINT "provision_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "provision_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provision_jobs" ADD CONSTRAINT "provision_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quality_reviews" ADD CONSTRAINT "quality_reviews_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "task_subscriptions" ADD CONSTRAINT "task_subscriptions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
