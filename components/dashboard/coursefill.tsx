"use client";

import { CourseFill, CourseFillCell, CourseFillRow, FILL_COLOR, fillStatus, shortCourses } from "@/lib/recruiting/coursefill";
import { HR_CATEGORY_LABEL, HrCategory } from "@/lib/recruiting/hrsheet";
import { POSTING_LABEL, PostingIndex } from "@/lib/recruiting/posting";
import { Fill, SortTh, sorted, useSort } from "./hrsheet";

/**
 * 校舎 × コースの応募と採用を1つの表にしたもの。
 *
 * 見たいのは「このコースは何名ほしくて、何名採れて、応募は来ているか」なので、
 * コースごとに 応募 / 採用 の2列を並べて置く。
 * 応募はジョブオプ、採用は採用チームのExcel。出どころが違うことは見出しの下に書く。
 *
 * 掲載ステータスを取り込んでいると、**有料で出している枠に色が付く**。
 * 同じ「応募0」でも、無料掲載なら当たり前、有料なら求人そのものを疑う話になるので、
 * 表の上で区別が付かないと打ち手を間違える。
 */

const cell = "px-2 py-1 text-xs tabular whitespace-nowrap";

/**
 * 有料掲載のマスの背景。
 *
 * 有料で応募が来ているぶんは「払っているだけの効果が出ている」ので薄い青、
 * 有料なのに応募0は手を打つ対象なので赤にする。無料と空欄には色を付けない
 * （色が付いているマスだけを見れば、お金が出ている枠が分かる状態にする）。
 */
const PAID_BG = "color-mix(in srgb, var(--series-1) 14%, transparent)";
const PAID_EMPTY_BG = "color-mix(in srgb, var(--status-critical) 16%, transparent)";
/**
 * 列幅。合計が表の幅より狭いぶんは、ブラウザが全列に均して配ってくれる。
 * 校舎名の列にだけ余りを寄せると、校舎名と最初の数字が離れて読みにくくなる。
 */
const SHOP_W = "7.5rem";
/** 応募は3桁まで */
const APPLIED_W = "4.25rem";
/** 採用は「0 / 1」と分母が付くので少し広く取る */
const HIRED_W = "5rem";

type Key = string;

interface Group {
  key: string;
  label: string;
  of: (row: CourseFillRow) => CourseFillCell;
}

