'use strict';
/**
 * 库查询 / 队列快照 / 引擎自检 / 库页分组 —— 基本都是只读接口。
 *
 * 分组那三个（建/改/删）是写操作，放在这里的理由：它们服务的都是"库怎么组织"，
 * 和库查询是同一件事的两半；也免得为一个概念开两个路由文件。
 */

const { json, readJsonBody } = require('../router');
const { slimHistoryRow, slimPage } = require('../views');
const { ValidationError, NotFoundError } = require('../../domain/errors');
const { validate, R } = require('../validate');

/** 允许的排序方式（写死：不接受前端传任意 SQL 片段） */
const SORTS = ['created_desc', 'created_asc', 'title_asc', 'size_desc', 'duration_desc'];

/** 分组时最多处理多少条。超了就明说 `truncated`，不假装分完了 */
const GROUP_CAP = 2000;

/**
 * 解析 `groupId` 查询参数。
 *
 * 返回 `null` 表示**不按分组筛选**；返回数字表示只看那一组。
 *
 * ⚠️ 非法值要**报错**，不能静默当成"没传"。理由：这是个筛选条件，
 *    用户明明写了 `groupId=abc`，如果悄悄忽略，他会看到"全部视频"，
 *    以为这个筛选没用或者自己点错了 —— 而真正的原因是参数根本没生效。
 *    报错至少让他知道哪里写错了。
 */
function parseGroupId(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`groupId 必须是正整数，收到的是「${raw}」`, {
      hint: 'groupId 是自定义分组的 id（正整数）。想取消这个筛选就别传这个参数。',
    });
  }
  return n;
}

