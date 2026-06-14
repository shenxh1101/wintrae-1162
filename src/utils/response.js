function success(res, data = null, message = '操作成功') {
  return res.json({
    code: 0,
    message,
    data
  });
}

function error(res, message = '操作失败', statusCode = 400, data = null) {
  return res.status(statusCode).json({
    code: -1,
    message,
    data
  });
}

function parseJson(str, defaultValue = null) {
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

function stringifyJson(obj) {
  return typeof obj === 'string' ? obj : JSON.stringify(obj);
}

module.exports = { success, error, parseJson, stringifyJson };
