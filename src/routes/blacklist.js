const express = require('express');
const db = require('../models/db');
const { authRequired } = require('../middleware/auth');
const { success, error } = require('../utils/response');
const { writeAuditLog } = require('../utils/callback');

const router = express.Router();
router.use(authRequired);

router.get('/', (req, res) => {
  const { page = 1, page_size = 50, keyword } = req.query;
  const offset = (page - 1) * page_size;

  let whereClause = 'WHERE organizer_id = ?';
  const params = [req.organizer.id];

  if (keyword) {
    whereClause += ' AND (user_identifier LIKE ? OR reason LIKE ?)';
    const kw = `%${keyword}%`;
    params.push(kw, kw);
  }

  const list = db.prepare(`SELECT * FROM blacklist ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(
    ...params, parseInt(page_size), offset
  );
  const total = db.prepare(`SELECT COUNT(*) as count FROM blacklist ${whereClause}`).get(...params).count;

  return success(res, { list, total, page: parseInt(page), page_size: parseInt(page_size) });
});

router.post('/', (req, res) => {
  const { user_identifier, reason } = req.body;
  if (!user_identifier) {
    return error(res, '用户标识为必填项');
  }

  try {
    const result = db.prepare(`INSERT INTO blacklist (organizer_id, user_identifier, reason) VALUES (?, ?, ?)`).run(
      req.organizer.id, user_identifier, reason || null
    );
    writeAuditLog(null, null, 'blacklist_added', { user_identifier, reason });
    return success(res, { id: result.lastInsertRowid }, '已加入黑名单');
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return error(res, '该用户已在黑名单中');
    }
    return error(res, err.message);
  }
});

router.delete('/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM blacklist WHERE id = ? AND organizer_id = ?').get(req.params.id, req.organizer.id);
  if (!item) {
    return error(res, '记录不存在', 404);
  }

  db.prepare('DELETE FROM blacklist WHERE id = ?').run(req.params.id);
  writeAuditLog(null, null, 'blacklist_removed', { user_identifier: item.user_identifier });
  return success(res, null, '已从黑名单移除');
});

router.get('/check/:user_identifier', (req, res) => {
  const item = db.prepare('SELECT * FROM blacklist WHERE organizer_id = ? AND user_identifier = ?').get(
    req.organizer.id, req.params.user_identifier
  );
  return success(res, { in_blacklist: !!item, reason: item?.reason || null });
});

module.exports = router;
