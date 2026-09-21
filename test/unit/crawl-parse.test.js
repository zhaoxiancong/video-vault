'use strict';
/**
 * 抓取解析层测试 —— 对着**真实页面夹具**跑，不联网。
 *
 * 夹具 `test/fixtures/listing-xvideos.html` 是从 https://www.xvideos.com/ 裁下来的
 * 3 个真实视频块（5.3 KB），`paging-xvideos.html` 是真实的翻页片段。
 *
 * ⚠️ 为什么不用手写 HTML：手写的假 HTML 会不自觉地迎合自己的解析代码 ——
 *    测试永远绿，上线拿到真页面就空。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  slugToTitle, parseDurationText, extractItems, extractPaging, filterCandidates, sameVideo,
} = require('../../src/app/crawl-parse');

const FIX = path.join(__dirname, '..', 'fixtures');
const LISTING = fs.readFileSync(path.join(FIX, 'listing-xvideos.html'), 'utf8');
const PAGING = fs.readFileSync(path.join(FIX, 'paging-xvideos.html'), 'utf8');
const BASE = 'https://www.xvideos.com/';

// ---------------------------------------------------------------- slug / 时长

test('slugToTitle 把下划线还原成空格并合并连续空白', () => {
  assert.equal(slugToTitle('sayoko_machimura_blowjob'), 'sayoko machimura blowjob');
  assert.equal(slugToTitle('a__b___c'), 'a b c');
  assert.equal(slugToTitle(''), '');
  assert.equal(slugToTitle(null), '');
});

test('parseDurationText 认多种写法，认不出返回 null（不是 0）', () => {
  assert.equal(parseDurationText('13分钟'), 780);
  assert.equal(parseDurationText('1分钟'), 60);
  assert.equal(parseDurationText('11 min'), 660);
  assert.equal(parseDurationText('1:05:00'), 3900);
  assert.equal(parseDurationText('13:05'), 785);
  assert.equal(parseDurationText('2 小时 5 分'), 7500);
  // Review Focus 3：认不出必须是 null，不能是 0 —— 0 会被当成"零秒视频"
  assert.equal(parseDurationText(''), null);
  assert.equal(parseDurationText(null), null);
  assert.equal(parseDurationText('未知'), null);
});

// ---------------------------------------------------------------- extractItems

test('extractItems 从真实夹具里抠出条目，字段齐全', () => {
  const items = extractItems(LISTING, BASE);
  assert.equal(items.length, 3, '夹具里有 3 个视频块');

  const first = items[0];
  // Review Focus 1：相对路径必须解析成绝对 URL
  assert.match(first.url, /^https:\/\/www\.xvideos\.com\/video\./);
  assert.ok(first.title.length > 0, '标题不能为空');
  assert.ok(!first.title.includes('_'), '标题里的下划线要还原成空格');
  assert.equal(typeof first.duration_sec, 'number');
  assert.ok(first.duration_sec > 0);
  assert.match(first.site_video_id, /^\d+$/, 'data-videoid 要抓下来');
  assert.match(first.thumb_url, /^https?:\/\//, '缩略图要是绝对 URL');
});

test('extractItems 三条的 url / title / videoid 互不相同', () => {
  const items = extractItems(LISTING, BASE);
  assert.equal(new Set(items.map((i) => i.url)).size, 3);
  assert.equal(new Set(items.map((i) => i.title)).size, 3);
  assert.equal(new Set(items.map((i) => i.site_video_id)).size, 3);
});

/**
 * ⚠️ 这条测试是补写的，起因是发现自己原来的测试**咬不住 bug**：
 * 第一个视频的"预览时长"和"真时长"恰好都是 7 分钟，取错也看不出来；
 * 第二个视频才是 13 vs 7。所以这里对每条都独立验证"取到的是自己块里那一份"。
 */
