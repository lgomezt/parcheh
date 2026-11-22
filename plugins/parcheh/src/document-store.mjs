import { DatabaseSync } from 'node:sqlite';

const PAGE_SIZE = 256;
const MAX_OPERATIONS = 100_000;
const fail = (status, message) => Object.assign(new Error(message), { status });

// Each room owns one private database alongside its Git history. Only validated
// document operations enter this store. Member/browser credentials stay in memory.
export function openDocumentStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 1000;
    CREATE TABLE IF NOT EXISTS operations (
      documentId TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
      memberId TEXT NOT NULL, name TEXT NOT NULL, actionId TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(documentId, seq), UNIQUE(documentId, memberId, id)
    );
  `);
  const latest = db.prepare('SELECT MAX(seq) AS seq FROM operations WHERE documentId = ?');
  const head = (documentId) => latest.get(documentId).seq ?? 0;
  const lookup = db.prepare('SELECT seq, actionId, payload FROM operations WHERE documentId=? AND memberId=? AND id=?');
  const size = db.prepare('SELECT MAX(rowid) AS count FROM operations');
  const insert = db.prepare('INSERT INTO operations (documentId,seq,id,memberId,name,actionId,payload) VALUES (?,?,?,?,?,?,?)');
  const page = db.prepare('SELECT seq,id,memberId,name,actionId,payload FROM operations WHERE documentId=? AND seq>? ORDER BY seq LIMIT ?');

  return {
    head,
    inherit(source, document, validate) {
      const previous = new DatabaseSync(source, {readOnly:true});
      try {
        db.exec('BEGIN IMMEDIATE');
        let seq=0;
        for (const row of previous.prepare('SELECT * FROM operations WHERE documentId=? ORDER BY seq').iterate(document.id)) {
          if (!document.actions.includes(row.actionId)) continue;
          let payload;
          try { payload=validate(row.actionId,JSON.parse(row.payload)); } catch { continue; }
          if (++seq > MAX_OPERATIONS) throw fail(507,'The room drawing history is full.');
          insert.run(document.id,seq,row.id,row.memberId,row.name,row.actionId,JSON.stringify(payload));
        }
        db.exec('COMMIT');
      } finally {
        if (db.isTransaction) db.exec('ROLLBACK');
        previous.close();
      }
    },
    append(documentId, member, id, actionId, payload) {
      const encoded = JSON.stringify(payload);
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = lookup.get(documentId, member.id, id);
        let seq = previous?.seq;
        if (previous) {
          if (previous.actionId !== actionId || previous.payload !== encoded) {
            throw fail(409, 'This operation ID already belongs to another change.');
          }
        } else {
          if (size.get().count >= MAX_OPERATIONS) throw fail(507, 'The room drawing history is full.');
          seq = head(documentId) + 1;
          insert.run(documentId, seq, id, member.id, member.name, actionId, encoded);
        }
        db.exec('COMMIT');
        return { documentId, seq, id };
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    read(documentId, after) {
      const operations = page.all(documentId, after, PAGE_SIZE).map(row => ({
        ...row, payload: JSON.parse(row.payload),
      }));
      const currentHead = head(documentId);
      return { documentId, head: currentHead, operations, more: (operations.at(-1)?.seq ?? after) < currentHead };
    },
    close() { db.close(); },
  };
}
