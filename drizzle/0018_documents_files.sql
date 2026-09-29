CREATE TABLE "document_files" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_size_chk" CHECK ("document_files"."size_bytes" > 0 AND "document_files"."size_bytes" <= 10485760)
);
--> statement-breakpoint
ALTER TABLE "document_files" ADD CONSTRAINT "files_document_tenant_fk" FOREIGN KEY ("document_id","tenant_id") REFERENCES "public"."documents"("id","tenant_id") ON DELETE cascade ON UPDATE no action;