test('每条候选的时长来自它自己的块（不是邻居的、也不是预览时长）', () => {
  const items = extractItems(LISTING, BASE);

  // 按解析器同样的方式切块。
  // ⚠️ 必须**按 URL 去重**：同一个视频在页面里有两个 <a>（缩略图一个、标题一个），
  //    按出现顺序切块会把同一个视频切两遍 —— 第一版就是这么写错的。
  const blocks = [];
  const seenUrl = new Set();
  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = linkRe.exec(LISTING)) !== null && blocks.length < 3) {
    const href = m[1];
    if (!/\/video[./_-]/i.test(href)) continue;
    if (seenUrl.has(href)) continue;
    seenUrl.add(href);
    const back = LISTING.lastIndexOf('<div', m.index);
    const start = back >= 0 && m.index - back < 2000 ? back : m.index;
    const scriptEnd = LISTING.indexOf('</script>', m.index);
    blocks.push(LISTING.slice(start, scriptEnd >= 0 ? scriptEnd : m.index + 6000));
  }
  assert.equal(blocks.length, 3, '应能切出 3 个不同视频的块');

  items.forEach((it, i) => {
    const durs = [...blocks[i].matchAll(/class="[^"]*duration[^"]*"[^>]*>([^<]+)</gi)].map((x) => x[1].trim());
    assert.ok(durs.length > 0, `第 ${i + 1} 条所在块应有 .duration`);
    const want = parseDurationText(durs[durs.length - 1]);   // 最后一个才是真时长
    assert.equal(it.duration_sec, want,
      `第 ${i + 1} 条的时长应为块内最后一个 duration（${durs[durs.length - 1]}），实际 ${it.duration_sec}`);
    assert.ok(it.duration_sec > 0);
  });

  // 第一条（预览 7 分钟 / 真时长 13 分钟）用来证明"取最后一个"是有效的
  assert.equal(items[0].duration_sec, 780, '第一条的真时长是 13 分钟；取到 420 说明取成了预览时长');
});

/**
 * ⚠️ 手工构造的边界用例（**不是从真实页面裁的**，所以它不受页面改版影响）：
 * 相邻两个视频块，时长故意不同 —— 钉住"解析第二条时不能把第三条的时长算进来"。
 * 实测每个块以 `<script>…</script>` 收尾，解析器就靠它划分边界。
 */
test('块边界：相邻视频不串时长（第三条的时长不能被算到第二条头上）', () => {
  const mk = (id, slug, dur) =>
    `<div id="video_${id}" class="thumb-block"><div class="thumb"><a href="/video.${id}/1/1/${slug}">`
    + `<img data-src="https://cdn.example/${id}.jpg"></a></div>`
    + `<div class="thumb-under"><p class="title"><a href="/video.${id}/1/1/${slug}" title="T ${id}">`
    + `T ${id} <span class="duration">${dur}</span></a></p></div>`
    + `<script>xv.thumbs.prepareVideo('${id}');</script></div>`;

  const html = mk('aaa', 'first', '2分钟') + mk('bbb', 'second', '10分钟') + mk('ccc', 'third', '45分钟');
  const items = extractItems(html, BASE);

  assert.equal(items.length, 3);
  assert.equal(items[0].duration_sec, 120, '第一条必须是 2 分钟');
  assert.equal(items[1].duration_sec, 600, '第二条必须是 10 分钟（不能拿到第三条的 45 分钟）');
  assert.equal(items[2].duration_sec, 2700, '第三条必须是 45 分钟');
  assert.equal(items[0].title, 'T aaa', '标题来自 title 属性');
});

test('extractItems 的时长缺失时是 null，不是 0', () => {
  const html = '<div class="thumb-block"><a href="/video.aaa/1/1/x">'
    + '<img data-src="https://cdn.example/t.jpg"></a></div>';
  const items = extractItems(html, BASE);
  assert.equal(items.length, 1);
  assert.equal(items[0].duration_sec, null);
  assert.equal(items[0].thumb_url, 'https://cdn.example/t.jpg');
});

test('extractItems 对同一页内重复的视频只算一条', () => {
  const block = '<div class="thumb-block"><a href="/video.aaa/1/1/same">'
    + '<span class="duration">5分钟</span></a></div>';
  const items = extractItems(block + block, BASE);
  assert.equal(items.length, 1, '同一条出现两次只保留一条');
});

test('extractItems 忽略不像视频的链接', () => {
  const html = '<a href="/new/2">下一页</a><a href="/tags/abc">标签</a>'
    + '<a href="/video.bbb/2/2/real"><span class="duration">2分钟</span></a>';
  const items = extractItems(html, BASE);
  assert.equal(items.length, 1);
  assert.match(items[0].url, /video\.bbb/);
});

test('extractItems 跳过 # / javascript: 这类无效 href', () => {
  const html = '<a href="#">x</a><a href="javascript:void(0)">y</a>'
    + '<a href="/video.ccc/3/3/ok"><span class="duration">1分钟</span></a>';
  assert.equal(extractItems(html, BASE).length, 1);
});

