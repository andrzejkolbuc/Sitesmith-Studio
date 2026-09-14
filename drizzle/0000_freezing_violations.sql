CREATE TABLE "sitesmith-studio_account" (
	"userId" varchar(255) NOT NULL,
	"type" varchar(255) NOT NULL,
	"provider" varchar(255) NOT NULL,
	"providerAccountId" varchar(255) NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" varchar(255),
	"scope" varchar(255),
	"id_token" text,
	"session_state" varchar(255),
	CONSTRAINT "sitesmith-studio_account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_finding" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"tenantId" varchar(255) NOT NULL,
	"runId" varchar(255) NOT NULL,
	"type" varchar(64) NOT NULL,
	"pageId" varchar(255),
	"detail" jsonb NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_invite" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"tenantId" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" varchar(16) NOT NULL,
	"projectId" varchar(255),
	"tokenHash" varchar(64) NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"invitedByUserId" varchar(255) NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_page_observation" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"tenantId" varchar(255) NOT NULL,
	"runId" varchar(255) NOT NULL,
	"pageId" varchar(255) NOT NULL,
	"ttfbMs" integer,
	"lcpMs" integer,
	"cls" varchar(32),
	"firstPartyErrors" integer DEFAULT 0 NOT NULL,
	"thirdPartyErrors" integer DEFAULT 0 NOT NULL,
	"samples" jsonb,
	"renderError" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_page_snapshot" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"tenantId" varchar(255) NOT NULL,
	"runId" varchar(255) NOT NULL,
	"pageId" varchar(255) NOT NULL,
	"image" "bytea",
	"byteSize" integer,
	"imageWidth" integer,
	"imageHeight" integer,
	"viewportWidth" integer NOT NULL,
	"viewportHeight" integer NOT NULL,
	"maskSelectors" text[] NOT NULL,
	"captureError" text,
	"comparison" jsonb,
	"expiredAt" timestamp with time zone,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_page" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"tenantId" varchar(255) NOT NULL,
	"runId" varchar(255) NOT NULL,
	"url" varchar(2048) NOT NULL,
	"httpStatus" integer,
	"locale" varchar(32),
	"variantGroupKey" varchar(255),
	"hreflangTargets" jsonb,
	"images" jsonb,
	"fetchError" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_project_assignment" (
	"tenantId" varchar(255) NOT NULL,
	"userId" varchar(255) NOT NULL,
	"projectId" varchar(255) NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "sitesmith-studio_project_assignment_userId_projectId_pk" PRIMARY KEY("userId","projectId")
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_project" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"tenantId" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"startUrl" varchar(2048) NOT NULL,
	"includePaths" text[] NOT NULL,
	"excludePaths" text[] NOT NULL,
	"locales" text[] NOT NULL,
	"maxConcurrency" integer DEFAULT 2 NOT NULL,
	"requestDelayMs" integer DEFAULT 500 NOT NULL,
	"maskSelectors" text[] DEFAULT '{}' NOT NULL,
	"baselineRunId" varchar(255),
	"baselinePinnedAt" timestamp with time zone,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_run" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"tenantId" varchar(255) NOT NULL,
	"projectId" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"startedAt" timestamp with time zone,
	"finishedAt" timestamp with time zone,
	"pagesCrawled" integer DEFAULT 0 NOT NULL,
	"findingsCount" integer DEFAULT 0 NOT NULL,
	"error" text,
	"crawlComplete" boolean,
	"reachedPageLimit" boolean,
	"scope" jsonb,
	"ruleSet" jsonb,
	"renderSummary" jsonb,
	"visualSummary" jsonb,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_session" (
	"sessionToken" varchar(255) PRIMARY KEY NOT NULL,
	"userId" varchar(255) NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_tenant" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_user" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255),
	"email" varchar(255) NOT NULL,
	"emailVerified" timestamp with time zone,
	"image" varchar(255),
	"passwordHash" varchar(255),
	"tenantId" varchar(255),
	"role" varchar(16) DEFAULT 'owner' NOT NULL,
	CONSTRAINT "sitesmith-studio_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "sitesmith-studio_verification_token" (
	"identifier" varchar(255) NOT NULL,
	"token" varchar(255) NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "sitesmith-studio_verification_token_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "sitesmith-studio_account" ADD CONSTRAINT "sitesmith-studio_account_userId_sitesmith-studio_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."sitesmith-studio_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_finding" ADD CONSTRAINT "sitesmith-studio_finding_tenantId_sitesmith-studio_tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."sitesmith-studio_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_finding" ADD CONSTRAINT "sitesmith-studio_finding_runId_sitesmith-studio_run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."sitesmith-studio_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_finding" ADD CONSTRAINT "sitesmith-studio_finding_pageId_sitesmith-studio_page_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."sitesmith-studio_page"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_invite" ADD CONSTRAINT "sitesmith-studio_invite_tenantId_sitesmith-studio_tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."sitesmith-studio_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_invite" ADD CONSTRAINT "sitesmith-studio_invite_projectId_sitesmith-studio_project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."sitesmith-studio_project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_invite" ADD CONSTRAINT "sitesmith-studio_invite_invitedByUserId_sitesmith-studio_user_id_fk" FOREIGN KEY ("invitedByUserId") REFERENCES "public"."sitesmith-studio_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_page_observation" ADD CONSTRAINT "sitesmith-studio_page_observation_tenantId_sitesmith-studio_tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."sitesmith-studio_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_page_observation" ADD CONSTRAINT "sitesmith-studio_page_observation_runId_sitesmith-studio_run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."sitesmith-studio_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_page_observation" ADD CONSTRAINT "sitesmith-studio_page_observation_pageId_sitesmith-studio_page_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."sitesmith-studio_page"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_page_snapshot" ADD CONSTRAINT "sitesmith-studio_page_snapshot_tenantId_sitesmith-studio_tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."sitesmith-studio_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_page_snapshot" ADD CONSTRAINT "sitesmith-studio_page_snapshot_runId_sitesmith-studio_run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."sitesmith-studio_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_page_snapshot" ADD CONSTRAINT "sitesmith-studio_page_snapshot_pageId_sitesmith-studio_page_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."sitesmith-studio_page"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_page" ADD CONSTRAINT "sitesmith-studio_page_tenantId_sitesmith-studio_tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."sitesmith-studio_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_page" ADD CONSTRAINT "sitesmith-studio_page_runId_sitesmith-studio_run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."sitesmith-studio_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_project_assignment" ADD CONSTRAINT "sitesmith-studio_project_assignment_tenantId_sitesmith-studio_tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."sitesmith-studio_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_project_assignment" ADD CONSTRAINT "sitesmith-studio_project_assignment_userId_sitesmith-studio_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."sitesmith-studio_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_project_assignment" ADD CONSTRAINT "sitesmith-studio_project_assignment_projectId_sitesmith-studio_project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."sitesmith-studio_project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_project" ADD CONSTRAINT "sitesmith-studio_project_tenantId_sitesmith-studio_tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."sitesmith-studio_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_run" ADD CONSTRAINT "sitesmith-studio_run_tenantId_sitesmith-studio_tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."sitesmith-studio_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_run" ADD CONSTRAINT "sitesmith-studio_run_projectId_sitesmith-studio_project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."sitesmith-studio_project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_session" ADD CONSTRAINT "sitesmith-studio_session_userId_sitesmith-studio_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."sitesmith-studio_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitesmith-studio_user" ADD CONSTRAINT "sitesmith-studio_user_tenantId_sitesmith-studio_tenant_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."sitesmith-studio_tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "sitesmith-studio_account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "finding_tenant_id_idx" ON "sitesmith-studio_finding" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "finding_run_id_idx" ON "sitesmith-studio_finding" USING btree ("runId");--> statement-breakpoint
