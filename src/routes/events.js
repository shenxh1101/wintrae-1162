const express = require('express');
const db = require('../models/db');
const { authRequired } = require('../middleware/auth');
const { success, error, parseJson, stringifyJson } = require('../utils/response');
const { writeAuditLog } = require('../utils/callback');

const router = express.Router();

router.use(authRequired);

router.post('/', (req, res) => {
  const { title, description, location, start_time, end_time, capacity, waitlist_limit, require_approval, form_fields } = req.body;

  if (!title || !start_time || !capacity) {
    return error(res, '活动标题、开始时间和名额上限为必填项');
  }

  if (capacity <= 0) {
    return error(res, '名额上限必须大于 0');
  }

  const result = db.prepare(`
    INSERT INTO events (organizer_id, title, description, location, start_time, end_time, capacity, waitlist_limit, require_approval, form_fields)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.organizer.id,
    title,
    description || null,
    location || null,
    start_time,
    end_time || null,
    capacity,
    waitlist_limit || 50,
    require_approval ? 1 : 0,
    form_fields ? stringifyJson(form_fields) : null
  );

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid);
  writeAuditLog(event.id, null, 'event_created', { title });

  return success(res, formatEvent(event), '活动创建成功');
});

router.get('/', (req, res) => {
  const { status, page = 1, page_size = 20 } = req.query;
  const offset = (page - 1) * page_size;

  let whereClause = 'WHERE organizer_id = ?';
  const params = [req.organizer.id];

  if (status) {
    whereClause += ' AND status = ?';
    params.push(status);
  }

  const events = db.prepare(`SELECT * FROM events ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(
    ...params, parseInt(page_size), offset
  );

  const total = db.prepare(`SELECT COUNT(*) as count FROM events ${whereClause}`).get(...params).count;

  return success(res, {
    list: events.map(formatEvent),
    total,
    page: parseInt(page),
    page_size: parseInt(page_size)
  });
});

router.get('/:id', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND organizer_id = ?').get(req.params.id, req.organizer.id);
  if (!event) {
    return error(res, '活动不存在', 404);
  }
  return success(res, formatEventWithStats(event));
});

router.put('/:id', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND organizer_id = ?').get(req.params.id, req.organizer.id);
  if (!event) {
    return error(res, '活动不存在', 404);
  }

  const { title, description, location, start_time, end_time, capacity, waitlist_limit, require_approval, form_fields, status } = req.body;

  db.prepare(`
    UPDATE events SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      location = COALESCE(?, location),
      start_time = COALESCE(?, start_time),
      end_time = COALESCE(?, end_time),
      capacity = COALESCE(?, capacity),
      waitlist_limit = COALESCE(?, waitlist_limit),
      require_approval = COALESCE(?, require_approval),
      form_fields = COALESCE(?, form_fields),
      status = COALESCE(?, status),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    title,
    description,
    location,
    start_time,
    end_time,
    capacity,
    waitlist_limit,
    require_approval !== undefined ? (require_approval ? 1 : 0) : null,
    form_fields ? stringifyJson(form_fields) : null,
    status,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  writeAuditLog(event.id, null, 'event_updated', req.body);

  return success(res, formatEvent(updated), '活动已更新');
});

router.delete('/:id', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND organizer_id = ?').get(req.params.id, req.organizer.id);
  if (!event) {
    return error(res, '活动不存在', 404);
  }

  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  writeAuditLog(event.id, null, 'event_deleted', null);

  return success(res, null, '活动已删除');
});

function formatEvent(event) {
  return {
    ...event,
    require_approval: !!event.require_approval,
    form_fields: parseJson(event.form_fields)
  };
}

function formatEventWithStats(event) {
  const approvedCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'approved'").get(event.id).count;
  const waitlistCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND status = 'waitlist'").get(event.id).count;
  const checkedInCount = db.prepare("SELECT COUNT(*) as count FROM registrations WHERE event_id = ? AND checkin_status = 'checked_in'").get(event.id).count;

  return {
    ...formatEvent(event),
    stats: {
      capacity: event.capacity,
      approved_count: approvedCount,
      waitlist_count: waitlistCount,
      checked_in_count: checkedInCount,
      remaining_spots: Math.max(0, event.capacity - approvedCount)
    }
  };
}

module.exports = router;
