// 许愿池的卡片（卡片 JSON 2.0 + 卡片实体，因为发出去之后票数还要能变）。
//
// 组件分工（element_id 是局部更新的抓手，投票后只刷那一行，不整卡重绘）：
//   wish_row_<wishId> —— 榜单里的一行：名字 + 用户原话 + 投票按钮
// 表单只出现在"我要许愿"那张独立卡片里，所以刷新票数永远不会打断正在填的表单。

import { WISH_STATUS } from "./wishes.js";

const text = (content) => ({ tag: "plain_text", content });
const md = (content) => ({ tag: "markdown", content });
const callback = (action, value = {}) => [{ type: "callback", value: { action, ...value } }];
const options = (list) => list.map((v) => ({ text: text(v), value: v }));
const column = (elements) => ({ tag: "column", elements });

const DISCLAIMER = "_许愿池是需求表达，票数不代表一定会上市——上不上新由产品团队决定。_";

// 飞书对组件 id 有硬限制：只能字母数字下划线、字母开头、且不超过 20 个字符。
// 直接用 wish_1786776622007 这种 id 拼出来会超长（线上实测报 1002 错误），所以压成短哈希。
function shortHash(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  return hash.toString(36).slice(0, 7);
}

export function rowElementId(wishId) {
  return `w_${shortHash(String(wishId))}`;
}

function truncate(value, len = 34) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

// 匿名是提交时就定好的，展示层不许"猜"——用户选了匿名就不能在任何地方泄露是谁许的愿。
function authorOf(quote) {
  return quote?.anonymous ? "匿名同事" : quote?.userName ?? "同事";
}

export function wishQuoteLine(wish) {
  const quotes = wish.quotes ?? [];
  // 挑"最完整的那条原话"：历史流水里同一个人可能在同一轮里留下"2""3"这种碎片回复，
  // 直接拿第一条会显示成「我想喝火龙果饮料；2；3；这个有上新机会吗」，很出戏。
  const pick = (text) => {
    const parts = String(text ?? "")
      .split(/[；;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length <= 1) return String(text ?? "").trim();
    return parts.reduce((best, cur) => (cur.length > best.length ? cur : best));
  };
  const q = quotes.find((x) => pick(x.text).length >= 6) ?? quotes[0];
  if (!q) return "";
  // 按人头算，不按条数算：同一个人先后留了两条原话，不能写成"另有 2 人"。
  const others = new Set(quotes.filter((x) => x.userId !== q.userId).map((x) => x.userId)).size;
  const suffix = others > 0 ? `（另有 ${others} 人许过相似的愿）` : "";
  return `「${truncate(pick(q.text))}」—— ${authorOf(q)}${suffix}`;
}

/** 榜单里的一行。投票后由 server 用同一个 element_id 局部替换掉它。 */
export function wishRowElement(wish) {
  return {
    tag: "column_set",
    element_id: rowElementId(wish.id),
    flex_mode: "none",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 5,
        elements: [md(`**${wish.name}**\n_${wishQuoteLine(wish)}_`)],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 2,
        elements: [
          {
            tag: "button",
            type: "default",
            width: "fill",
            text: text(`+1 · ${wish.votes?.length ?? 0} 人`),
            behaviors: callback("wish_vote", { wish_id: wish.id }),
          },
        ],
      },
    ],
  };
}

function myWishesBlock(myWishes = []) {
  if (myWishes.length === 0) return null;
  const lines = myWishes
    .slice(0, 5)
    .map((w) => `· **${w.name}** · ${WISH_STATUS[w.status] ?? w.status} · ${w.votes?.length ?? 0} 人想要`);
  return md(`**我的愿望**\n${lines.join("\n")}`);
}

export function buildWishPoolCard({ wishes, myWishes = [], stats, period }) {
  const top = wishes.slice(0, 3);
  const elements = [
    md(`**${period}** · 本期 **${stats.total}** 个愿望 · **${stats.candidate}** 个进入候选`),
    { tag: "hr" },
  ];

  if (top.length === 0) {
    elements.push(md("_还没有人许愿。第一个说出来的愿望，很可能就是下一个上新的口味。_"));
  } else {
    elements.push(md("🔥 **本期热门**"));
    for (const wish of top) elements.push(wishRowElement(wish));
  }

  const mine = myWishesBlock(myWishes);
  if (mine) elements.push({ tag: "hr" }, mine);

  elements.push(
    { tag: "hr" },
    {
      tag: "column_set",
      flex_mode: "bisect",
      columns: [
        column([{ tag: "button", type: "primary", width: "fill", text: text("我要许愿"), behaviors: callback("wish_open_form") }]),
        column([{ tag: "button", type: "default", width: "fill", text: text("看全部"), behaviors: callback("wish_list") }]),
      ],
    },
    md(DISCLAIMER)
  );

  return {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true, enable_forward: true },
    header: { template: "orange", title: text("LuckyDay · 咖啡许愿池"), subtitle: text("想喝什么菜单上没有的，说出来") },
    body: { padding: "12px 12px 12px 12px", elements },
  };
}