CREATE INDEX "finding_type_idx" ON "sitesmith-studio_finding" USING btree ("runId","type");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_token_hash_uq" ON "sitesmith-studio_invite" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "invite_tenant_id_idx" ON "sitesmith-studio_invite" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "observation_tenant_id_idx" ON "sitesmith-studio_page_observation" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "observation_run_id_idx" ON "sitesmith-studio_page_observation" USING btree ("runId");--> statement-breakpoint
CREATE UNIQUE INDEX "observation_run_page_uq" ON "sitesmith-studio_page_observation" USING btree ("runId","pageId");--> statement-breakpoint
CREATE INDEX "snapshot_tenant_id_idx" ON "sitesmith-studio_page_snapshot" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "snapshot_run_id_idx" ON "sitesmith-studio_page_snapshot" USING btree ("runId");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_run_page_uq" ON "sitesmith-studio_page_snapshot" USING btree ("runId","pageId");--> statement-breakpoint
CREATE INDEX "page_tenant_id_idx" ON "sitesmith-studio_page" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "page_run_id_idx" ON "sitesmith-studio_page" USING btree ("runId");--> statement-breakpoint
CREATE INDEX "page_variant_group_idx" ON "sitesmith-studio_page" USING btree ("runId","variantGroupKey");--> statement-breakpoint
CREATE UNIQUE INDEX "page_run_url_uq" ON "sitesmith-studio_page" USING btree ("runId","url");--> statement-breakpoint
CREATE INDEX "project_assignment_tenant_id_idx" ON "sitesmith-studio_project_assignment" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "project_assignment_user_id_idx" ON "sitesmith-studio_project_assignment" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "project_assignment_project_id_idx" ON "sitesmith-studio_project_assignment" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "project_tenant_id_idx" ON "sitesmith-studio_project" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "run_tenant_id_idx" ON "sitesmith-studio_run" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "run_project_id_idx" ON "sitesmith-studio_run" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "t_user_id_idx" ON "sitesmith-studio_session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "user_tenant_id_idx" ON "sitesmith-studio_user" USING btree ("tenantId");