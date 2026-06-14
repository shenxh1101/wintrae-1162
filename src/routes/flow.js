const express = require('express');
const qrcode = require('qrcode');
const db = require('../models/db');
const config = require('../config');
const { authRequired } = require('../middleware/auth');
const { success, error, parseJson } = require('../utils/response');
const { triggerCallback, writeAuditLog } = require('../utils/callback');

const router = express.Router();

function findRegWithEvent(regId, organizerId) {
  const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId);
  if (!reg) return null;
  const evt = db.prepare('SELECT * FROM events WHERE id = ?').get(reg.event_id);
  if (!evt) return null;
  if (organizerId !== undefined && evt.organizer_id !== organizerId) return null;
  return { reg, evt };
}

function promoteWaitlist(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return [];

  const approvedCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'approved'").get(eventId).count;
  const promoted = [];

  let slotsAvailable = event.capacity - approvedCount;
  while (slotsAvailable > 0) {
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
    slotsAvailable--;

    promoted.push({ id: nextWaitlist.id, user_name: nextWaitlist.user_name, to_status: newStatus });
    writeAuditLog(eventId, nextWaitlist.id, 'waitlist_promoted', { to_status: newStatus });
    triggerCallback(event.organizer_id, 'registration.status_changed', {
      id: nextWaitlist.id,
      event_id: eventId,
      event_title: event.title,
      user_name: nextWaitlist.user_name,
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
  const eventId = parseInt(req.params.eventId);

  if (!user_identifier) {
    return error(res, '用户标识为必填项');
  }

  const registration = db.prepare('SELECT * FROM registrations WHERE event_id = ? AND user_identifier = ?').get(eventId, user_identifier);
  if (!registration) {
    return error(res, '未找到报名记录', 404);
  }

  if (registration.status === 'cancelled') {
    return error(res, '该报名已取消');
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const oldStatus = registration.status;

  db.prepare("UPDATE registrations SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(registration.id);
  writeAuditLog(eventId, registration.id, 'registration_self_cancelled', { old_status: oldStatus });

  if (event) {
    triggerCallback(event.organizer_id, 'registration.status_changed', {
      id: registration.id,
      event_id: eventId,
      event_title: event.title,
      user_name: registration.user_name,
      old_status: oldStatus,
      new_status: 'cancelled',
      self_cancelled: true
    });
  }

  const promoted = promoteWaitlist(eventId);

  return success(res, { promoted_count: promoted.length, promoted_list: promoted }, '报名已取消');
});

router.use(authRequired);

router.post('/:id/approve', (req, res) => {
  const found = findRegWithEvent(req.params.id, req.organizer.id);
  if (!found) {
    return error(res, '报名记录不存在', 404);
  }

  const { reg, evt } = found;

  if (reg.status === 'approved') {
    return error(res, '该报名已审核通过');
  }
  if (reg.status === 'cancelled') {
    return error(res, '该报名已取消，无法审核');
  }
  if (reg.status === 'rejected') {
    return error(res, '该报名已被拒绝，无法审核');
  }

  const approvedCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'approved'").get(reg.event_id).count;

  if (reg.status === 'waitlist') {
    if (approvedCount >= evt.capacity) {
      return error(res, '名额已满，无法审核通过候补中的报名，请等待有人取消后再试');
    }
  } else if (reg.status === 'pending') {
    if (approvedCount >= evt.capacity) {
      const waitlistCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'waitlist'").get(reg.event_id).count;
      if (waitlistCount >= evt.waitlist_limit) {
        return error(res, '名额已满且候补队列已满，无法审核通过');
      }
      db.prepare("UPDATE registrations SET status = 'waitlist', queue_position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(waitlistCount + 1, reg.id);
      writeAuditLog(reg.event_id, reg.id, 'registration_waitlist_from_pending', { queue_position: waitlistCount + 1 });
      triggerCallback(evt.organizer_id, 'registration.status_changed', {
        id: reg.id, event_id: reg.event_id, event_title: evt.title, user_name: reg.user_name,
        old_status: reg.status, new_status: 'waitlist', queue_position: waitlistCount + 1
      });
      return success(res, { status: 'waitlist', queue_position: waitlistCount + 1 }, '名额已满，已加入候补队列');
    }
  }

  db.prepare("UPDATE registrations SET status = 'approved', approved_at = CURRENT_TIMESTAMP, queue_position = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reg.id);
  writeAuditLog(reg.event_id, reg.id, 'registration_approved', null);
  triggerCallback(evt.organizer_id, 'registration.status_changed', {
    id: reg.id, event_id: reg.event_id, event_title: evt.title, user_name: reg.user_name,
    old_status: reg.status, new_status: 'approved'
  });

  return success(res, { status: 'approved' }, '审核通过');
});

router.post('/:id/reject', (req, res) => {
  const { reason } = req.body;
  const found = findRegWithEvent(req.params.id, req.organizer.id);
  if (!found) {
    return error(res, '报名记录不存在', 404);
  }

  const { reg, evt } = found;

  if (reg.status !== 'pending') {
    return error(res, '只能拒绝待审核的报名');
  }

  db.prepare("UPDATE registrations SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reg.id);
  writeAuditLog(reg.event_id, reg.id, 'registration_rejected', { reason });
  triggerCallback(evt.organizer_id, 'registration.status_changed', {
    id: reg.id, event_id: reg.event_id, event_title: evt.title, user_name: reg.user_name,
    old_status: reg.status, new_status: 'rejected', reason
  });

  promoteWaitlist(reg.event_id);
  return success(res, null, '已拒绝该报名');
});

router.post('/:id/cancel', (req, res) => {
  const { reason } = req.body;
  const found = findRegWithEvent(req.params.id, req.organizer.id);
  if (!found) {
    return error(res, '报名记录不存在', 404);
  }

  const { reg, evt } = found;

  if (reg.status === 'cancelled') {
    return error(res, '该报名已取消');
  }

  const oldStatus = reg.status;
  db.prepare("UPDATE registrations SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reg.id);
  writeAuditLog(reg.event_id, reg.id, 'registration_cancelled', { reason, old_status: oldStatus });
  triggerCallback(evt.organizer_id, 'registration.status_changed', {
    id: reg.id, event_id: reg.event_id, event_title: evt.title, user_name: reg.user_name,
    old_status: oldStatus, new_status: 'cancelled', reason
  });

  const promoted = promoteWaitlist(reg.event_id);

  return success(res, { promoted_count: promoted.length, promoted_list: promoted }, '报名已取消，候补名额已自动补位');
});

router.post('/:id/qrcode', async (req, res) => {
  const found = findRegWithEvent(req.params.id, req.organizer.id);
  if (!found) {
    return error(res, '报名记录不存在', 404);
  }

  const { reg, evt } = found;

  if (reg.status !== 'approved') {
    return error(res, '仅审核通过的报名可生成签到二维码');
  }

  const qrCodeUrl = `${config.registration.qrCodeBaseUrl}?code=${reg.checkin_code}`;
  let qrCodeDataUri = null;
  try {
    qrCodeDataUri = await qrcode.toDataURL(qrCodeUrl);
  } catch {}

  return success(res, {
    registration_id: reg.id,
    user_name: reg.user_name,
    event_title: evt.title,
    checkin_code: reg.checkin_code,
    qr_code_url: qrCodeUrl,
    qr_code_data_uri: qrCodeDataUri
  });
});

module.exports = router;
module.exports.promoteWaitlist = promoteWaitlist;
