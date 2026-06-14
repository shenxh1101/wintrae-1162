const fs = require('fs');
const path = require('path');
const config = require('../config');

const dbPath = config.database.path;
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const DEFAULT_DATA = {
  tables: {
    organizers: [],
    events: [],
    registrations: [],
    blacklist: [],
    audit_logs: []
  },
  sequences: {
    organizers: 0,
    events: 0,
    registrations: 0,
    blacklist: 0,
    audit_logs: 0
  }
};

let data = loadData();

function loadData() {
  if (fs.existsSync(dbPath)) {
    try {
      const content = fs.readFileSync(dbPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return deepClone(DEFAULT_DATA);
    }
  }
  return deepClone(DEFAULT_DATA);
}

let saveTimer = null;
function saveData() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[DB] Save failed:', err.message);
    }
  }, 50);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function now() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

class Statement {
  constructor(sql) {
    this.sql = sql.trim();
  }

  parseInsert() {
    const match = this.sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (!match) return null;
    const table = match[1];
    const columns = match[2].split(',').map(s => s.trim());
    const placeholders = match[3].split(',').map(s => s.trim());
    return { table, columns, placeholders };
  }

  parseSelect() {
    const lower = this.sql.toLowerCase();
    const tableMatch = this.sql.match(/FROM\s+(\w+)/i);
    if (!tableMatch) return null;
    const table = tableMatch[1];

    let whereClause = null;
    const whereMatch = this.sql.match(/WHERE\s+(.+?)(ORDER|LIMIT|OFFSET|$)/is);
    if (whereMatch) {
      whereClause = whereMatch[1].trim();
    }

    let limit = null;
    const limitMatch = this.sql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) limit = parseInt(limitMatch[1]);

    let offset = 0;
    const offsetMatch = this.sql.match(/OFFSET\s+(\d+)/i);
    if (offsetMatch) offset = parseInt(offsetMatch[1]);

    let orderBy = null;
    const orderMatch = this.sql.match(/ORDER\s+BY\s+(.+?)(LIMIT|OFFSET|$)/is);
    if (orderMatch) {
      orderBy = orderMatch[1].trim();
    }

    const selectAll = lower.includes('count(*)') || lower.includes('select *');
    const isCount = lower.includes('count(*)');

