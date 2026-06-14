const express = require('express');
const qrcode = require('qrcode');
const db = require('../models/db');
const config = require('../config');
const { authRequired } = require('../middleware/auth');
const { success, error, parseJson } = require('../utils/response');
const { triggerCallback, writeAuditLog } = require('../utils/callback');

const router = express.Router();

function promoteWaitlist(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return [];

  const approvedCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'approved'").get(eventId).count;
  const promoted = [];

  while (approvedCount + promoted.length < event.capacity) {
    const nextWaitlist = db.prepare(`
      SELECT * FROM registrations
      WHERE event_id = ? AND status = 'waitlist'
      ORDER BY queue_position ASC, created_at ASC
      LIMIT 1
    `).get(eventId);

    if (!nextWaitlist) break;

    const newStatus = event.require_approval ? 'pending' : 'approved';
    if (newStatus === 'approved') {
      db.prepare("UPDATE registrations SET status = 'approved', queue_position = NULL, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(nextWaitlist.id);
    } else {
      db.prepare("UPDATE registrations SET status = 'pending', queue_position = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(nextWaitlist.id);
    }

    promoted.push({ id: nextWaitlist.id, status: newStatus });
    writeAuditLog(eventId, nextWaitlist.id, 'waitlist_promoted', { to_status: newStatus });
    triggerCallback(event.organizer_id, 'registration.status_changed', {
      id: nextWaitlist.id,
      event_id: eventId,
      old_status: 'waitlist',
      new_status: newStatus
    });
  }

  const waitlistItems = db.prepare("SELECT id FROM registrations WHERE event_id = ? AND status = 'waitlist' ORDER BY queue_position ASC").all(eventId);
  waitlistItems.forEach((item, index) => {
    db.prepare('UPDATE registrations SET queue_position = ? WHERE id = ?').run(index + 1, item.id);
  });

  return promoted;
}

router.post('/public/:eventId/cancel', (req, res) => {
  const { user_identifier } = req.body;
  const eventId = req.params.eventId;

  if (!user_identifier) {
    return error(res, '用户标识为必填项');
  }

  const registration = db.prepare(`
    SELECT r.*, e.organizer_id
    FROM registrations r
    JOIN events e ON r.event_id = e.id
    WHERE r.event_id = ? AND r.user_identifier = ?
  `).get(eventId, user_identifier);

  if (!registration) {
    return error(res, '未找到报名记录', 404);
  }

  if (registration.status === 'cancelled') {
    return error(res, '该报名已取消');
  }

  const oldStatus = registration.status;
  db.prepare("UPDATE registrations SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(registration.id);
  writeAuditLog(eventId, registration.id, 'registration_self_cancelled', { old_status: oldStatus });
  triggerCallback(registration.organizer_id, 'registration.status_changed', {
    id: registration.id,
    event_id: eventId,
    old_status: oldStatus,
    new_status: 'cancelled',
    self_cancelled: true
  });

  const promoted = promoteWaitlist(eventId);

  return success(res, { promoted_count: promoted.length }, '报名已取消');
});

router.use(authRequired);

router.post('/:id/approve', (req, res) => {
  const registration = db.prepare(`
    SELECT r.*, e.organizer_id, e.capacity, e.require_approval
    FROM registrations r
    JOIN events e ON r.event_id = e.id
    WHERE r.id = ? AND e.organizer_id = ?
  `).get(req.params.id, req.organizer.id);

  if (!registration) {
    return error(res, '报名记录不存在', 404);
  }

  if (registration.status === 'approved') {
    return error(res, '该报名已审核通过');
  }
  if (registration.status === 'cancelled') {
    return error(res, '该报名已取消，无法审核');
  }

  const tx = db.transaction(() => {
    const approvedCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'approved'").get(registration.event_id).count;

    if (registration.status === 'waitlist') {
      if (approvedCount >= registration.capacity) {
        db.prepare("UPDATE registrations SET status = 'pending', queue_position = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(registration.id);
        writeAuditLog(registration.event_id, registration.id, 'registration_pending_from_waitlist', null);
        return { status: 'pending' };
      }
    } else if (registration.status === 'pending') {
      if (approvedCount >= registration.capacity) {
        const waitlistCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'waitlist'").get(registration.event_id).count;
        const event = db.prepare('SELECT waitlist_limit FROM events WHERE id = ?').get(registration.event_id);
        if (waitlistCount >= event.waitlist_limit) {
          throw new Error('名额已满且候补队列已满，无法审核通过');
        }
        db.prepare("UPDATE registrations SET status = 'waitlist', queue_position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(waitlistCount + 1, registration.id);
        writeAuditLog(registration.event_id, registration.id, 'registration_waitlist_from_pending', { queue_position: waitlistCount + 1 });
        return { status: 'waitlist', queue_position: waitlistCount + 1 };
      }
    }

    db.prepare("UPDATE registrations SET status = 'approved', approved_at = CURRENT_TIMESTAMP, queue_position = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(registration.id);
    writeAuditLog(registration.event_id, registration.id, 'registration_approved', null);
    triggerCallback(registration.organizer_id, 'registration.status_changed', {
      id: registration.id,
      event_id: registration.event_id,
      old_status: registration.status,
      new_status: 'approved'
    });
    return { status: 'approved' };
  });

  try {
    const result = tx();
    return success(res, result, result.status === 'approved' ? '审核通过' : (result.status === 'pending' ? '已进入待审核状态' : '名额已满，已加入候补队列'));
  } catch (err) {
    return error(res, err.message);
  }
});

router.post('/:id/reject', (req, res) => {
  const { reason } = req.body;
  const registration = db.prepare(`
    SELECT r.*, e.organizer_id
    FROM registrations r
    JOIN events e ON r.event_id = e.id
    WHERE r.id = ? AND e.organizer_id = ?
  `).get(req.params.id, req.organizer.id);

  if (!registration) {
    return error(res, '报名记录不存在', 404);
  }

  if (registration.status !== 'pending') {
    return error(res, '只能拒绝待审核的报名');
  }

  db.prepare("UPDATE registrations SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(registration.id);
  writeAuditLog(registration.event_id, registration.id, 'registration_rejected', { reason });
  triggerCallback(registration.organizer_id, 'registration.status_changed', {
    id: registration.id,
    event_id: registration.event_id,
    old_status: registration.status,
    new_status: 'rejected',
    reason
  });

  promoteWaitlist(registration.event_id);
  return success(res, null, '已拒绝该报名');
});

router.post('/:id/cancel', (req, res) => {
  const { reason } = req.body;
  const registration = db.prepare(`
    SELECT r.*, e.organizer_id
    FROM registrations r
    JOIN events e ON r.event_id = e.id
    WHERE r.id = ? AND e.organizer_id = ?
  `).get(req.params.id, req.organizer.id);

  if (!registration) {
    return error(res, '报名记录不存在', 404);
  }

  if (registration.status === 'cancelled') {
    return error(res, '该报名已取消');
  }

  const oldStatus = registration.status;
  db.prepare("UPDATE registrations SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(registration.id);
  writeAuditLog(registration.event_id, registration.id, 'registration_cancelled', { reason, old_status });
  triggerCallback(registration.organizer_id, 'registration.status_changed', {
    id: registration.id,
    event_id: registration.event_id,
    old_status: oldStatus,
    new_status: 'cancelled',
    reason
  });

  const promoted = promoteWaitlist(registration.event_id);

  return success(res, { promoted_count: promoted.length }, '报名已取消，候补名额已自动补位');
});

router.post('/:id/qrcode', async (req, res) => {
  const registration = db.prepare(`
    SELECT r.*, e.organizer_id
    FROM registrations r
    JOIN events e ON r.event_id = e.id
    WHERE r.id = ? AND e.organizer_id = ?
  `).get(req.params.id, req.organizer.id);

  if (!registration) {
    return error(res, '报名记录不存在', 404);
  }

  if (registration.status !== 'approved') {
    return error(res, '仅审核通过的报名可生成签到二维码');
  }

  const qrCodeUrl = `${config.registration.qrCodeBaseUrl}?code=${registration.checkin_code}`;
  let qrCodeDataUri = null;
  try {
    qrCodeDataUri = await qrcode.toDataURL(qrCodeUrl);
  } catch {}

  return success(res, {
    checkin_code: registration.checkin_code,
    qr_code_url: qrCodeUrl,
    qr_code_data_uri: qrCodeDataUri
  });
});

module.exports = router;
module.exports.promoteWaitlist = promoteWaitlist;