export function CourseFillTable({ fill, posting = null }: { fill: CourseFill; posting?: PostingIndex | null }) {
  const sort = useSort<Key>();
  if (fill.rows.length === 0) return null;

  const groups: Group[] = [
    ...fill.courses.map((c) => ({
      key: c,
      label: HR_CATEGORY_LABEL[c],
      of: (r: CourseFillRow) => r.byCourse[c],
    })),
    // コースが分からないぶんの置き場。目標は置かないので、色を弱くしてコースの列と見分けが付くようにする。
    { key: "none", label: "コース不明", of: (r) => r.byCourse.none },
    { key: "total", label: "合計", of: (r) => r.total },
  ];

  const value = (r: CourseFillRow, key: Key): number | string => {
    if (key === "shop") return r.shopShortName;
    const [g, field] = key.split(":");
    const c = g === "total" ? r.total : r.byCourse[g as HrCategory];
    return field === "applied" ? c.applied : c.hired;
  };

  /** 0 は薄く出す。応募が来ていないコースを見つけるための表なので、0が目立つ必要がある。 */
  const Applied = ({ n, muted = false }: { n: number; muted?: boolean }) => (
    <span style={{ color: n > 0 ? (muted ? "var(--text-secondary)" : "var(--text-primary)") : "var(--text-muted)" }}>
      {n || "–"}
    </span>
  );

  /**
   * 採用の側。Excelを取り込んでいないときは 0 ではなく「不明」なので、
   * 「0 / 1」と書いて採れていないことにしてしまわないようにする。
   */
  const Hired = ({ c, muted = false }: { c: CourseFillCell; muted?: boolean }) => {
    if (!fill.hasHires) {
      return <span style={{ color: "var(--text-muted)" }}>–{c.target ? ` / ${c.target}` : ""}</span>;
    }
    if (muted) {
      return (
        <span style={{ color: c.hired > 0 ? "var(--text-secondary)" : "var(--text-muted)" }}>{c.hired || "–"}</span>
      );
    }
    return <Fill actual={c.hired} target={c.target} />;
  };

  const groupBorder = { borderLeft: "1px solid var(--gridline)" };

  /**
   * 合計の「採用 / 目標」。人数が足りていても、埋まっていないコースがあれば緑にしない。
   * ここを人数だけで緑にすると、CADが空のままの校舎が「3 / 3」で充足して見える。
   */
  const Total = ({ r }: { r: CourseFillRow }) => {
    const c = r.total;
    if (!fill.hasHires) {
      return <span style={{ color: "var(--text-muted)" }}>–{c.target ? ` / ${c.target}` : ""}</span>;
    }
    const status = fillStatus(r);
    const short = shortCourses(r);
    return (
      <span title={short.length > 0 ? `${short.map((x) => HR_CATEGORY_LABEL[x]).join("・")} が埋まっていません` : undefined}>
        <span style={{ color: FILL_COLOR[status], fontWeight: 600 }}>{c.hired}</span>
        {c.target !== null && <span style={{ color: "var(--text-muted)" }}> / {c.target}</span>}
      </span>
    );
  };

  const bodyCells = (r: CourseFillRow, emphasize: boolean) =>
    groups.flatMap((g) => {
      const c = g.of(r);
      // 掲載ステータスは校舎 × コースに付くので、合計の列と合計行には色を付けない
      const post = posting && g.key !== "total" && r.key !== "(合計)" ? posting.at(r.key, g.key as HrCategory) : null;
      const paid = post?.state === "paid";
      const background = paid ? (c.applied === 0 ? PAID_EMPTY_BG : PAID_BG) : undefined;
      const note = post
        ? `${POSTING_LABEL[post.state]}掲載中${
            post.columns.length > 0
              ? `（${post.columns.map((x) => `${x.label}: ${POSTING_LABEL[x.state]}`).join(" / ")}）`
              : ""
          }${paid && c.applied === 0 ? " ／ 応募0。求人の内容を見直す対象です。" : ""}`
        : undefined;

      return [
        <td
          key={`${g.key}:applied`}
          className={`${cell} text-center`}
          style={{ ...groupBorder, background }}
          title={note}
        >
          <Applied n={c.applied} muted={g.key === "none"} />
        </td>,
        <td
          key={`${g.key}:hired`}
          className={`${cell} text-center`}
          style={{ fontWeight: (emphasize || g.key === "total") && g.key !== "none" ? 600 : 400, background }}
          title={note}
        >
          {g.key === "total" ? <Total r={r} /> : <Hired c={c} muted={g.key === "none"} />}
        </td>,
      ];
    });

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: SHOP_W }} />
          {groups.flatMap((g) => [
            <col key={`${g.key}:a`} style={{ width: APPLIED_W }} />,
            <col key={`${g.key}:h`} style={{ width: HIRED_W }} />,
          ])}
        </colgroup>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--hairline)" }}>
            <SortTh sortKey="shop" state={sort} align="left" rowSpan={2} sticky>
              校舎
            </SortTh>
            {groups.map((g) => (
              <th
                key={g.key}
                colSpan={2}
                scope="colgroup"
                className="px-2 pb-0.5 pt-1.5 text-center text-[11px] font-semibold whitespace-nowrap"
                style={{
                  ...groupBorder,
                  color: g.key === "total" || g.key === "none" ? "var(--text-secondary)" : "var(--text-primary)",
                  fontWeight: g.key === "none" ? 400 : 600,
                }}
              >
                {g.label}
              </th>
            ))}
          </tr>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            {groups.flatMap((g) => [
              <SortTh key={`${g.key}:applied`} sortKey={`${g.key}:applied`} state={sort} align="center" groupStart>
                応募
              </SortTh>,
              <SortTh key={`${g.key}:hired`} sortKey={`${g.key}:hired`} state={sort} align="center">
                採用
              </SortTh>,
            ])}
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <td
              className={`${cell} sticky left-0 z-10 font-semibold`}
              style={{ color: "var(--text-primary)", background: "var(--surface-1)" }}
            >
              合計
            </td>
            {bodyCells(fill.totalRow, true)}
          </tr>
          {sorted(fill.rows, sort, value).map((r) => (
            <tr key={r.key} style={{ borderBottom: "1px solid var(--hairline)" }}>
              <td
                className={`${cell} sticky left-0 z-10`}
                style={{ color: "var(--text-primary)", background: "var(--surface-1)" }}
              >
                {r.shopShortName}
              </td>
              {bodyCells(r, false)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
