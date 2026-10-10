CREATE SCHEMA IF NOT EXISTS audit;

CREATE OR REPLACE FUNCTION audit.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% on %.% is not allowed: append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME; END $$;

CREATE TABLE audit.change_matches (
	engagement_id VARCHAR(64) NOT NULL, 
	seq BIGINT NOT NULL, 
	detail JSON, 
	PRIMARY KEY (engagement_id, seq)
);
CREATE TRIGGER change_matches_append_only BEFORE UPDATE OR DELETE ON audit.change_matches FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.engagement_events (
	id SERIAL NOT NULL, 
	engagement_id VARCHAR(64) NOT NULL, 
	kind VARCHAR(32) NOT NULL, 
	step VARCHAR(64), 
	detail JSON, 
	identity TEXT, 
	at VARCHAR(32), 
	PRIMARY KEY (id)
);
CREATE INDEX ix_audit_engagement_events_engagement_id ON audit.engagement_events (engagement_id);
CREATE TRIGGER engagement_events_append_only BEFORE UPDATE OR DELETE ON audit.engagement_events FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.engagements (
	engagement_id VARCHAR(64) NOT NULL, 
	client_name TEXT, 
	period_start DATE NOT NULL, 
	period_end DATE NOT NULL, 
	seed VARCHAR(128) NOT NULL, 
	entity_ids JSON, 
	snapshot_seq BIGINT NOT NULL, 
	snapshot_hash VARCHAR(64) NOT NULL, 
	merkle_root VARCHAR(64), 
	register_upload_seq BIGINT, 
	rp_upload_seq BIGINT, 
	opened_by TEXT, 
	opened_at VARCHAR(32), 
	PRIMARY KEY (engagement_id)
);
CREATE TRIGGER engagements_append_only BEFORE UPDATE OR DELETE ON audit.engagements FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.evidence_requests (
	request_id VARCHAR(64) NOT NULL, 
	engagement_id VARCHAR(64) NOT NULL, 
	sample_id VARCHAR(64) NOT NULL, 
	document_type VARCHAR(32) NOT NULL, 
	note TEXT, 
	created_by TEXT, 
	created_at VARCHAR(32), 
	PRIMARY KEY (request_id)
);
CREATE INDEX ix_audit_evidence_requests_engagement_id ON audit.evidence_requests (engagement_id);
CREATE TRIGGER evidence_requests_append_only BEFORE UPDATE OR DELETE ON audit.evidence_requests FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.evidence_results (
	id SERIAL NOT NULL, 
	engagement_id VARCHAR(64) NOT NULL, 
	request_id VARCHAR(64) NOT NULL, 
	sample_id VARCHAR(64) NOT NULL, 
	upload_seq BIGINT NOT NULL, 
	file_hash VARCHAR(64) NOT NULL, 
	extracted JSON, 
	checks JSON, 
	at VARCHAR(32), 
	PRIMARY KEY (id)
);
CREATE INDEX ix_audit_evidence_results_engagement_id ON audit.evidence_results (engagement_id);
CREATE TRIGGER evidence_results_append_only BEFORE UPDATE OR DELETE ON audit.evidence_results FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.extraction_cache (
	file_hash VARCHAR(64) NOT NULL, 
	document_type VARCHAR(32) NOT NULL, 
	result JSON, 
	PRIMARY KEY (file_hash, document_type)
);
CREATE TRIGGER extraction_cache_append_only BEFORE UPDATE OR DELETE ON audit.extraction_cache FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.finding_decisions (
	id SERIAL NOT NULL, 
	finding_id VARCHAR(32) NOT NULL, 
	engagement_id VARCHAR(64) NOT NULL, 
	decision VARCHAR(16) NOT NULL, 
	note TEXT, 
	identity TEXT, 
	role VARCHAR(32), 
	at VARCHAR(32), 
	PRIMARY KEY (id)
);
CREATE INDEX ix_audit_finding_decisions_engagement_id ON audit.finding_decisions (engagement_id);
CREATE INDEX ix_audit_finding_decisions_finding_id ON audit.finding_decisions (finding_id);
CREATE TRIGGER finding_decisions_append_only BEFORE UPDATE OR DELETE ON audit.finding_decisions FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.findings (
	finding_id VARCHAR(32) NOT NULL, 
	engagement_id VARCHAR(64) NOT NULL, 
	detector_id VARCHAR(8) NOT NULL, 
	category VARCHAR(40) NOT NULL, 
	severity VARCHAR(8) NOT NULL, 
	record JSON NOT NULL, 
	created_at VARCHAR(32), 
	PRIMARY KEY (finding_id)
);
CREATE INDEX ix_audit_findings_engagement_id ON audit.findings (engagement_id);
CREATE TRIGGER findings_append_only BEFORE UPDATE OR DELETE ON audit.findings FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.indicators (
	engagement_id VARCHAR(64) NOT NULL, 
	subject_id VARCHAR(128) NOT NULL, 
	detail JSON, 
	PRIMARY KEY (engagement_id, subject_id)
);
CREATE TRIGGER indicators_append_only BEFORE UPDATE OR DELETE ON audit.indicators FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.outputs (
	id SERIAL NOT NULL, 
	engagement_id VARCHAR(64) NOT NULL, 
	kind VARCHAR(16) NOT NULL, 
	file_hash VARCHAR(64) NOT NULL, 
	path TEXT, 
	head_hash VARCHAR(64), 
	at VARCHAR(32), 
	PRIMARY KEY (id)
);
CREATE INDEX ix_audit_outputs_engagement_id ON audit.outputs (engagement_id);
CREATE TRIGGER outputs_append_only BEFORE UPDATE OR DELETE ON audit.outputs FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.register_imports (
	engagement_id VARCHAR(64) NOT NULL, 
	file_hash VARCHAR(64) NOT NULL, 
	file_name TEXT, 
	upload_seq BIGINT, 
	headers JSON, 
	column_map JSON, 
	missing_columns JSON, 
	row_count INTEGER, 
	at VARCHAR(32), 
	PRIMARY KEY (engagement_id)
);
CREATE TRIGGER register_imports_append_only BEFORE UPDATE OR DELETE ON audit.register_imports FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.register_recon (
	engagement_id VARCHAR(64) NOT NULL, 
	row_no INTEGER NOT NULL, 
	status TEXT NOT NULL, 
	finding_refs JSON, 
	PRIMARY KEY (engagement_id, row_no)
);
CREATE TRIGGER register_recon_append_only BEFORE UPDATE OR DELETE ON audit.register_recon FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.register_rows (
	engagement_id VARCHAR(64) NOT NULL, 
	row_no INTEGER NOT NULL, 
	raw JSON NOT NULL, 
	parsed JSON NOT NULL, 
	PRIMARY KEY (engagement_id, row_no)
);
CREATE TRIGGER register_rows_append_only BEFORE UPDATE OR DELETE ON audit.register_rows FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.rp_tags (
	engagement_id VARCHAR(64) NOT NULL, 
	customer_id VARCHAR(128) NOT NULL, 
	tag VARCHAR(32) NOT NULL, 
	detail JSON, 
	PRIMARY KEY (engagement_id, customer_id)
);
CREATE TRIGGER rp_tags_append_only BEFORE UPDATE OR DELETE ON audit.rp_tags FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.sample_meta (
	engagement_id VARCHAR(64) NOT NULL, 
	sheet VARCHAR(32) NOT NULL, 
	detail JSON, 
	PRIMARY KEY (engagement_id, sheet)
);
CREATE TRIGGER sample_meta_append_only BEFORE UPDATE OR DELETE ON audit.sample_meta FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.sample_tests (
	id SERIAL NOT NULL, 
	sample_id VARCHAR(64) NOT NULL, 
	engagement_id VARCHAR(64) NOT NULL, 
	tests JSON NOT NULL, 
	flags JSON, 
	cause TEXT, 
	at VARCHAR(32), 
	PRIMARY KEY (id)
);
CREATE INDEX ix_audit_sample_tests_sample_id ON audit.sample_tests (sample_id);
CREATE INDEX ix_audit_sample_tests_engagement_id ON audit.sample_tests (engagement_id);
CREATE TRIGGER sample_tests_append_only BEFORE UPDATE OR DELETE ON audit.sample_tests FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

CREATE TABLE audit.samples (
	sample_id VARCHAR(64) NOT NULL, 
	engagement_id VARCHAR(64) NOT NULL, 
	sheet VARCHAR(32) NOT NULL, 
	position INTEGER NOT NULL, 
	subject_type VARCHAR(32) NOT NULL, 
	subject_id VARCHAR(128) NOT NULL, 
	reason TEXT, 
	reason_codes JSON, 
	score INTEGER, 
	data JSON, 
	PRIMARY KEY (sample_id)
);
CREATE INDEX ix_audit_samples_engagement_id ON audit.samples (engagement_id);
CREATE TRIGGER samples_append_only BEFORE UPDATE OR DELETE ON audit.samples FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();

GRANT USAGE ON SCHEMA audit TO engine_audit, mcp_read;
GRANT INSERT, SELECT ON ALL TABLES IN SCHEMA audit TO engine_audit;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA audit TO engine_audit;
GRANT SELECT ON ALL TABLES IN SCHEMA audit TO mcp_read;
