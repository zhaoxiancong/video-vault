'use strict';
/**
 * 请求参数校验 —— 一小段手写的 schema，替代 zod。
 *
 * 为什么需要它：重构前所有校验都是散在各处的 if，风格不一，而且**漏了就漏了**。
 * 最典型的是设置接口：`setSettings()` 只接受已知键，但**静默忽略**未知键 ——
 * 前端拼错一个字段名，用户看到"已保存 ✓"，实际上什么都没存。
 *
 * 这个模块的约定：**校验失败一定给出"哪个字段、期望什么、实际什么"**，
 * 而不是一句笼统的"参数错误"。
 */

const { ValidationError } = require('../domain/errors');

/** 一个字段的规则描述 */
function field(name, opts = {}) {
  return { name, ...opts };
}

function fail(name, reason, hint) {
  throw new ValidationError(`参数「${name}」${reason}`, { hint });
}

/** 校验单个字段，返回"清洗后"的值 */
function checkOne(f, raw, { allowUndefined = true } = {}) {
  const present = raw !== undefined && raw !== null;

  if (!present) {
    if (f.required) fail(f.name, '是必填的', f.hint || '');
    if (!allowUndefined) fail(f.name, '必须有值', f.hint || '');
    return undefined;
  }

  let v = raw;

  switch (f.type) {
    case 'string': {
      if (typeof v !== 'string') {
        // 数字/布尔可以让一步转成字符串（前端表单经常给 number），对象不行
        if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
        else fail(f.name, '必须是文本', f.hint || '');
      }
      v = f.trim === false ? v : v.trim();
      if (f.required && !v) fail(f.name, '不能为空', f.hint || '');
      if (f.maxLength && v.length > f.maxLength) {
        fail(f.name, `长度不能超过 ${f.maxLength}`, f.hint || '');
      }
      if (f.enum && !f.enum.includes(v)) {
        fail(f.name, `只能是 ${f.enum.join(' / ')} 之一`, `你给的是「${v}」`);
      }
      if (f.pattern && v && !f.pattern.test(v)) {
        fail(f.name, '格式不对', f.hint || '');
      }
      return v;
    }

    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).trim());
      if (!Number.isFinite(n)) fail(f.name, '必须是数字', `你给的是「${v}」`);
      if (f.integer && !Number.isInteger(n)) fail(f.name, '必须是整数', `你给的是 ${n}`);
      if (f.min !== undefined && n < f.min) fail(f.name, `不能小于 ${f.min}`, f.hint || '');
      if (f.max !== undefined && n > f.max) fail(f.name, `不能大于 ${f.max}`, f.hint || '');
      return n;
    }

    case 'boolean': {
      if (typeof v === 'boolean') return v;
      // 表单/JSON 里常见 "true"/"1"/1 —— 都接受，但别的字符串一律拒绝，
      // 因为 Boolean("false") === true 是个经典陷阱
      if (v === 'true' || v === 1 || v === '1') return true;
      if (v === 'false' || v === 0 || v === '0') return false;
      fail(f.name, '必须是 true 或 false', `你给的是「${v}」`);
      return undefined;
    }

    case 'array': {
      if (!Array.isArray(v)) fail(f.name, '必须是数组', f.hint || '');
      if (f.maxItems && v.length > f.maxItems) {
        fail(f.name, `最多 ${f.maxItems} 项`, f.hint || '');
      }
      return v;
    }

    default:
      return v;
  }
}

/**
 * 按 schema 校验一个对象。
 *
 * @param {object} raw
 * @param {object} schema {fieldName: rule}
 * @param {object} [opts]
 * @param {boolean} [opts.strict] 出现 schema 外的键就报错（默认忽略，兼容前端多发字段）
 * @returns {object} 只含 schema 里声明过的键
 */
function validate(raw, schema, { strict = false } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  if (strict) {
    const extra = Object.keys(src).filter((k) => !(k in schema));
    if (extra.length) {
      throw new ValidationError(`不认识的参数：${extra.join(', ')}`, {
        hint: `这个接口接受：${Object.keys(schema).join(', ')}`,
      });
    }
  }

  const out = {};
  for (const [name, rule] of Object.entries(schema)) {
    const v = checkOne({ name, ...rule }, src[name]);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** 常用规则速记，让路由表读起来短一些 */
const R = {
  /** 非空短文本 */
  text: (hint) => ({ type: 'string', required: true, maxLength: 500, hint }),
  /** 可选文本 */
  optText: (hint) => ({ type: 'string', maxLength: 500, hint }),
  /** 正整数 */
  int: (min, max, hint) => ({ type: 'number', integer: true, min, max, hint }),
  bool: () => ({ type: 'boolean' }),
  /** 从固定集合里选 */
  oneOf: (values, hint) => ({ type: 'string', enum: values, hint }),
  /** http(s) 链接 */
  url: () => ({
    type: 'string', required: true, maxLength: 2000,
    pattern: /^https?:\/\/\S+$/i,
    hint: '需要以 http:// 或 https:// 开头的完整地址',
  }),
};

module.exports = { validate, field, R, checkOne };