function register(router, ctx) {
  const { repo, scheduler, downloader, config, migrations, dupMerged, broadcast } = ctx;

  // ---------------------------------------------------------------- 引擎自检

  router.get('/api/health', (req, res) => {
    const info = downloader.binaryInfo();
    return json(res, 200, {
      ok: info.ytdlp.ok,
      engines: info,
      // 上次没跑完的任务数：界面据此提示「上次有 N 个任务没跑完」
      queuedInterrupted: repo.countByStatus('paused') + repo.countByStatus('failed'),
      settings: repo.getSettings(),
      downloads: config.paths.downloads,
      version: require('../../../package.json').version,
      // 调度器的内存并发状态。**只读诊断**：`ghosts` 非空说明有槽位泄漏
      // （内存里占着槽位、库里却没有对应的进行中任务）—— 那会让新任务永远排队。
      scheduler: scheduler.diagnostics ? scheduler.diagnostics() : undefined,
    });
  });

  // ---------------------------------------------------------------- 队列快照

  /**
   * 队列快照 + 最近历史。
   *
   * 为什么要带历史：服务端的队列和库本来就是持久的，但如果只回活动任务，
   * 用户刷新页面就觉得"什么都没了"。把最近结束的任务一起回过去，
   * 刷新后仍能看到刚下完/失败的任务，并能直接删掉。
   */
  router.get('/api/queue', (req, res, params, url) => {
    const limit = Math.min(100, Number(url.searchParams.get('history') || 20));
    const snap = scheduler.snapshot();

    const history = repo.raw.prepare(
      `SELECT id,title,url,status,progress,kind,site,uploader,error,
              file_path,file_size,duration,height,container,finished_at,
              thumb_embed_ok
       FROM videos
       WHERE status IN ('done','failed','canceled','paused')
       ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC
       LIMIT ?`,
    ).all(limit).map(slimHistoryRow);

    const counts = repo.raw.prepare(
      `SELECT
         SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) AS paused,
         SUM(CASE WHEN status='canceled' THEN 1 ELSE 0 END) AS canceled
       FROM videos`,
    ).get();

    return json(res, 200, { ...snap, history, counts });
  });

  // ---------------------------------------------------------------- 库查询

  router.get('/api/library', (req, res, params, url) => {
    const sortRaw = url.searchParams.get('sort') || 'created_desc';
    const page = repo.listVideos({
      q: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || '',
      site: url.searchParams.get('site') || '',
      uploader: url.searchParams.get('uploader') || '',
      starred: url.searchParams.get('starred') === '1',
      // 「只看某个分组」（快捷筛选）。与 /api/library/grouped 用同一份解析，
      // 所以两个接口对非法值的处理是一致的。
      groupId: parseGroupId(url.searchParams.get('groupId')),
      // 白名单：排序字段拼进 SQL 的 ORDER BY，绝不能直接信前端
      sort: SORTS.includes(sortRaw) ? sortRaw : 'created_desc',
      limit: Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 200))),
      offset: Math.max(0, Number(url.searchParams.get('offset') || 0)),
    });
    return json(res, 200, slimPage(page));
  });

  router.get('/api/facets', (req, res) => {
    return json(res, 200, repo.facets());
  });

  /**
   * 「选中筛选下的全部」——只回 id，不回整行。
   *
   * 为什么要单独一个接口（而不是在列表响应里带一个 ids 数组）：
   *   · 只有点"全选"的那一刻才需要它，每次列表请求都带上纯属浪费；
   *   · 整行里带着 description/notes 这些大字段，而这里只需要 id；
   *   · `total` 与 `count` 可能不等（见下面的封顶），分开表达更清楚。
   *
   * ⚠️ 同样封顶 GROUP_CAP（2000）—— 不给"一次选中一万条"的口子。
   *    返回 `truncated` 让界面能如实告诉用户"只选中了前 2000 条"。
   */
  router.get('/api/library/ids', (req, res, params, url) => {
    const sp = url.searchParams;
    const sortRaw = sp.get('sort') || 'created_desc';
    const filters = {
      q: sp.get('q') || '',
      status: sp.get('status') || '',
      site: sp.get('site') || '',
      uploader: sp.get('uploader') || '',
      starred: sp.get('starred') === '1',
      groupId: parseGroupId(sp.get('groupId')),
      sort: SORTS.includes(sortRaw) ? sortRaw : 'created_desc',
    };
    const total = repo.listVideos({ ...filters, limit: 1, offset: 0 }).total;
    const rows = repo.listVideosAll(filters);
    const ids = rows.slice(0, GROUP_CAP).map((v) => v.id);
    return json(res, 200, {
      ids, total, count: ids.length, cap: GROUP_CAP, truncated: rows.length > GROUP_CAP,
    });
  });

  // ---------------------------------------------------------------- 分组后的库

  /**
   * 分组后的库。
   *
   * 为什么由服务端分组（而不是前端拿一堆 row 自己归并）：
   *   分组名后的条数必须是**全量**条数。前端分页拿到的只是当前页，
   *   自己归并出来的数字必然是"这一页里有多少条" —— 那正是要避开的坑。
   *   放服务端还让"筛选先于分组"这件事只有一个实现处。
   */
  router.get('/api/library/grouped', (req, res, params, url) => {
    const sp = url.searchParams;
    const by = sp.get('by') || 'site';
    if (by !== 'site' && by !== 'group') {
      throw new ValidationError(`分组维度只能是 site 或 group，收到的是「${by}」`, {
        hint: 'by=site 按站点分段；by=group 按自定义分组分段。',
      });
    }

    const filters = {
      q: sp.get('q') || '',
      status: sp.get('status') || '',
      site: sp.get('site') || '',
      uploader: sp.get('uploader') || '',
      starred: sp.get('starred') === '1',
      groupId: parseGroupId(sp.get('groupId')),
      sort: sp.get('sort') || 'created_desc',
    };

    const total = repo.listVideos({ ...filters, limit: 1, offset: 0 }).total;
    const all = repo.listVideosAll(filters);
    const capped = all.slice(0, GROUP_CAP);

    const groups = by === 'site'
      ? groupBySite(capped)
      : groupByCustom(capped, repo);

    return json(res, 200, {
      by,
      total,
      shown: capped.length,
      truncated: all.length > GROUP_CAP,
      cap: GROUP_CAP,
      groups,
    });
  });

  // ---------------------------------------------------------------- 分组 CRUD

  /**
   * 允许的分组颜色。**与 `styles.css` 里那 5 个 `.c-*` 类一一对应** ——
   * 后端只存 key，前端拿 key 拼类名。加了这里就必须同步加样式，
   * 否则分组颜色会静默变成灰色（`check-classes.js` 对 `c-` 前缀放行，
   * 抓不到这种"后端能存但样式没有"的组合）。
   */
  const GROUP_COLORS = ['amber', 'blue', 'green', 'purple', 'red'];

  /**
   * 保留分组名。「未分组」是 `by=group` 下**合成出来的那一段**的名字 ——
   * 如果允许用户建一个真的叫「未分组」的分组，界面上会同时出现两个同名段
   * （一个是他的、一个是合成的），肉眼分不清哪个是哪个。
   */
  const RESERVED_GROUP_NAMES = ['未分组'];

  function assertGroupNameAllowed(name) {
    const clean = String(name == null ? '' : name).trim();
    if (RESERVED_GROUP_NAMES.includes(clean)) {
      throw new ValidationError(`「${clean}」是系统保留的名字`, {
        hint: '它是"按分组分段"时自动生成的那一段的名字，换一个吧。',
      });
    }
  }

  router.get('/api/groups', (req, res) => {
    return json(res, 200, { groups: repo.listGroups() });
  });

  router.post('/api/groups', async (req, res) => {
    const body = await readJsonBody(req);
    const { name, color } = validate(body, {
      name: { type: 'string', required: true, maxLength: 40, hint: '分组名不能为空' },
      color: R.oneOf(GROUP_COLORS, `颜色可选：${GROUP_COLORS.join(' / ')}`),
    });
    assertGroupNameAllowed(name);
    const out = repo.createGroup({ name, color: color || GROUP_COLORS[0] });
    broadcast('library', { changed: true });
    return json(res, 200, out);
  });

  router.patch('/api/groups/:id', async (req, res, p) => {
    const body = await readJsonBody(req);
    /**
     * ⚠️ 这里用 `checkOne` 逐字段处理，是因为**两个字段都是可选的**，
     *    而 `validate` 对"传了但为 null"的处理是走类型校验 → `String(null)` 会
     *    把名字变成字面量 "null"。所以显式判 `!= null`：
     *    只有**真的给了值**才改，给 null/undefined 一律视为"不改这个字段"。
     */
    const patch = {};
    if (body && body.name != null) {
      const name = String(body.name).trim();
      if (!name) throw new ValidationError('分组名不能为空', { hint: '给它起个名字。' });
      if (name.length > 40) throw new ValidationError('分组名太长了（最多 40 个字符）');
      assertGroupNameAllowed(name);
      patch.name = name;
    }
    if (body && body.color != null) {
      const color = String(body.color);
      if (!GROUP_COLORS.includes(color)) {
        throw new ValidationError(`不认得的颜色：${color}`, {
          hint: `颜色可选：${GROUP_COLORS.join(' / ')}`,
        });
      }
      patch.color = color;
    }
    const out = repo.updateGroup(Number(p.id), patch);
    if (!out) throw new NotFoundError('找不到这个分组', { hint: '它可能已经被删了，刷新一下。' });
    broadcast('library', { changed: true });
    return json(res, 200, out);
  });

  router.delete('/api/groups/:id', (req, res, p, url) => {
    const mode = url.searchParams.get('mode') || 'detach';
    if (mode !== 'detach' && mode !== 'purge') {
      throw new ValidationError('mode 只能是 detach 或 purge', {
        hint: 'detach = 只解散分组（默认）；purge = 连库记录一起删（磁盘文件保留）。',
      });
    }
    const out = repo.deleteGroup(Number(p.id), { mode });
    if (!out) throw new NotFoundError('找不到这个分组');
    broadcast('library', { changed: true });
    return json(res, 200, out);
  });

  /** 启动时做过哪些迁移 —— 界面/日志里能回看，排错时有用 */
  router.get('/api/migrations', (req, res) => {
    const out = { ...(migrations || {}) };
    if (dupMerged && dupMerged.length) out.duplicatesMerged = dupMerged;
    return json(res, 200, out);
  });
}