test('extractItems 遵守 limit', () => {
  const one = '<a href="/video.x{i}/1/1/t{i}"><span class="duration">1分钟</span></a>';
  const html = Array.from({ length: 10 }, (_, i) => one.replace(/\{i\}/g, i)).join('');
  assert.equal(extractItems(html, BASE, { limit: 4 }).length, 4);
});

test('extractItems 对空/垃圾输入不抛异常', () => {
  assert.deepEqual(extractItems('', BASE), []);
  assert.deepEqual(extractItems(null, BASE), []);
  assert.deepEqual(extractItems('<html></html>', BASE), []);
});

// ---------------------------------------------------------------- extractPaging

test('extractPaging 从真实翻页片段里列出候选页', () => {
  const paging = extractPaging(PAGING, BASE);
  assert.ok(paging.length >= 5, `应至少列出 5 个候选页，实际 ${paging.length}`);
  assert.match(paging[0].url, /^https:\/\/www\.xvideos\.com\/new\/\d+$/);
  assert.ok(paging[0].label.length > 0);
});

test('extractPaging 的数字锚文本直接用，非数字的变成"第 N 页"', () => {
  const paging = extractPaging(PAGING, BASE);
  const two = paging.find((p) => p.url.endsWith('/new/1'));
  assert.ok(two, '夹具里有 /new/1');
  assert.equal(two.label, '2', '锚文本是数字就直接用（夹具里 /new/1 的锚文本是 2）');
  const nonNumeric = paging.find((p) => !/^\d+$/.test(p.label));
  if (nonNumeric) assert.match(nonNumeric.label, /第\s*\d+\s*页/);
});

test('extractPaging 对没有翻页的页面返回空数组（不猜）', () => {
  assert.deepEqual(extractPaging('<a href="/about">关于</a>', BASE), []);
  assert.deepEqual(extractPaging('', BASE), []);
});

test('extractPaging 不把视频链接当成翻页', () => {
  assert.deepEqual(extractPaging('<a href="/video.abc/1/1/x">标题</a>', BASE), []);
});

// ---------------------------------------------------------------- filterCandidates

test('filterCandidates：空关键字返回全部', () => {
  const items = [{ title: 'abc def' }, { title: 'ghi' }];
  assert.equal(filterCandidates(items, '').length, 2);
  assert.equal(filterCandidates(items, '   ').length, 2);
  assert.equal(filterCandidates(items, null).length, 2);
});

test('filterCandidates：空格分词 = AND，大小写不敏感', () => {
  const items = [{ title: 'Big Buck Bunny 60fps' }, { title: 'Big Buck Bunny' }, { title: 'bunny only' }];
  assert.equal(filterCandidates(items, 'big bunny').length, 2);
  assert.equal(filterCandidates(items, 'BIG BUNNY').length, 2);
  assert.equal(filterCandidates(items, 'big 60fps').length, 1);
});

test('filterCandidates：-词 是排除；单独的 "-" 不当作排除词', () => {
  const items = [{ title: 'cat video' }, { title: 'cat dog' }, { title: 'cat - dash' }];
  assert.equal(filterCandidates(items, 'cat -dog').length, 2);
  assert.equal(filterCandidates(items, 'cat -').length, 3, '单独的 - 应被忽略');
});

test('filterCandidates：标题为 null 时不崩', () => {
  assert.equal(filterCandidates([{ title: null }], 'x').length, 0);
  assert.equal(filterCandidates([{ title: null }], '').length, 1);
});

test('filterCandidates 不修改传入的数组', () => {
  const items = [{ title: 'a' }, { title: 'b' }];
  const out = filterCandidates(items, 'a');
  assert.equal(items.length, 2, '原数组不能被改');
  assert.notEqual(out, items, '应返回新数组');
});

// ---------------------------------------------------------------- sameVideo

test('sameVideo：优先比 site_video_id，其次比 URL', () => {
  assert.ok(sameVideo({ site_video_id: '1', url: 'a' }, { site_video_id: '1', url: 'b' }),
    '站内 id 相同即同一条，即使 URL 不同');
  assert.ok(!sameVideo({ site_video_id: '1', url: 'a' }, { site_video_id: '2', url: 'a' }),
    '站内 id 不同即不同条');
  assert.ok(sameVideo({ url: 'a' }, { url: 'a' }), '没有 id 时回退比 URL');
  assert.ok(!sameVideo({ url: 'a' }, { url: 'b' }));
  assert.ok(!sameVideo(null, { url: 'a' }));
});