export function buildWishListCard({ wishes, stats, period }) {
  const shown = wishes.slice(0, 10);
  const elements = [md(`**${period}** · 共 ${stats.total} 个愿望，先看前 ${shown.length} 个`)];
  for (const wish of shown) elements.push(wishRowElement(wish));
  if (stats.total > shown.length) elements.push(md(`_还有 ${stats.total - shown.length} 个排在后面，下次再给你看。_`));

  return {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true, enable_forward: true },
    header: { template: "orange", title: text("LuckyDay · 许愿池全部愿望") },
    body: { padding: "12px 12px 12px 12px", elements: [...elements, { tag: "hr" }, md(DISCLAIMER)] },
  };
}

// 许愿填写区：单独一张卡，不和榜单卡挤在一起——整卡重绘会清空别人正在填的内容。
export function buildWishFormCard() {
  return {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true, enable_forward: false },
    header: { template: "orange", title: text("LuckyDay · 我想要一杯现在没有的") },
    body: {
      padding: "12px 12px 12px 12px",
      elements: [
        md("说说你想喝什么。写得越具体，越容易和别人的愿望聚到一起，也越容易真的被做出来。"),
        {
          tag: "form",
          name: "wish_form",
          elements: [
            { tag: "input", name: "text", placeholder: text("例：葡萄味明显但别太甜，要有气泡感的冰咖啡") },
            {
              tag: "multi_select_static",
              name: "flavor",
              placeholder: text("风味（可多选）"),
              options: options(["果香", "奶香", "茶感", "咖啡感", "气泡", "清爽"]),
            },
            {
              tag: "column_set",
              flex_mode: "flow",
              columns: [
                column([{ tag: "select_static", name: "sweetness", placeholder: text("甜度"), options: options(["不加糖", "少甜", "标准甜"]) }]),
                column([{ tag: "select_static", name: "temperature", placeholder: text("温度"), options: options(["冰", "少冰", "去冰", "热"]) }]),
                column([{ tag: "select_static", name: "sign", placeholder: text("署名（默认实名）"), options: options(["实名", "匿名"]) }]),
              ],
            },
            {
              tag: "button",
              name: "submit",
              type: "primary",
              width: "fill",
              text: text("提交愿望"),
              action_type: "form_submit",
              value: { action: "wish_submit" },
            },
          ],
        },
        md(DISCLAIMER),
      ],
    },
  };
}

/** 提交后把填写卡原地换成这张，用户马上能看到"我的愿望现在排第几"。 */
export function buildWishDoneCard({ wish, rank, total, merged }) {
  const quote = wish.quotes?.[wish.quotes.length - 1];
  return {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true, enable_forward: true },
    header: {
      template: "green",
      title: text(merged ? "已经并进一个相似的愿望" : "已经放进许愿池"),
      subtitle: text(merged ? "说明不止你一个人想喝这个" : `本期第 ${rank ?? "-"} 名`),
    },
    body: {
      padding: "12px 12px 12px 12px",
      elements: [
        md(`**${wish.name}**\n「${truncate(quote?.text, 60)}」—— ${quote?.anonymous ? "匿名同事" : quote?.userName ?? "你"}`),
        { tag: "hr" },
        md(
          `现在 **${wish.votes?.length ?? 0}** 人想要 · 本期第 **${rank ?? "-"}** 名（共 ${total} 个愿望）\n` +
            (merged ? "你的原话也被完整保留在这条愿望下面。" : "想让它更快被看到？拉同事点一下 +1。")
        ),
        {
          tag: "button",
          type: "primary",
          width: "fill",
          text: text("我也想要 +1"),
          behaviors: callback("wish_vote", { wish_id: wish.id }),
        },
        { tag: "hr" },
        md(DISCLAIMER),
      ],
    },
  };
}

/** 形态 D：状态被人工推进时，@原创者推这条。整个功能里最有传播力的一张卡。 */
export function buildWishStatusCard({ wish, previous, note, mentionOpenIds = [] }) {
  const at = mentionOpenIds.map((id) => `<at id=${id}></at>`).join(" ");
  const statusText = WISH_STATUS[wish.status] ?? wish.status;
  const from = WISH_STATUS[previous] ?? previous ?? "已入池";
  const launched = wish.status === "launched";

  return {
    schema: "2.0",
    config: { width_mode: "fill", enable_forward: true },
    header: {
      template: launched ? "green" : wish.status === "rejected" ? "grey" : "blue",
      title: text(launched ? "你许的愿上新了" : `愿望状态更新：${statusText}`),
      subtitle: text(wish.name),
    },
    body: {
      padding: "12px 12px 12px 12px",
      elements: [
        md(`${at} 你许的那个愿望有新进展了。`.trim()),
        { tag: "hr" },
        md(`**${wish.name}**\n${wishQuoteLine(wish)}\n\n状态：~~${from}~~ → **${statusText}**${note ? `\n说明：${note}` : ""}`),
        { tag: "hr" },
        md(
          launched
            ? "去菜单里就能点到了，谢谢你当初说出来。"
            : "_状态变化只是记录评估进展，不代表一定会上市；有结论我都会来告诉你。_"
        ),
      ],
    },
  };
}
