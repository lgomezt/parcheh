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
  // The private journal follows the chosen room lineage. The operations table
  // is the contiguous projection available to guests of this room.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='journal'").get()) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE journal AS SELECT documentId,id,memberId,name,actionId,payload FROM operations ORDER BY rowid;
      COMMIT;`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS journal_ids ON journal(documentId,memberId,id)');
  const known = db.prepare('SELECT 1 FROM journal WHERE documentId=? AND memberId=? AND id=?');
  const remember = db.prepare('INSERT INTO journal (documentId,id,memberId,name,actionId,payload) VALUES (?,?,?,?,?,?)');
  const latest = db.prepare('SELECT MAX(seq) AS seq FROM operations WHERE documentId = ?');
  const head = (documentId) => latest.get(documentId).seq ?? 0;
  const lookup = db.prepare('SELECT seq, actionId, payload FROM operations WHERE documentId=? AND memberId=? AND id=?');
  const size = db.prepare('SELECT MAX(rowid) AS count FROM journal');
  const insert = db.prepare('INSERT INTO operations (documentId,seq,id,memberId,name,actionId,payload) VALUES (?,?,?,?,?,?,?)');
  const page = db.prepare('SELECT seq,id,memberId,name,actionId,payload FROM operations WHERE documentId=? AND seq>? ORDER BY seq LIMIT ?');

  function rebuild(document, validate) {
    db.exec('DELETE FROM operations');
    if (!document) return;
    let seq=0;
    for (const row of db.prepare('SELECT * FROM journal WHERE documentId=? ORDER BY rowid').iterate(document.id)) {
      if (!document.actions.includes(row.actionId)) continue;
      let payload;
      try { payload=validate(row.actionId,JSON.parse(row.payload)); } catch { continue; }
      insert.run(document.id,++seq,row.id,row.memberId,row.name,row.actionId,JSON.stringify(payload));
    }
  }

  return {
    head,
    project(document, validate) {
      db.exec('BEGIN IMMEDIATE');
      try {
        rebuild(document,validate);
        db.exec('COMMIT');
      } finally {
        if (db.isTransaction) db.exec('ROLLBACK');
      }
    },
    inherit(source, document, validate) {
      const previous = new DatabaseSync(source, {readOnly:true});
      try {
        db.exec('BEGIN IMMEDIATE');
        const hasJournal = previous.prepare("SELECT 1 FROM sqlite_master WHERE name='journal'").get();
        const rows = previous.prepare(hasJournal ? 'SELECT * FROM journal ORDER BY rowid' : 'SELECT * FROM operations ORDER BY rowid');
        let count=0;
        for (const row of rows.iterate()) {
          if (++count > MAX_OPERATIONS) throw fail(507,'The room drawing history is full.');
          remember.run(row.documentId,row.id,row.memberId,row.name,row.actionId,row.payload);
        }
        rebuild(document,validate);
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
          if (known.get(documentId,member.id,id)) throw fail(409,'This operation ID already belongs to another change.');
          if (size.get().count >= MAX_OPERATIONS) throw fail(507, 'The room drawing history is full.');
          seq = head(documentId) + 1;
          insert.run(documentId, seq, id, member.id, member.name, actionId, encoded);
          remember.run(documentId,id,member.id,member.name,actionId,encoded);
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
