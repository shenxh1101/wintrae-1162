const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../models/db');
const config = require('../config');
const { success, error } = require('../utils/response');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return error(res, '用户名和密码不能为空');
  }

  const organizer = db.prepare('SELECT * FROM organizers WHERE username = ?').get(username);
  if (!organizer) {
    return error(res, '用户名或密码错误', 401);
  }

  if (!bcrypt.compareSync(password, organizer.password)) {
    return error(res, '用户名或密码错误', 401);
  }

  const token = jwt.sign(
    { id: organizer.id, username: organizer.username, name: organizer.name },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  return success(res, {
    token,
    organizer: {
      id: organizer.id,
      username: organizer.username,
      name: organizer.name,
      callback_url: organizer.callback_url
    }
  }, '登录成功');
});

router.post('/register', (req, res) => {
  const { username, password, name, callback_url } = req.body;
  if (!username || !password || !name) {
    return error(res, '用户名、密码和名称不能为空');
  }

  const exists = db.prepare('SELECT id FROM organizers WHERE username = ?').get(username);
  if (exists) {
    return error(res, '用户名已存在');
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(`INSERT INTO organizers (username, password, name, callback_url) VALUES (?, ?, ?, ?)`).run(
    username, hash, name, callback_url || null
  );

  return success(res, { id: result.lastInsertRowid }, '注册成功');
});

router.post('/callback', require('../middleware/auth').authRequired, (req, res) => {
  const { callback_url } = req.body;
  db.prepare('UPDATE organizers SET callback_url = ? WHERE id = ?').run(
    callback_url || null, req.organizer.id
  );
  return success(res, null, '回调地址已更新');
});

module.exports = router;
