import type { DatabaseSync } from "node:sqlite";

/**
 * Forward-only schema migrations. The applied versions are listed in `schema_migrations`.
 * Every migration must be safe to run on a database created by an older build (it may already contain
 * some of the objects), so use `addColumn` and `IF NOT EXISTS` rather than assuming a clean slate.
 */
export type Migration = { version: number; name: string; up: (db: DatabaseSync) => void };

export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/** ALTER TABLE ADD COLUMN unless it is already there. The table itself must exist. */
export function addColumn(db: DatabaseSync, table: string, column: string, definition: string) {
	if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrate(db: DatabaseSync, migrations: Migration[]): number[] {
	db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
	const sorted = [...migrations].sort((a, b) => a.version - b.version);
	if (new Set(sorted.map((m) => m.version)).size !== sorted.length) throw new Error("duplicate migration version");
	const done = new Set((db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version));
	const known = new Set(sorted.map((m) => m.version));
	for (const v of done) if (!known.has(v)) throw new Error(`database has migration ${v} which this build does not know (downgrade?)`);
	const applied: number[] = [];
	for (const m of sorted) {
		if (done.has(m.version)) continue;
		db.exec("BEGIN");
		try {
			m.up(db);
			db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)").run(m.version, m.name, Date.now());
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw new Error(`migration ${m.version} (${m.name}) failed: ${(e as Error).message}`);
		}
		applied.push(m.version);
	}
	return applied;
}