    return { table, whereClause, limit, offset, orderBy, isCount, selectAll };
  }

  parseUpdate() {
    const match = this.sql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)(WHERE|$)/is);
    if (!match) return null;
    const table = match[1];
    const setClause = match[2].trim();
    const whereMatch = this.sql.match(/WHERE\s+(.+)$/is);
    return {
      table,
      setClause,
      whereClause: whereMatch ? whereMatch[1].trim() : null
    };
  }

  parseDelete() {
    const match = this.sql.match(/DELETE\s+FROM\s+(\w+)(\s+WHERE\s+(.+))?$/is);
    if (!match) return null;
    return {
      table: match[1],
      whereClause: match[3] || null
    };
  }

  evalCondition(row, condition, params) {
    if (!condition) return true;

    const andParts = this.splitByTopLevelOp(condition, 'AND');
    return andParts.every(part => this.evalOrExpr(row, part, params));
  }

  splitByTopLevelOp(condition, op) {
    const result = [];
    let depth = 0;
    let current = '';
    const tokens = condition.split(/\s+/);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.toUpperCase() === op && depth === 0 && current.trim()) {
        result.push(current.trim());
        current = '';
      } else {
        if (token.includes('(')) depth += (token.match(/\(/g) || []).length;
        if (token.includes(')')) depth -= (token.match(/\)/g) || []).length;
        current += (current ? ' ' : '') + token;
      }
    }
    if (current.trim()) result.push(current.trim());
    return result;
  }

  evalOrExpr(row, expr, params) {
    expr = expr.trim();
    if (expr.startsWith('(') && expr.endsWith(')')) {
      let depth = 0;
      let balanced = true;
      for (const ch of expr) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (depth < 0) { balanced = false; break; }
      }
      if (balanced && depth === 0) {
        expr = expr.substring(1, expr.length - 1).trim();
      }
    }

    const orParts = this.splitByTopLevelOp(expr, 'OR');
    if (orParts.length === 1) {
      return this.evalSingleCondition(row, orParts[0].trim(), params);
    }
    return orParts.some(part => this.evalSingleCondition(row, part.trim(), params));
  }

  splitConditions(condition) {
    return this.splitByTopLevelOp(condition, 'AND');
  }

  evalSingleCondition(row, condition, params) {
    condition = condition.replace(/\s+/g, ' ').trim();

    const stripAlias = (col) => {
      const dot = col.indexOf('.');
      return dot >= 0 ? col.substring(dot + 1) : col;
    };

    if (condition.toUpperCase().includes(' IS NULL')) {
      const col = stripAlias(condition.split(/\s+/i)[0]);
      return row[col] === null || row[col] === undefined;
    }
    if (condition.toUpperCase().includes(' IS NOT NULL')) {
      const col = stripAlias(condition.split(/\s+/i)[0]);
      return row[col] !== null && row[col] !== undefined;
    }

    const likeMatch = condition.match(/([\w.]+)\s+LIKE\s+(.+)/i);
    if (likeMatch) {
      const col = stripAlias(likeMatch[1]);
      let val = likeMatch[2].trim();
      if (val === '?') val = params.shift();
      val = val.replace(/^['"]|['"]$/g, '').replace(/%/g, '.*');
      return new RegExp(val).test(String(row[col] || ''));
    }

    const eqMatch = condition.match(/([\w.]+)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)/i);
    if (eqMatch) {
      const col = stripAlias(eqMatch[1]);
      const op = eqMatch[2];
      let val = eqMatch[3].trim();
      if (val === '?') val = params.shift();
      else val = val.replace(/^['"]|['"]$/g, '');
      if (val === 'null' || val === 'NULL') val = null;
      if (!isNaN(val) && val !== '' && val !== null) val = Number(val);

      const rowVal = row[col];
      switch (op) {
        case '=': return rowVal == val;
        case '!=': case '<>': return rowVal != val;
        case '>': return rowVal > val;
        case '>=': return rowVal >= val;
        case '<': return rowVal < val;
        case '<=': return rowVal <= val;
      }
    }
    return true;
  }

  all(...args) {
    const parsed = this.parseSelect();
    if (!parsed) return [];

    const params = this.flattenParams(args);
    let rows = deepClone(data.tables[parsed.table] || []);

    rows = rows.filter(row => {
      const rowParams = [...params];
      return this.evalCondition(row, parsed.whereClause, rowParams);
    });

    if (parsed.orderBy) {
      const orders = parsed.orderBy.split(',').map(o => o.trim());
      rows.sort((a, b) => {
        for (const order of orders) {
          const parts = order.split(/\s+/);
          const col = parts[0];
          const dir = (parts[1] || 'ASC').toUpperCase();
          let va = a[col];
          let vb = b[col];
          if (va === null || va === undefined) va = '';
          if (vb === null || vb === undefined) vb = '';
          if (va === '' && vb !== '') return dir === 'ASC' ? 1 : -1;
          if (vb === '' && va !== '') return dir === 'ASC' ? -1 : 1;
          let cmp = 0;
          if (!isNaN(va) && !isNaN(vb)) cmp = Number(va) - Number(vb);
          else cmp = String(va).localeCompare(String(vb));
          if (cmp !== 0) return dir === 'ASC' ? cmp : -cmp;
        }
        return 0;
      });
    }

    if (parsed.offset) rows = rows.slice(parsed.offset);
    if (parsed.limit !== null) rows = rows.slice(0, parsed.limit);

    if (parsed.isCount) {
      return [{ count: rows.length }];
    }

    return rows;
  }

  get(...args) {
    const result = this.all(...args);
    return result[0] || undefined;
  }

  run(...args) {
    const params = this.flattenParams(args);
    const insert = this.parseInsert();
    if (insert) {
      const row = {};
      const p = [...params];
      let hasIdCol = false;
      insert.columns.forEach((col, i) => {
        let val = p[i];
        if (insert.placeholders[i].toUpperCase() === 'CURRENT_TIMESTAMP') {
          val = now();
        }
        if (col === 'id') {
          hasIdCol = true;
          data.sequences[insert.table] = (data.sequences[insert.table] || 0) + 1;
          val = data.sequences[insert.table];
        }
        row[col] = val;
      });
      if (!hasIdCol) {
        data.sequences[insert.table] = (data.sequences[insert.table] || 0) + 1;
        row.id = data.sequences[insert.table];
      }
      const colNames = insert.columns.map(c => c.toLowerCase());
      if (!colNames.includes('created_at')) {
        row.created_at = now();
      }
      if (!colNames.includes('updated_at')) {
        row.updated_at = now();
      }
      data.tables[insert.table].push(row);
      saveData();
      return { changes: 1, lastInsertRowid: row.id };
    }

    const update = this.parseUpdate();
    if (update) {
      const paramsCopy = [...params];
      const sets = this.parseSetClause(update.setClause, paramsCopy);
      const affectedRows = data.tables[update.table].filter(row => {
        const wp = [...paramsCopy];
        return this.evalCondition(row, update.whereClause, wp);
      });
      affectedRows.forEach(row => {
        Object.entries(sets).forEach(([col, val]) => {
          if (val === 'CURRENT_TIMESTAMP') {
            row[col] = now();
          } else if (val && typeof val === 'object' && val._useOld) {
            row[col] = row[col];
          } else {
            row[col] = val;
          }
        });
        if (row.hasOwnProperty('updated_at')) {
          row.updated_at = now();
        }
      });
      saveData();
      return { changes: affectedRows.length };
    }

    const del = this.parseDelete();
    if (del) {
      const paramsCopy = [...params];
      const before = data.tables[del.table].length;
      data.tables[del.table] = data.tables[del.table].filter(row => {
        const wp = [...paramsCopy];
        return !this.evalCondition(row, del.whereClause, wp);
      });
      const changes = before - data.tables[del.table].length;
      saveData();
      return { changes };
    }

    return { changes: 0 };
  }

  parseSetClause(clause, params) {
    const result = {};
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of clause) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        if (current.trim()) parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());

    for (const part of parts) {
      const eqIdx = part.indexOf('=');
      if (eqIdx < 0) continue;
      let col = part.substring(0, eqIdx).trim();
      let val = part.substring(eqIdx + 1).trim();

      const coalesceMatch = val.match(/COALESCE\s*\((.+)\)/i);
      if (coalesceMatch) {
        const args = [];
        let aDepth = 0;
        let aCurrent = '';
        for (const ch of coalesceMatch[1]) {
          if (ch === '(') aDepth++;
          if (ch === ')') aDepth--;
          if (ch === ',' && aDepth === 0) {
            if (aCurrent.trim()) args.push(aCurrent.trim());
            aCurrent = '';
          } else {
            aCurrent += ch;
          }
        }
        if (aCurrent.trim()) args.push(aCurrent.trim());

        if (args[0] === '?') {
          const p = params.shift();
          result[col] = p !== undefined && p !== null ? p : { _useOld: true };
        } else if (args[0].toLowerCase() === col) {
          const second = args[1];
          if (second === '?') {
            const p = params.shift();
            result[col] = p !== undefined && p !== null ? p : { _useOld: true };
          } else {
            let v = second.replace(/^['"]|['"]$/g, '');
            if (v === 'CURRENT_TIMESTAMP') v = now();
            result[col] = { _useOld: true };
          }
        }
        continue;
      }

      if (val === '?') {
        result[col] = params.shift();
      } else if (val.toUpperCase() === 'CURRENT_TIMESTAMP') {
        result[col] = now();
      } else if (val.toUpperCase() === 'NULL') {
        result[col] = null;
      } else {
        val = val.replace(/^['"]|['"]$/g, '');
        if (!isNaN(val) && val !== '') result[col] = Number(val);
        else result[col] = val;
      }
    }
    return result;
  }

  flattenParams(args) {
    const result = [];
    for (const a of args) {
      if (Array.isArray(a)) result.push(...a);
      else result.push(a);
    }
    return result;
  }
}

const db = {
  prepare(sql) {
    return new Statement(sql);
  },
  exec(sql) {
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      if (stmt.match(/^CREATE\s+TABLE/i)) continue;
      new Statement(stmt).run();
    }
  },
  transaction(fn) {
    return function(...args) {
      return fn(...args);
    };
  },
  pragma() {}
};

function initDatabase() {
  if (!data.tables.organizers) data.tables.organizers = [];
  if (!data.tables.events) data.tables.events = [];
  if (!data.tables.registrations) data.tables.registrations = [];
  if (!data.tables.blacklist) data.tables.blacklist = [];
  if (!data.tables.audit_logs) data.tables.audit_logs = [];
  if (!data.sequences) data.sequences = {};

  if (data.tables.organizers.length === 0) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('admin123', 10);
    data.sequences.organizers = 1;
    data.tables.organizers.push({
      id: 1,
      username: 'admin',
      password: hash,
      name: '默认管理员',
      callback_url: null,
      created_at: now()
    });
    saveData();
  }
}

initDatabase();

module.exports = db;