/**
 * 按站点分段。
 *
 * ⚠️ 站点名按**大小写不敏感**归并（Review Focus 1）：yt-dlp 不同版本、不同来源
 *    给出的站点名大小写并不统一（Youtube / youtube / YOUTUBE）。不归并的话
 *    同一个站点会裂成好几段，看起来就像 bug。
 *    显示名取**第一次出现的那个写法** —— 保持它原本的样子，不擅自改成别的。
 *
 * 站点为空的记录归入「未标注站点」，**不是丢掉** —— 丢数据比分组难看严重得多。
 */
function groupBySite(rows) {
  const buckets = new Map();   // 归并键（小写）→ {name, rows}
  for (const r of rows) {
    const raw = (r.site && String(r.site).trim()) || '（未标注站点）';
    const key = raw.toLowerCase();
    if (!buckets.has(key)) buckets.set(key, { name: raw, rows: [] });
    buckets.get(key).rows.push(r);
  }
  return [...buckets.values()]
    .map((b) => ({ key: b.name, id: null, name: b.name, color: null, count: b.rows.length, rows: b.rows }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * 按自定义分组分段。
 *
 * 顺序：先自定义分组（按创建顺序，**含 0 条的**），最后才是「未分组」，
 * 且仅当确实有未分组的条目时才加这一段（没有就不造一个空段）。
 *
 * 一个视频可以同时出现在多个段里 —— 这是 spec 定下的多对多语义。
 */
function groupByCustom(rows, repo) {
  const groups = repo.listGroups().map((g) => ({
    key: String(g.id), id: g.id, name: g.name, color: g.color, count: 0, rows: [],
  }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const membership = repo.groupIdsFor(rows.map((r) => r.id));

  const ungrouped = [];
  for (const row of rows) {
    const ids = membership.get(row.id) || [];
    if (!ids.length) { ungrouped.push(row); continue; }
    for (const gid of ids) {
      const g = byId.get(gid);
      if (g) { g.rows.push(row); g.count += 1; }
    }
  }

  if (ungrouped.length) {
    groups.push({
      key: '__ungrouped__', id: null, name: '未分组', color: null,
      count: ungrouped.length, rows: ungrouped,
    });
  }
  return groups;
}

module.exports = { register, SORTS, groupBySite, groupByCustom };
