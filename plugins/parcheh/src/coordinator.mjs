import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function token() {
  return randomBytes(32).toString('base64url');
}

export function openCoordinator(dbPath, {
  roomId,
  maxMembers = 64,
  inviteSecret,
  inviteExpires = Date.now() + 8 * 60 * 60 * 1000,
  sharingMode: initSharingMode = 'instant',
  allowedEmails: initAllowedEmails = null,
  allowedDomain: initAllowedDomain = null,
  allowGuestInvite = true,
} = {}) {
  if (!existsSync(dbPath)) {
    writeFileSync(dbPath, '', { flag: 'wx', mode: 0o600 });
  }
  chmodSync(dbPath, 0o600);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_meta (
      roomId TEXT PRIMARY KEY,
      maxMembers INTEGER NOT NULL,
      inviteSecretHash TEXT,
      inviteExpires INTEGER NOT NULL,
      inviteRevoked INTEGER NOT NULL DEFAULT 0,
      sharingMode TEXT NOT NULL DEFAULT 'instant',
      allowedEmails TEXT,
      allowedDomain TEXT,
      allowGuestInvite INTEGER NOT NULL DEFAULT 1,
      groupKeyEpoch INTEGER NOT NULL DEFAULT 1,
      hostMemberId TEXT
    );
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      colorIndex INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      deviceKey TEXT,
      email TEXT,
      emailVerified INTEGER DEFAULT 0,
      joinedAt INTEGER NOT NULL,
      revokedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS grants (
      tokenHash TEXT PRIMARY KEY,
      memberId TEXT NOT NULL,
      role TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      revokedAt INTEGER,
      FOREIGN KEY(memberId) REFERENCES members(id)
    );
    CREATE TABLE IF NOT EXISTS revisions (
      rev INTEGER PRIMARY KEY,
      oid TEXT NOT NULL,
      actor TEXT NOT NULL,
      submissionId TEXT,
      createdAt INTEGER NOT NULL
    );
  `);
  try { db.exec('ALTER TABLE room_meta ADD COLUMN allowedEmails TEXT;'); } catch {}
  try { db.exec('ALTER TABLE room_meta ADD COLUMN allowedDomain TEXT;'); } catch {}

  if (roomId) {
    db.prepare(`
      INSERT OR IGNORE INTO room_meta (
        roomId, maxMembers, inviteSecretHash, inviteExpires, inviteRevoked,
        sharingMode, allowedEmails, allowedDomain, allowGuestInvite, groupKeyEpoch, hostMemberId
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 1, NULL)
    `).run(
      roomId,
      maxMembers,
      inviteSecret ? sha256Hex(inviteSecret) : null,
      inviteExpires,
      initSharingMode,
      initAllowedEmails,
      initAllowedDomain,
      allowGuestInvite ? 1 : 0,
    );
  }

  function getHostMemberId() {
    return db.prepare('SELECT hostMemberId FROM room_meta WHERE roomId = ?').get(roomId)?.hostMemberId ?? null;
  }

  function canMemberInvite(memberId) {
    if (memberId && memberId === getHostMemberId()) return true;
    const meta = db.prepare('SELECT allowGuestInvite FROM room_meta WHERE roomId = ?').get(roomId);
    return meta?.allowGuestInvite === 1;
  }

  function checkInvite(secret, now = Date.now()) {
    if (typeof secret !== 'string') return false;
    const meta = db.prepare('SELECT inviteSecretHash, inviteExpires, inviteRevoked FROM room_meta WHERE roomId = ?').get(roomId);
    if (!meta || meta.inviteRevoked || now > meta.inviteExpires) return false;
    const secretHash = Buffer.from(sha256Hex(secret));
    const expectedHash = Buffer.from(meta.inviteSecretHash || '');
    return secretHash.length === expectedHash.length && timingSafeEqual(secretHash, expectedHash);
  }

  function isInviteRevoked() {
    const meta = db.prepare('SELECT inviteRevoked FROM room_meta WHERE roomId = ?').get(roomId);
    return Boolean(meta?.inviteRevoked);
  }

  function inviteExpiresAt() {
    const meta = db.prepare('SELECT inviteExpires FROM room_meta WHERE roomId = ?').get(roomId);
    return meta?.inviteExpires ?? 0;
  }

  function activeMembers() {
    const rows = db.prepare('SELECT id, name, colorIndex, email, emailVerified FROM members WHERE revokedAt IS NULL ORDER BY joinedAt ASC').all();
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      colorIndex: r.colorIndex,
      ...(r.email && {
        email: r.email,
        emailVerified: Boolean(r.emailVerified),
        emailStatus: r.emailVerified ? 'verified' : 'unverified',
      }),
    }));
  }

  function allMembersWithIndex() {
    const rows = db.prepare('SELECT id, name, colorIndex, revokedAt, email, emailVerified FROM members ORDER BY joinedAt ASC').all();
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      colorIndex: r.colorIndex,
      revoked: Boolean(r.revokedAt),
      ...(r.email && {
        email: r.email,
        emailVerified: Boolean(r.emailVerified),
        emailStatus: r.emailVerified ? 'verified' : 'unverified',
      }),
    }));
  }

  function addMember({ name, role = 'editor', deviceKey = null, email = null, emailVerified = false, issueTokens = true } = {}) {
    const active = activeMembers();
    const meta = db.prepare('SELECT maxMembers FROM room_meta WHERE roomId = ?').get(roomId);
    const limit = meta?.maxMembers ?? maxMembers;
    if (active.length >= limit) {
      throw Object.assign(new Error('Room is full.'), { status: 409 });
    }

    let label = name;
    for (let number = 2; active.some(m => m.name.toLowerCase() === label.toLowerCase()); number++) {
      const suffix = ' ' + number;
      label = Array.from(name).slice(0, 40 - suffix.length).join('').trimEnd() + suffix;
    }

    const totalCount = db.prepare('SELECT COUNT(*) as count FROM members').get().count;
    const colorIndex = totalCount;
    const memberId = randomUUID();
    const now = Date.now();

    const currentHost = getHostMemberId();
    if (!currentHost) {
      db.prepare('UPDATE room_meta SET hostMemberId = ? WHERE roomId = ?').run(memberId, roomId);
    }

    db.prepare(`
      INSERT INTO members (id, name, colorIndex, role, deviceKey, email, emailVerified, joinedAt, revokedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      memberId,
      label,
      colorIndex,
      role,
      deviceKey,
      email,
      emailVerified ? 1 : 0,
      now,
    );

    let memberToken = null;
    let browserToken = null;
    if (issueTokens) {
      memberToken = token();
      browserToken = token();
      db.prepare(`
        INSERT INTO grants (tokenHash, memberId, role, createdAt, revokedAt)
        VALUES (?, ?, 'editor', ?, NULL)
      `).run(sha256Hex(memberToken), memberId, now);
      db.prepare(`
        INSERT INTO grants (tokenHash, memberId, role, createdAt, revokedAt)
        VALUES (?, ?, 'browser', ?, NULL)
      `).run(sha256Hex(browserToken), memberId, now);
    }

    return {
      member: {
        id: memberId,
        name: label,
        colorIndex,
        ...(email && {
          email,
          emailVerified: Boolean(emailVerified),
          emailStatus: emailVerified ? 'verified' : 'unverified',
        }),
      },
      memberToken,
      browserToken,
    };
  }

  function issueBrowserGrant(memberId) {
    const browserToken = token();
    const now = Date.now();
    db.prepare(`
      INSERT INTO grants (tokenHash, memberId, role, createdAt, revokedAt)
      VALUES (?, ?, 'browser', ?, NULL)
    `).run(sha256Hex(browserToken), memberId, now);
    return browserToken;
  }

  function verifyGrant(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const hash = sha256Hex(rawToken);
    const row = db.prepare(`
      SELECT g.role, g.revokedAt AS grantRevokedAt,
             m.id, m.name, m.colorIndex, m.email, m.emailVerified, m.revokedAt AS memberRevokedAt
      FROM grants g
      JOIN members m ON g.memberId = m.id
      WHERE g.tokenHash = ?
    `).get(hash);
    if (!row) return null;
    if (row.grantRevokedAt || row.memberRevokedAt) {
      return { revoked: true };
    }
    return {
      member: {
        id: row.id,
        name: row.name,
        colorIndex: row.colorIndex,
        ...(row.email && {
          email: row.email,
          emailVerified: Boolean(row.emailVerified),
          emailStatus: row.emailVerified ? 'verified' : 'unverified',
        }),
      },
      role: row.role,
    };
  }

  function groupKeyEpoch() {
    const meta = db.prepare('SELECT groupKeyEpoch FROM room_meta WHERE roomId = ?').get(roomId);
    return meta?.groupKeyEpoch ?? 1;
  }

  function revokeMember(targetIdOrName, actorMemberId) {
    const hostId = getHostMemberId();
    if (actorMemberId !== hostId) {
      throw Object.assign(new Error('Only the host can revoke a participant.'), { status: 403 });
    }
    const target = db.prepare(`
      SELECT id, name FROM members
      WHERE revokedAt IS NULL AND (id = ? OR LOWER(name) = LOWER(?))
    `).get(targetIdOrName, targetIdOrName);
    if (!target) {
      throw Object.assign(new Error('Participant not found in this room.'), { status: 404 });
    }
    if (target.id === hostId) {
      throw Object.assign(new Error('Use end_room to close the host session.'), { status: 400 });
    }

    const now = Date.now();
    db.prepare('UPDATE members SET revokedAt = ? WHERE id = ?').run(now, target.id);
    db.prepare('UPDATE grants SET revokedAt = ? WHERE memberId = ?').run(now, target.id);
    db.prepare('UPDATE room_meta SET groupKeyEpoch = groupKeyEpoch + 1 WHERE roomId = ?').run(roomId);

    return {
      revoked: { id: target.id, name: target.name },
      groupKeyEpoch: groupKeyEpoch(),
      members: activeMembers(),
    };
  }

  function leaveRoom(memberId) {
    const hostId = getHostMemberId();
    if (memberId === hostId) {
      throw Object.assign(new Error('Only guests can leave a room; use end_room as the host.'), { status: 400 });
    }
    const now = Date.now();
    db.prepare('UPDATE members SET revokedAt = ? WHERE id = ?').run(now, memberId);
    db.prepare('UPDATE grants SET revokedAt = ? WHERE memberId = ?').run(now, memberId);
    return { left: true, memberId };
  }

  function revokeInvite(actorMemberId) {
    const hostId = getHostMemberId();
    if (actorMemberId !== hostId) {
      throw Object.assign(new Error('Only the host can revoke an invitation.'), { status: 403 });
    }
    db.prepare('UPDATE room_meta SET inviteRevoked = 1, inviteExpires = 0 WHERE roomId = ?').run(roomId);
    return { inviteRevoked: true };
  }

  function newInvite(actorMemberId, newSecret, newExpires, { sharingMode, allowedEmails, allowedDomain, allowGuestInvite } = {}) {
    const hostId = getHostMemberId();
    if (actorMemberId !== hostId) {
      throw Object.assign(new Error('Only the host can create a new invitation.'), { status: 403 });
    }
    const currentMeta = db.prepare('SELECT sharingMode, allowedEmails, allowedDomain, allowGuestInvite FROM room_meta WHERE roomId = ?').get(roomId);
    const updatedSharingMode = sharingMode || currentMeta?.sharingMode || 'instant';
    if (!['instant', 'email', 'restricted'].includes(updatedSharingMode)) {
      throw Object.assign(new Error("sharingMode must be 'instant', 'email', or 'restricted'."), { status: 400 });
    }
    const updatedAllowedEmails = allowedEmails !== undefined ? allowedEmails : currentMeta?.allowedEmails;
    const updatedAllowedDomain = allowedDomain !== undefined ? allowedDomain : currentMeta?.allowedDomain;
    if (updatedSharingMode === 'restricted' && !updatedAllowedEmails && !updatedAllowedDomain) {
      throw Object.assign(new Error('Restricted rooms require allowedEmails or allowedDomain.'), { status: 400 });
    }
    let updatedAllowGuestInvite = allowGuestInvite !== undefined ? (allowGuestInvite ? 1 : 0) : currentMeta?.allowGuestInvite;
    if (updatedSharingMode === 'restricted' && allowGuestInvite === undefined && currentMeta?.sharingMode !== 'restricted') {
      updatedAllowGuestInvite = 0;
    }
    db.prepare(`
      UPDATE room_meta
      SET inviteSecretHash = ?, inviteRevoked = 0, inviteExpires = ?,
          sharingMode = ?, allowedEmails = ?, allowedDomain = ?, allowGuestInvite = ?
      WHERE roomId = ?
    `).run(sha256Hex(newSecret), newExpires, updatedSharingMode, updatedAllowedEmails, updatedAllowedDomain, updatedAllowGuestInvite, roomId);
    return { expires: newExpires };
  }

  function sharingMode() {
    return db.prepare('SELECT sharingMode FROM room_meta WHERE roomId = ?').get(roomId)?.sharingMode ?? 'instant';
  }

  function allowedEmails() {
    return db.prepare('SELECT allowedEmails FROM room_meta WHERE roomId = ?').get(roomId)?.allowedEmails ?? null;
  }

  function allowedDomain() {
    return db.prepare('SELECT allowedDomain FROM room_meta WHERE roomId = ?').get(roomId)?.allowedDomain ?? null;
  }

  function domainHint() {
    const domain = allowedDomain();
    if (!domain) return null;
    const trimmed = domain.trim().toLowerCase().replace(/^@/, '');
    return trimmed ? '@' + trimmed : null;
  }

  function isEmailAllowed(rawEmail) {
    const mode = sharingMode();
    if (mode !== 'restricted') return true;
    if (!rawEmail || typeof rawEmail !== 'string') return false;
    const email = rawEmail.trim().toLowerCase();
    const atIdx = email.lastIndexOf('@');
    const emailDomain = atIdx > 0 ? email.slice(atIdx + 1) : '';
    const domain = allowedDomain();
    if (domain) {
      const normDomain = domain.trim().toLowerCase().replace(/^@/, '');
      if (normDomain && (emailDomain === normDomain || emailDomain.endsWith('.' + normDomain))) {
        return true;
      }
    }
    const emails = allowedEmails();
    if (emails) {
      const list = emails.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      if (list.includes(email)) return true;
    }
    return false;
  }

  function updateMemberEmail(memberId, email, emailVerified = false) {
    const norm = email ? String(email).trim().toLowerCase() : null;
    db.prepare('UPDATE members SET email = ?, emailVerified = ? WHERE id = ?').run(
      norm,
      emailVerified ? 1 : 0,
      memberId,
    );
  }

  function recordRevision({ rev, oid, actor, submissionId }) {
    db.prepare(`
      INSERT OR IGNORE INTO revisions (rev, oid, actor, submissionId, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(rev, oid, actor, submissionId, Date.now());
  }

  function close() {
    db.close();
  }

  return {
    checkInvite,
    isInviteRevoked,
    inviteExpiresAt,
    activeMembers,
    allMembersWithIndex,
    addMember,
    issueBrowserGrant,
    verifyGrant,
    groupKeyEpoch,
    revokeMember,
    leaveRoom,
    revokeInvite,
    newInvite,
    sharingMode,
    allowedEmails,
    allowedDomain,
    domainHint,
    isEmailAllowed,
    updateMemberEmail,
    recordRevision,
    getHostMemberId,
    canMemberInvite,
    close,
  };
}
